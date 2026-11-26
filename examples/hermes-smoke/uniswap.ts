// Uniswap v3 + v4 inside the Hermes VM (UNISWAP-V4-RESEARCH §5.7): the provider's whole getQuote path over the recorded
// Monad answers at block 125,409,523 (v3 alone, and v3 ranked with v4 native-in), both quotes checked by the shipped pins;
// the wrong-layout refusal; the PoolId keccak of Monad NATIVE/AUSD 500/1; a wrapped NotEnoughLiquidity; the impact and
// gas arithmetic on values above 2^53 (core bigintToNumber); the v4 activity row. Synthetic transport only.
import {encodeAbiParameters, encodeErrorResult, getAddress, parseAbi, type Hex} from 'viem'
import {bigintToNumber} from '@anywalletkit/core'
import {parseActivityFixture, type ActivityFixtureJson} from '@anywalletkit/conformance'
import {uniswapProvider} from '@anywalletkit/protocol-swap2-uniswap/provider'
import {UNISWAP_V3, UNISWAP_V4, describeUniswapActivity, uniswapPins, uniswapVerifyQuote, poolIdOf} from '@anywalletkit/protocol-swap2-uniswap'
import {classifyV4QuoteRevert, decodeV4SwapCall, notEnoughLiquidityPoolId, v4SpotLossBps, type V4Route} from '@anywalletkit/protocol-swap2-uniswap/v4'
import v3Recording from '../../packages/protocol-swap2-uniswap/fixtures/rpc/monad-125409523.json'
import v4Recording from '../../packages/protocol-swap2-uniswap/fixtures/rpc/monad-125409523-v4.json'
import e1 from '../../packages/protocol-swap2-uniswap/fixtures/v4/monad-e1.json'
import v4Activity from '../../packages/protocol-swap2-uniswap/fixtures/activity/unichain-v4-native-in.json'

type Check = (what: string, ok: boolean, detail?: string) => void
const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a'
const NATIVE = '0x0000000000000000000000000000000000000000'
const ME = '0x1111111111111111111111111111111111111111'
const CALLS = {...(v3Recording as {calls: Record<string, object>}).calls, ...(v4Recording as {calls: Record<string, object>}).calls}

/** A JSON-RPC node answering from the recordings (keys: method, target, calldata); a miss is an error, never a guess. */
function recordedNode() {
  const misses: string[] = []
  const f = async (_url: unknown, init?: {body?: unknown}) => {
    const batch = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]}[]
    const body = batch.map((req) => {
      let key = req.method
      if (req.method === 'eth_call') {
        const c = req.params[0] as {to: string; data: string}
        key = `eth_call ${c.to.toLowerCase()} ${c.data.toLowerCase()}`
      } else if (req.method === 'eth_getCode') key = `eth_getCode ${String(req.params[0]).toLowerCase()}`
      const a = (CALLS as Record<string, object>)[key]
      if (!a) misses.push(key.slice(0, 60))
      return {jsonrpc: '2.0', id: req.id, ...(a ?? {error: {code: -32603, message: 'not in the recording'}})}
    })
    return {ok: true, status: 200, headers: {get: () => null}, json: async () => body}
  }
  return {f, misses}
}

