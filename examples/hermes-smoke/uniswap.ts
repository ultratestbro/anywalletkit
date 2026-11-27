// Uniswap v3 + v4 inside the Hermes VM (UNISWAP-V4-RESEARCH §5.7): the provider's whole getQuote path over the recorded
// Monad answers at block 125,409,523 (v3 alone, and v3 ranked with v4 native-in), both quotes checked by the shipped pins;
// the wrong-layout refusal; the PoolId keccak of Monad NATIVE/AUSD 500/1; a wrapped NotEnoughLiquidity; the impact and
// gas arithmetic on values above 2^53 (core bigintToNumber); the v4 activity row. U2, the SwapProxy branch: a token input
// over the recorded Monad answers at block 125,499,326 with v4 "all" — the approve + swap check down Monad's fallback
// (eth_simulateV1 not served → the allowance slot from the access list, set by stateDiff) — the SwapProxy call decoded
// strictly and accepted by the shipped pins, and a recorded SwapProxy swap's activity row. venueRoutes "both": v3 and v4 as
// two candidates over the same recording, each bound to its venue by the pins. Synthetic transport only.
import {encodeAbiParameters, encodeErrorResult, getAddress, parseAbi, type Hex} from 'viem'
import {bigintToNumber} from '@anywalletkit/core'
import {parseActivityFixture, type ActivityFixtureJson} from '@anywalletkit/conformance'
import {uniswapProvider} from '@anywalletkit/protocol-swap2-uniswap/provider'
import {UNISWAP_V3, UNISWAP_V4, describeUniswapActivity, uniswapPins, uniswapPinsWith, uniswapRemoteProvider, uniswapVerifyQuote, poolIdOf} from '@anywalletkit/protocol-swap2-uniswap'
import {classifyV4QuoteRevert, decodeV4SwapCall, notEnoughLiquidityPoolId, v4SpotLossBps, type V4Route} from '@anywalletkit/protocol-swap2-uniswap/v4'
import v3Recording from '../../packages/protocol-swap2-uniswap/fixtures/rpc/monad-125409523.json'
import v4Recording from '../../packages/protocol-swap2-uniswap/fixtures/rpc/monad-125409523-v4.json'
import e1 from '../../packages/protocol-swap2-uniswap/fixtures/v4/monad-e1.json'
import v4Activity from '../../packages/protocol-swap2-uniswap/fixtures/activity/unichain-v4-native-in.json'
import tokenRecording from '../../packages/protocol-swap2-uniswap/fixtures/rpc/monad-125499326-token.json'
import live1Recording from '../../packages/protocol-swap2-uniswap/fixtures/rpc/monad-125520066-live1.json'
import proxyActivity from '../../packages/protocol-swap2-uniswap/fixtures/activity/ethereum-v4-swapproxy-a.json'

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

/** The token recording's key: method + params without the block tag, lower-cased, the SwapProxy deadline word zeroed. */
const TAGGED: Record<string, number> = {eth_call: 1, eth_getCode: 1, eth_createAccessList: 1, eth_simulateV1: 1, eth_estimateGas: 1, eth_getBalance: 1}
function tokenKey(method: string, params: unknown[]): string {
  const p = [...params]
  const at = TAGGED[method]
  if (at !== undefined && typeof p[at] === 'string') p.splice(at, 1)
  if (method === 'eth_getBlockByNumber') p.splice(0, 1)
  return `${method} ${JSON.stringify(p).toLowerCase().replace(/2894adf9((?:[0-9a-f]{64}){5})[0-9a-f]{64}/g, (_m, g: string) => `2894adf9${g}${'0'.repeat(64)}`)}`
}
function tokenNode() {
  const calls = (tokenRecording as {calls: Record<string, object>}).calls
  const misses: string[] = []
  const methods: string[] = []
  const f = async (_url: unknown, init?: {body?: unknown}) => {
    const batch = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]}[]
    const body = batch.map((req) => {
      methods.push(req.method)
      const a = calls[tokenKey(req.method, req.params)]
      if (!a) misses.push(`${req.method} ${JSON.stringify(req.params).slice(0, 60)}`)
      return {jsonrpc: '2.0', id: req.id, ...(a ?? {error: {code: -32603, message: 'not in the recording'}})}
    })
    return {ok: true, status: 200, headers: {get: () => null}, json: async () => body}
  }
  return {f, misses, methods}
}

