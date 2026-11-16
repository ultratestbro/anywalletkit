import {StargateSwap2Protocol, stargateRegistry} from '@anywalletkit/protocol-swap2-stargate'
import {splitSourceAmount, destinationAmount, sourceMinimum} from '@anywalletkit/protocol-swap2-stargate/amounts'
import {stargateTaxiProof, stargateTaxiPayout, checkStargateReceipt} from '@anywalletkit/protocol-swap2-stargate/tracking'
import {TOKEN_MESSAGING_ABI, EXECUTOR_ABI} from '@anywalletkit/protocol-swap2-stargate/abi'
import {createLayerZeroDiscovery} from '@anywalletkit/protocol-swap2-layerzero'
import {createPublicClient, custom, decodeEventLog, encodeAbiParameters, parseEventLogs, toHex, toEventSelector, type TransactionReceipt, type Hex} from 'viem'
import {proveLifiStargateCompose, lifiStargateComposeOutcome, stargateComposeQueueState, type StargateComposeExpectation} from '@anywalletkit/protocol-swap2-stargate/compose'
import {COMPOSE_DEX_PINS, validateLifiUnoswap2Compose} from '@anywalletkit/protocol-swap2-stargate/compose-dex'
import {LIFI_ETHEREUM_COMPOSER} from '@anywalletkit/protocol-swap2-stargate/compose'
import composeRecorded from '../../packages/protocol-swap2-stargate/tests/fixtures/compose.json'
import recorded from '../../packages/protocol-swap2-stargate/tests/fixtures/recovery.json'