export async function smokeUniswap(check: Check): Promise<void> {
  const g = globalThis as {fetch?: unknown}
  const offline = g.fetch
  const params = {sourceChain: 'eip155:143', destChain: 'eip155:143', sourceToken: 'MON', destToken: AUSD, amountIn: (62_000n * 10n ** 18n).toString(), destAddress: ME, refundAddress: ME}
  try {
    const node = recordedNode()
    g.fetch = node.f
    const v3 = await uniswapProvider({rpcUrls: {143: ['https://monad.fixture']}}).getQuote(params)
    check('uniswap: v3 quote from the recording (62,000 MON → 1.130999 AUSD, gasLimit 16,303,291)', v3?.destAmount === '1130999' && v3.txRequest?.gasLimit === '16303291' && v3.txRequest?.to === UNISWAP_V3[143]!.router, `${v3?.destAmount} ${v3?.txRequest?.gasLimit} misses ${node.misses.join(',')}`)
    check('uniswap: the v3 quote passes the shipped pins', !!v3 && uniswapVerifyQuote(params, v3) === null, v3 ? uniswapVerifyQuote(params, v3) ?? '' : 'no quote')
    const v4 = await uniswapProvider({rpcUrls: {143: ['https://monad.fixture']}, v4: 'native-in', maxPriceImpactBps: 500}).getQuote(params)
    check('uniswap: v4 native-in wins (676.608109 AUSD via USDC, G = 23) and passes the 500 gate', v4?.destAmount === '676608109' && v4.providerData?.venue === 'v4' && v4.providerData?.valueLossBps === '23' && v4.txRequest?.to === UNISWAP_V4[143]!.universalRouter, `${v4?.destAmount} ${JSON.stringify(v4?.providerData ?? null).slice(0, 160)} misses ${node.misses.join(',')}`)
    const pins = v4 ? uniswapVerifyQuote(params, v4) : 'no quote'
    check('uniswap: the v4 quote passes the shipped pins (strict decode, canonical re-encode, pinned pools)', pins === null && uniswapPins.callTargets('eip155:143').includes(UNISWAP_V4[143]!.universalRouter), pins ?? '')
  } finally {
    g.fetch = offline
  }

  // The 2.0 layout executes on chain but is refused here; the 2.1.x one decodes.
  const wrong = decodeV4SwapCall(e1.calldata_2_0)
  const right = decodeV4SwapCall(e1.calldata_2_1_x)
  check('uniswap: the UR 2.0 layout is refused by the strict decoder, the 2.1.x one decodes', !wrong.ok && right.ok && right.swap.amountIn === BigInt(e1.amountIn), wrong.ok ? 'accepted' : wrong.text)
  // PoolId keccak (Monad NATIVE/AUSD 500/1, 0xadaf3077…d8219).
  const id = poolIdOf({currency0: NATIVE, currency1: getAddress(AUSD), fee: 500, tickSpacing: 1, hooks: NATIVE})
  check('uniswap: PoolId of Monad NATIVE/AUSD 500/1', id.toLowerCase() === e1.poolId.toLowerCase() && id.startsWith('0xadaf3077'), id)
  // A partial fill, wrapped by the quoter.
  const errs = parseAbi(['error NotEnoughLiquidity(bytes32 poolId)', 'error UnexpectedRevertBytes(bytes revertData)'])
  const inner = encodeErrorResult({abi: errs, errorName: 'NotEnoughLiquidity', args: [id]})
  const wrapped = encodeErrorResult({abi: errs, errorName: 'UnexpectedRevertBytes', args: [inner]})
  check('uniswap: a wrapped NotEnoughLiquidity is a partial fill naming its pool', classifyV4QuoteRevert(wrapped).kind === 'partial' && notEnoughLiquidityPoolId(wrapped) === id.toLowerCase())
  // Impact arithmetic past 2^53: a 1e30-wei input at a price of 1 that pays 99% of mid loses 100 bps.
  const pool = {key: {currency0: NATIVE as Hex, currency1: getAddress(AUSD), fee: 500, tickSpacing: 1, hooks: NATIVE as Hex}, id, state: {sqrtPriceX96: 1n << 96n, tick: 0, protocolFee: 0, lpFee: 500, liquidity: 1n}, source: 'listed' as const}
  const route: V4Route = {currencyIn: NATIVE, currencyOut: getAddress(AUSD), hops: [{pool, zeroForOne: true, currencyIn: NATIVE, currencyOut: getAddress(AUSD)}], label: '', poolFee: ''}
  const big = 10n ** 30n
  check('uniswap: spot value loss on amounts above 2^53 (core bigintToNumber)', v4SpotLossBps(route, big, (big * 99n) / 100n) === 100 && bigintToNumber(2n ** 60n) === 1152921504606846976)
  // The v4 activity row.
  const fx = parseActivityFixture(v4Activity as unknown as ActivityFixtureJson)
  const item = describeUniswapActivity(fx.tx, {own: fx.own})
  check('uniswap: a recorded V4_SWAP is "Uniswap v4 · Unichain"', item?.subtitle === 'Uniswap v4 · Unichain' && item.kind === 'swap', item?.subtitle ?? 'null')
  check('uniswap: the encoder words are ABI words', encodeAbiParameters([{type: 'uint128'}], [2n ** 127n]).length === 66)
}
