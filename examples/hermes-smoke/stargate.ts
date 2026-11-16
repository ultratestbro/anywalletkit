import {StargateSwap2Protocol, stargateRegistry} from '@anywalletkit/protocol-swap2-stargate'
import {splitSourceAmount, destinationAmount, sourceMinimum} from '@anywalletkit/protocol-swap2-stargate/amounts'
import {stargateTaxiProof, stargateTaxiPayout, checkStargateReceipt} from '@anywalletkit/protocol-swap2-stargate/tracking'
import {TOKEN_MESSAGING_ABI, EXECUTOR_ABI} from '@anywalletkit/protocol-swap2-stargate/abi'
import {createLayerZeroDiscovery} from '@anywalletkit/protocol-swap2-layerzero'
import {decodeEventLog, encodeAbiParameters, parseEventLogs, toEventSelector, type TransactionReceipt, type Hex} from 'viem'
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

  const fetchImpl: typeof fetch = async () => ({ok: true, status: 200, headers: {get: () => null}, text: async () => JSON.stringify({tokens: [], pagination: {nextToken: 'next'}})} as unknown as Response)
  const discovery = await createLayerZeroDiscovery({fetchImpl}).tokens({from: {chainKey: 'base', tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'}})
  check('layerzero: public discovery without Node/server key', discovery.items.length === 0 && discovery.nextToken === 'next')
}