/** Production exports in the actual VM, with recorded receipts and synthetic transport only. */
export async function smokeStargate(check: (what: string, ok: boolean, detail?: string) => void) {
  const amount = (1n << 65n) + 12345n
  const parts = splitSourceAmount(amount, 18, 6)
  check('stargate: bigint dust above 2^64', parts.sentLD + parts.dustLD === amount && parts.amountSD * 10n ** 12n === parts.sentLD)
  check('stargate: output decimals and ceiling minimum', destinationAmount(10n ** 18n, 18, 6, 6) === 1000000n && sourceMinimum(1000000000001n, 6, 18, 6) === 2n)
  const ticketId = (1n << 65n) + 7n
  const guid = `0x${'ab'.repeat(32)}` as Hex
  const decoded = decodeEventLog({abi: TOKEN_MESSAGING_ABI, eventName: 'BusDriven', topics: [toEventSelector('BusDriven(uint32,uint72,uint8,bytes32)')], data: encodeAbiParameters([{type: 'uint32'}, {type: 'uint72'}, {type: 'uint8'}, {type: 'bytes32'}], [30110, ticketId, 2, guid])})
  check('stargate: uint72 Bus ticket', decoded.args.startTicketId === ticketId)

  const entry = recorded.cases[0]!
  const source = stargateRegistry.deployments.find((d) => d.chain === entry.source.chain && d.assetId === entry.assetId)!
  const destination = stargateRegistry.deployments.find((d) => d.chain === entry.destination.chain && d.assetId === entry.assetId)!
  const parsed = (r: typeof entry.source.receipt): TransactionReceipt => ({...r, blockNumber: BigInt(r.blockNumber), logs: r.logs.map((l) => ({...l, blockNumber: BigInt(l.blockNumber)}))} as unknown as TransactionReceipt)
  const src = parsed(entry.source.receipt), cached = parsed(entry.destination.receipt), recovered = parsed(entry.recovery!.receipt)
  checkStargateReceipt(src, entry.source.transaction.hash as Hex, entry.source.block.hash as Hex)
  const intent = {...entry.intent, mode: 'taxi' as const, source, destination, sender: entry.intent.sender as Hex, recipient: entry.intent.recipient as Hex, amount: BigInt(entry.intent.amount), minimum: BigInt(entry.intent.minimum), nativeDrop: BigInt(entry.intent.nativeDrop)}
  const proof = stargateTaxiProof(intent, src)
  check('stargate: recorded cached-token recovery proof', !stargateTaxiPayout(proof, cached) && stargateTaxiPayout(proof, recovered))
  const dropCase = recorded.cases[1]!
  const [drop] = parseEventLogs({abi: EXECUTOR_ABI, eventName: 'NativeDropApplied', logs: parsed(dropCase.drop!.receipt).logs, strict: true})
  check('stargate: recorded native-drop tuple arrays', !!drop && drop.args.origin.nonce === 47276n && drop.args.success[0] === true && drop.args.params[0]?.amount === BigInt(dropCase.intent.nativeDrop))
  const protocol = new StargateSwap2Protocol(undefined, {fromChain: source.chain, enabled: true, rpcUrls: {[source.chain]: 'https://source.test', [destination.chain]: 'https://destination.test'}})
  check('stargate: standalone construction and chain discovery', (await protocol.getSupportedChains()).some((c) => String(c.id) === source.chain))

  for (const c of composeRecorded.cases) {
    const expected = {...c.expected, minimum: BigInt(c.expected.minimum), bridge: {...c.expected.bridge, amount: BigInt(c.expected.bridge.amount), minimum: BigInt(c.expected.bridge.minimum), nativeDrop: BigInt(c.expected.bridge.nativeDrop)}} as unknown as StargateComposeExpectation
    const proof = proveLifiStargateCompose(expected, parsed(c.source.receipt), parsed(c.delivery.receipt), c.code as {receiver: Hex; executor: Hex})
    check(`stargate: compose ${c.outcome.state}`, lifiStargateComposeOutcome(proof, parsed(c.execution.receipt)).state === c.outcome.state && !proof.executionSupported)
    const queues = c.calls.filter((call) => call.functionName === 'composeQueue')
    check('stargate: consumed compose cannot replay', stargateComposeQueueState(proof.messageHash, queues[0]!.result as Hex) === 'pending' && stargateComposeQueueState(proof.messageHash, queues[1]!.result as Hex) === 'consumed')
    if (c.dexEvidence) {
      const code = new Map([
        [COMPOSE_DEX_PINS.router.toLowerCase(), c.dexEvidence.code.router],
        [COMPOSE_DEX_PINS.factory.toLowerCase(), c.dexEvidence.code.factory],
        [LIFI_ETHEREUM_COMPOSER.receiver.toLowerCase(), c.code.receiver],
        [LIFI_ETHEREUM_COMPOSER.executor.toLowerCase(), c.code.executor],
      ])
      const at = BigInt(c.execution.block.number)
      const client = createPublicClient({transport: custom({request: async ({method, params}) => {
        const args = params as unknown[]
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getBlockByNumber') {
          if (args[0] !== toHex(at)) throw new Error('unexpected compose block')
          return {number: toHex(at), hash: c.execution.block.hash, transactions: []}
        }
        if (args[1] !== toHex(at)) throw new Error('unexpected compose state block')
        if (method === 'eth_getCode') return code.get(String(args[0]).toLowerCase())
        if (method === 'eth_call') {
          const call = args[0] as {to: string; data: Hex}
          const found = c.calls.find((r) => r.to.toLowerCase() === call.to.toLowerCase() && r.data === call.data && BigInt(r.blockNumber) === at)
          if (found) return found.result
        }
        throw new Error('unrecorded compose RPC call')
      }}, {retryCount: 0})})
      const validated = await validateLifiUnoswap2Compose(proof, client, at)
      check('stargate: compose DEX bigint flags, minimum and canonical pools', validated.minimum === expected.minimum && validated.pools.length === 2 && !validated.executionSupported)
    }
  }

  const fetchImpl: typeof fetch = async () => ({ok: true, status: 200, headers: {get: () => null}, text: async () => JSON.stringify({tokens: [], pagination: {nextToken: 'next'}})} as unknown as Response)
  const discovery = await createLayerZeroDiscovery({fetchImpl}).tokens({from: {chainKey: 'base', tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'}})
  check('layerzero: public discovery without Node/server key', discovery.items.length === 0 && discovery.nextToken === 'next')
}