/** The LIVE-1 recording's node (keys: method, target, calldata and the gas named — the re-reads at the cap name 30M). */
function live1Node() {
  const calls = (live1Recording as {calls: Record<string, object>}).calls
  const misses: string[] = []
  const f = async (_url: unknown, init?: {body?: unknown}) => {
    const batch = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]}[]
    const body = batch.map((req) => {
      let key = req.method
      if (req.method === 'eth_call') {
        const c = req.params[0] as {to: string; data: string; gas?: string}
        key = `eth_call ${c.to.toLowerCase()} ${c.data.toLowerCase()}${c.gas ? ` gas=${BigInt(c.gas).toString()}` : ''}`
      } else if (req.method === 'eth_getCode') key = `eth_getCode ${String(req.params[0]).toLowerCase()}`
      const a = calls[key]
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
    check('uniswap: v4 native-in wins (676.608109 AUSD via USDC, G = 22) and passes the 500 gate', v4?.destAmount === '676608109' && v4.providerData?.venue === 'v4' && v4.providerData?.valueLossBps === '22' && v4.txRequest?.to === UNISWAP_V4[143]!.universalRouter, `${v4?.destAmount} ${JSON.stringify(v4?.providerData ?? null).slice(0, 160)} misses ${node.misses.join(',')}`)
    const pins = v4 ? uniswapVerifyQuote(params, v4) : 'no quote'
    check('uniswap: the v4 quote passes the shipped pins (strict decode, canonical re-encode, pinned pools)', pins === null && uniswapPins.callTargets('eip155:143').includes(UNISWAP_V4[143]!.universalRouter), pins ?? '')

    // venueRoutes "both": Uniswap v3 and v4 as two candidates of one pass, each bound to its venue by the pins.
    const both = uniswapProvider({rpcUrls: {143: ['https://monad.fixture']}, v4: 'native-in', venueRoutes: 'both'})
    const rows = both.getQuotes ? await both.getQuotes(params) : []
    check('uniswap: venueRoutes "both" — getQuotes gives v3 (1.130999 AUSD) and v4 (676.608109 AUSD) as two routes', rows.map((q) => `${q.routeId}:${q.destAmount}`).join(',') === 'v3:1130999,v4:676608109', `${rows.map((q) => `${q.routeId}:${q.destAmount}`).join(',')} misses ${node.misses.join(',')}`)
    const bound = rows.map((q) => uniswapVerifyQuote(params, q))
    const relabelled = rows.map((q) => uniswapVerifyQuote(params, {...q, routeId: q.routeId === 'v3' ? 'v4' : 'v3'}))
    check('uniswap: each route passes the shipped pins, and the same calldata under the other routeId is refused', rows.length === 2 && bound.every((x) => x === null) && relabelled.every((x) => x !== null), JSON.stringify([bound, relabelled]).slice(0, 200))
    const picked = await both.getQuote({...params, routeId: 'v3'})
    check('uniswap: a picked routeId "v3" is quoted on v3 alone (SwapRouter02), never v4', picked?.routeId === 'v3' && picked.destAmount === '1130999' && picked.txRequest?.to === UNISWAP_V3[143]!.router, `${picked?.routeId} ${picked?.destAmount}`)

    // U2: 700 USDC → AUSD through the SwapProxy, simulated with its approval before the quote (Monad: stateDiff fallback).
    const holder = (tokenRecording as {holder: string}).holder
    const tokenParams = {sourceChain: 'eip155:143', destChain: 'eip155:143', sourceToken: 'USDC', destToken: AUSD, amountIn: '700000000', destAddress: holder, refundAddress: holder, sender: holder}
    const tn = tokenNode()
    g.fetch = tn.f
    const tq = await uniswapProvider({rpcUrls: {143: ['https://monad.fixture']}, v4: 'all'}).getQuote(tokenParams)
    const d4 = UNISWAP_V4[143]!
    check('uniswap: v4 token input through the SwapProxy (700 USDC → 700.075685 AUSD, approve(SwapProxy) exact, value 0)', tq?.destAmount === '700075685' && tq.txRequest?.to === d4.swapProxy && tq.txRequest?.approvalAddress === d4.swapProxy && tq.txRequest?.value === '0', `${tq?.destAmount} ${tq?.txRequest?.to} misses ${tn.misses.join(',')}`)
    check('uniswap: the approve + swap was simulated before the quote (eth_simulateV1 not served → the allowance slot by stateDiff)', tq?.providerData?.simulated === 'approve+swap (allowance override)' && tn.methods.includes('eth_simulateV1') && tn.methods.includes('eth_createAccessList'), String(tq?.providerData?.simulated))
    const proxyDecoded = tq?.txRequest?.data ? decodeV4SwapCall(tq.txRequest.data) : null
    check('uniswap: the SwapProxy call decodes strictly (router = the pinned UR, token USDC, amount = the input, TAKE to the holder)', !!proxyDecoded && proxyDecoded.ok && proxyDecoded.swap.flow === 'swap-proxy' && proxyDecoded.swap.proxyRouter === getAddress(d4.universalRouter) && proxyDecoded.swap.proxyAmount === 700_000_000n && proxyDecoded.swap.take.recipient === getAddress(holder), proxyDecoded && !proxyDecoded.ok ? proxyDecoded.text : '')
    const tokenPins = tq ? uniswapVerifyQuote(tokenParams, tq) : 'no quote'
    check('uniswap: the SwapProxy quote passes the shipped pins, and the SwapProxy is a pinned spender', tokenPins === null && uniswapPins.spenders('eip155:143').includes(d4.swapProxy), tokenPins ?? '')

    // Review round 1, LIVE-1: a candidate past Monad's 30M per-transaction cap is read again at the cap and ranked out.
    const ln = live1Node()
    g.fetch = ln.f
    const live1Params = {sourceChain: 'eip155:143', destChain: 'eip155:143', sourceToken: 'AUSD', destToken: NATIVE, amountIn: '2000000000', destAddress: ME, refundAddress: ME}
    const lq = await uniswapProvider({rpcUrls: {143: ['https://monad.fixture']}, v4: 'all'}).getQuote(live1Params)
    check('uniswap: LIVE-1 — 2,000 AUSD → MON quotes on v4 (182,815.6 MON), 4 candidates past the 30M cap ranked out', lq?.destAmount === '182815619388841801516424' && lq.providerData?.v4Unexecutable === '4' && lq.txRequest?.to === d4.swapProxy, `${lq?.destAmount} ${lq?.providerData?.v4Unexecutable} misses ${ln.misses.join(',')}`)
    const live1Pins = lq ? uniswapVerifyQuote(live1Params, lq) : 'no quote'
    check('uniswap: LIVE-1 — that quote passes the shipped pins', live1Pins === null, live1Pins ?? '')
  } finally {
    g.fetch = offline
  }

  // QuoteParams.blockNumber (0.6.0): a venueRoutes "both" pass at block 125,409,523 over the recording — both candidates
  // name the block, every price read goes to its tag (BigInt → hex), the deployment checks stay at latest; a node that
  // lacks the block is retried on the next endpoint and refused as stale_node naming it, nothing read at latest.
  {
    const node = recordedNode()
    const tags: {method: string; selector: string; tag: unknown}[] = []
    g.fetch = async (url: unknown, init?: {body?: unknown}) => {
      for (const c of JSON.parse(String(init?.body)) as {method: string; params: unknown[]}[]) {
        tags.push({method: c.method, selector: String((c.params[0] as {data?: string})?.data ?? '').slice(0, 10), tag: c.method === 'eth_getBlockByNumber' ? c.params[0] : c.params[1]})
      }
      return node.f(url, init)
    }
    try {
      const both = await uniswapProvider({rpcUrls: {143: ['https://monad.fixture']}, v4: 'native-in', venueRoutes: 'both'}).getQuotes!({...params, blockNumber: '125409523'})
      const checks = /^0x(c45a0155|4aa4a4fc|dc4c90d3)$/
      const price = tags.filter((t) => (t.method === 'eth_call' && !checks.test(t.selector)) || t.method === 'eth_getBlockByNumber')
      const latest = tags.filter((t) => t.method === 'eth_getCode' || (t.method === 'eth_call' && checks.test(t.selector)))
      check('uniswap: blockNumber — venueRoutes "both" at block 125,409,523: v3 and v4 both name it (1.130999 / 676.608109 AUSD)', both.map((q) => `${q.routeId}:${q.destAmount}:${q.blockNumber}`).join(',') === 'v3:1130999:125409523,v4:676608109:125409523', `${both.map((q) => `${q.routeId}:${q.destAmount}:${q.blockNumber}`).join(',')} misses ${node.misses.join(',')}`)
      check('uniswap: blockNumber — every price read at 0x77998f3, every deployment check at latest, no eth_blockNumber', price.length > 0 && price.every((t) => t.tag === '0x77998f3') && latest.length > 0 && latest.every((t) => t.tag === 'latest') && !tags.some((t) => t.method === 'eth_blockNumber'), JSON.stringify([...new Set(tags.map((t) => `${t.method}@${String(t.tag)}`))]).slice(0, 200))
      // Neither endpoint has the block: every pinned call answered "header not found".
      g.fetch = async (url: unknown, init?: {body?: unknown}) => {
        const batch = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]}[]
        if (!batch.some((c) => c.params?.[1] === '0x77998f3')) return node.f(url, init)
        return {ok: true, status: 200, headers: {get: () => null}, json: async () => batch.map((c) => ({jsonrpc: '2.0', id: c.id, error: {code: -32000, message: 'header not found'}}))}
      }
      let heard = ''
      let reason: unknown
      const none = await uniswapProvider({rpcUrls: {143: ['https://a.fixture', 'https://b.fixture']}}).getQuote({...params, blockNumber: '125409523', onRefusal: (t, i) => { heard = t; reason = i?.reason }})
      check('uniswap: blockNumber — a node without the block: stale_node naming 125409523, never a quote at latest', none === null && reason === 'stale_node' && /served block 125409523 \(-32000 header not found\)/.test(heard), `${heard} [${String(reason)}]`)
    } finally {
      g.fetch = offline
    }
  }

  // Review round 1: the remote stub declares ownGasEstimate; uniswapPins is uniswapPinsWith().
  const stub = uniswapRemoteProvider({baseUrl: 'https://backend.example/api/swap2'})
  check('uniswap: uniswapRemoteProvider declares ownGasEstimate and offers Monad', stub.ownGasEstimate === true && stub.supportsChain?.('eip155:143') === true && stub.supportsChain?.('eip155:999') === false)
  check('uniswap: uniswapPinsWith() names the shipped call targets', [1, 143, 8453, 42220, 5042].every((id) => JSON.stringify(uniswapPinsWith().callTargets(`eip155:${id}`)) === JSON.stringify(uniswapPins.callTargets(`eip155:${id}`))))

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
  const px = parseActivityFixture(proxyActivity as unknown as ActivityFixtureJson)
  const pitem = describeUniswapActivity(px.tx, {own: px.own})
  check('uniswap: a recorded SwapProxy V4_SWAP is "Uniswap v4 · Ethereum"', pitem?.subtitle === 'Uniswap v4 · Ethereum' && pitem.kind === 'swap', pitem?.subtitle ?? 'null')
  check('uniswap: the encoder words are ABI words', encodeAbiParameters([{type: 'uint128'}], [2n ** 127n]).length === 66)
}
