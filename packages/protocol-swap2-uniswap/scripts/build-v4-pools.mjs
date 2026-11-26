#!/usr/bin/env node
// Builds the pinned Uniswap v4 pool list: src/v4pools/<chainId>.ts per chain + src/v4pools/index.ts.
// Read-only and rerunnable (eth_blockNumber, eth_getLogs, eth_call only; nothing is signed or sent).
// Modelled on protocol-swap2-curve/scripts/build-allowlist.mjs. Plain Node 22+; imports viem (a dependency
// of this package) for keccak/ABI and the workspace catalog (@anywalletkit/swap2-assets) for the pair filter.
//
//   node scripts/build-v4-pools.mjs                      every chain in CHAINS
//   node scripts/build-v4-pools.mjs --chain 143,130      some chains
//   node scripts/build-v4-pools.mjs --dry                print the summary, write nothing
//   node scripts/build-v4-pools.mjs --env FILE           load RPC_<chainId>=url[,url] lines (never printed)
//   node scripts/build-v4-pools.mjs --cache DIR          keep the Initialize index per chain in DIR and resume from it
//   node scripts/build-v4-pools.mjs --baseline           write no `since` (only for a list in the first release that
//                                                        ships v4 pins, 0.5.0, before that release: every app has it)
//
// Method (UNISWAP-V4-RESEARCH.md §5.3, decision 5):
//   1. Index: PoolManager `Initialize` logs over [deployBlock, B], pair-filtered in the RPC
//      (topics = [Initialize, null, S, S], S = catalog token addresses + 0x0 + the pinned wrapped native).
//      A window the endpoint refuses (range, result cap) is split; throttles back off; an endpoint that keeps failing
//      hands the window to the next one. A chain whose index cannot be completed fails (its previous file is kept).
//   2. Static rules, in order: hookless; both currencies in the catalog by address (re-checked, never trusting the RPC
//      filter); fee <= the cap (100000 pips = 10%); PoolId recomputed = the log's id (plus the protocol's own key rules).
//   3. On-chain gate at one pinned block B through Multicall3 aggregate3 on the pinned StateView:
//      StateView.poolManager() = the pinned PoolManager; per pool getSlot0 + getLiquidity. sqrtPriceX96 != 0 and
//      lpFee = the key's fee are invariants of an initialized hookless pool (a break means the endpoint or the pins are
//      wrong: the chain fails). Kept when liquidity > 0 and the tick is more than one spacing inside the price bounds.
//      Any failed read fails the chain; it never drops a pool.
//   4. Value floor: "live" (step 3). No USD floor and no age rule (research §8.2: GeckoTerminal TVL may only rank, and
//      a $10k floor drops winning pools; recall is 100% at "live").
//   5. Lists only grow (review R2-1 / SEC-U4-R2-2): the chain's previous file is read back; a pool it listed stays listed
//      (with its `since`) even when it no longer passes the gate — a server on that older list may route through it, and
//      an app on the newer one must still accept it — and a pool this build adds carries `since: B`, the build block. A
//      chain's first file carries `since` on every pool (apps on earlier releases have no list for it at all), unless
//      --baseline. A server ranks a pool with `since` against v3 only once its `v4RankedListBlock` reaches that block.
// RPC: the public endpoints in CHAINS; RPC_<chainId> (or UNISWAP_V4_RPC_<chainId>) adds keyed endpoints, used first
// for state reads and as a failover (or extra workers) for logs. URLs are never printed or written: labels only, and
// every spelling of every endpoint (and any other scheme://…) is taken out of the error texts printed (redactUrls).
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, decodeFunctionResult, getAddress, keccak256, parseAbi, toBytes } from 'viem'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'src', 'v4pools')

export const ZERO = '0x0000000000000000000000000000000000000000'
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
export const INITIALIZE_TOPIC = keccak256(toBytes('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'))
if (INITIALIZE_TOPIC !== '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438') throw new Error('Initialize topic self-test failed')
/** Owner decision 5: 10% (100000 pips). LPFeeLibrary.MAX_LP_FEE is 1000000 (100%); most hookless pools sit above 10%. */
export const FEE_CAP = 100_000
export const MIN_TICK = -887272
export const MAX_TICK = 887272
/** A gate batch: StateView reads per aggregate3 (2 per pool). */
const GATE_CHUNK = 300

// ---------------------------------------------------------------------------------------------
// Chains: catalog chains with a v4 deployment (UNISWAP-V4-RESEARCH.md §4.1–4.2, pins.json 2026-11-25). PoolManager
// deploy blocks are from the research chain facts (binary search on eth_getCode = the deployment receipt). `logs` are
// tried in order: the first one's window sets the chunk size; `workers` run in parallel on each endpoint whose window
// takes a whole chunk. `native: false` leaves 0x0 out of the pair filter (Arc: the native coin is USDC; Celo: the coin is
// the CELO ERC-20 — decision 6).
// Left out: HyperEVM 999 (decision 6: no quote enabled; idle, and its RPCs ignore the block tag), Soneium 1868,
// Tempo 4217 and Zora 7777777 (not in the catalog).
// ---------------------------------------------------------------------------------------------
const ENV = 'env'
export const CHAINS = [
  { chainId: 1, name: 'Ethereum', poolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90', stateView: '0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227', wrapped: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', deployBlock: 21688329,
    logs: [{ url: ENV, window: 10_000, workers: 4 }, { url: 'https://ethereum-rpc.publicnode.com', window: 10_000, workers: 0 }], state: [ENV, 'https://ethereum-rpc.publicnode.com'] },
  { chainId: 10, name: 'OP Mainnet', poolManager: '0x9a13F98Cb987694C9F086b1F5eB990EeA8264Ec3', stateView: '0xc18a3169788F4F75A170290584ECA6395C75Ecdb', wrapped: '0x4200000000000000000000000000000000000006', deployBlock: 130947675,
    logs: [{ url: 'https://mainnet.optimism.io', window: 10_000, workers: 3 }, { url: ENV, window: 10_000, workers: 3 }], state: [ENV, 'https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'] },
  { chainId: 56, name: 'BNB Chain', poolManager: '0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF', stateView: '0xd13Dd3D6E93f276FAfc9Db9E6BB47C1180aeE0c4', wrapped: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', deployBlock: 45970610,
    logs: [{ url: 'https://bsc-rpc.publicnode.com', window: 10_000, workers: 4 }, { url: ENV, window: 10_000, workers: 4 }], state: [ENV, 'https://bsc-rpc.publicnode.com'] },
  { chainId: 130, name: 'Unichain', poolManager: '0x1F98400000000000000000000000000000000004', stateView: '0x86e8631A016F9068C3f085fAF484Ee3F5fDee8f2', wrapped: '0x4200000000000000000000000000000000000006', deployBlock: 0,
    logs: [{ url: 'https://unichain.gateway.tenderly.co', window: 1_000_000, workers: 2 }, { url: ENV, window: 10_000, workers: 0 }], state: [ENV, 'https://mainnet.unichain.org'] },
  { chainId: 137, name: 'Polygon', poolManager: '0x67366782805870060151383F4BbFF9daB53e5cD6', stateView: '0x5eA1bD7974c8A611cBAB0bDCAFcB1D9CC9b3BA5a', wrapped: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', deployBlock: 66980384,
    logs: [{ url: 'https://polygon-bor-rpc.publicnode.com', window: 10_000, workers: 3 }, { url: ENV, window: 10_000, workers: 3 }], state: [ENV, 'https://polygon-bor-rpc.publicnode.com'] },
  // Monad: rpc2.monad.xyz is the only Monad RPC that takes 20k-block windows (the others 100–1,000).
  { chainId: 143, name: 'Monad', poolManager: '0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e', stateView: '0x77395F3b2E73aE90843717371294fa97cC419D64', wrapped: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A', deployBlock: 29255895,
    logs: [{ url: 'https://rpc2.monad.xyz', window: 20_000, workers: 3 }, { url: 'https://rpc3.monad.xyz', window: 1_000, workers: 0 }, { url: ENV, window: 1_000, workers: 0 }], state: [ENV, 'https://rpc.monad.xyz'] },
  { chainId: 196, name: 'X Layer', poolManager: '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32', stateView: '0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990', wrapped: '0xe538905cf8410324e03A5A23C1c177a474D59b2b', deployBlock: 46106392,
    logs: [{ url: ENV, window: 10_000, workers: 4 }, { url: 'https://rpc.xlayer.tech', window: 100, workers: 0 }], state: [ENV, 'https://rpc.xlayer.tech'] },
  { chainId: 480, name: 'World Chain', poolManager: '0xb1860D529182ac3BC1F51Fa2ABd56662b7D13f33', stateView: '0x51D394718bc09297262e368c1A481217FdEB71eb', wrapped: '0x4200000000000000000000000000000000000006', deployBlock: 9111872,
    logs: [{ url: ENV, window: 10_000, workers: 4 }], state: [ENV, 'https://worldchain-mainnet.g.alchemy.com/public'] },
  { chainId: 4326, name: 'MegaETH', poolManager: '0xaCB7e78fa05D562e0A5D3089ec896D57D057d38E', stateView: '0x726f84e1DFb8d375a365e0808282f40D52D3E4e8', wrapped: '0x4200000000000000000000000000000000000006', deployBlock: 7009653,
    logs: [{ url: 'https://mainnet.megaeth.com/rpc', window: 1_000_000_000, workers: 1 }, { url: ENV, window: 10_000, workers: 0 }], state: [ENV, 'https://mainnet.megaeth.com/rpc'] },
  { chainId: 4663, name: 'Robinhood Chain', poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951', stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b', wrapped: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', deployBlock: 9070,
    logs: [{ url: ENV, window: 10_000, workers: 4 }], state: [ENV, 'https://rpc.mainnet.chain.robinhood.com'] },
  // Arc: the native coin is USDC (0x3600…, also an ERC-20): native in/out is refused (decision 6), so 0x0 is not paired.
  { chainId: 5042, name: 'Arc', poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951', stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b', wrapped: null, native: false, deployBlock: 1948056,
    logs: [{ url: ENV, window: 10_000, workers: 4 }], state: [ENV, 'https://rpc.mainnet.arc.io'] },
  { chainId: 8453, name: 'Base', poolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b', stateView: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71', wrapped: '0x4200000000000000000000000000000000000006', deployBlock: 25350988,
    logs: [{ url: ENV, window: 10_000, workers: 6 }, { url: 'https://base-rpc.publicnode.com', window: 10_000, workers: 0 }], state: [ENV, 'https://base-rpc.publicnode.com'] },
  { chainId: 42161, name: 'Arbitrum', poolManager: '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32', stateView: '0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990', wrapped: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', deployBlock: 297842872,
    logs: [{ url: 'https://arb1.arbitrum.io/rpc', window: 5_000_000, workers: 2 }, { url: ENV, window: 10_000, workers: 0 }], state: [ENV, 'https://arb1.arbitrum.io/rpc'] },
  // Celo: the coin is the CELO ERC-20 (0x471E…); the router has no wrapped native (nativeWrap false, decision 6).
  { chainId: 42220, name: 'Celo', poolManager: '0x288dc841A52FCA2707c6947B3A777c5E56cd87BC', stateView: '0xbc21f8720BABf4b20d195eE5C6e99c52b76F2bfb', wrapped: '0x471EcE3750Da237f93B8E339c536989b8978a438', native: false, deployBlock: 43985163,
    logs: [{ url: ENV, window: 10_000, workers: 4 }, { url: 'https://forno.celo.org', window: 5_000, workers: 0 }], state: [ENV, 'https://forno.celo.org'] },
  { chainId: 43114, name: 'Avalanche', poolManager: '0x06380C0e0912312B5150364B9DC4542BA0DbBc85', stateView: '0xc3c9e198C735a4b97e3e683f391cCBDD60B69286', wrapped: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', deployBlock: 56195376,
    logs: [{ url: 'https://avalanche-c-chain-rpc.publicnode.com', window: 50_000, workers: 3 }], state: [ENV, 'https://avalanche-c-chain-rpc.publicnode.com'] },
  { chainId: 57073, name: 'Ink', poolManager: '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32', stateView: '0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990', wrapped: '0x4200000000000000000000000000000000000006', deployBlock: 4580556,
    logs: [{ url: ENV, window: 10_000, workers: 4 }, { url: 'https://rpc-qnd.inkonchain.com', window: 10_000, workers: 2 }], state: [ENV, 'https://rpc-gel.inkonchain.com'] },
  { chainId: 59144, name: 'Linea', poolManager: '0x248083Fb965359d82b06C1F5322480Dcfc1AD857', stateView: '0xE861de206E460A8b936b05ad3816520B58ccDf9b', wrapped: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', deployBlock: 28974969,
    logs: [{ url: 'https://rpc.linea.build', window: 10_000, workers: 3 }, { url: ENV, window: 10_000, workers: 3 }], state: [ENV, 'https://rpc.linea.build'] },
  { chainId: 99901, name: 'Elysium', poolManager: '0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1', stateView: '0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE', wrapped: '0xbA876237B0F021A6c6D852d6c26E107997cC5E81', deployBlock: 256083,
    logs: [{ url: 'https://rpc.elysium.kinetiq.xyz', window: 1_000_000_000, workers: 1 }], state: ['https://rpc.elysium.kinetiq.xyz'] },
]

// ---------------------------------------------------------------------------------------------
// Pure rules (unit-tested in build-v4-pools.test.mjs).
// ---------------------------------------------------------------------------------------------
const lc = (a) => String(a).toLowerCase()
export const topicOf = (address) => '0x' + lc(address).replace(/^0x/, '').padStart(64, '0')

/** keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)) — PoolId.sol. */
export function poolIdOf(key) {
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [getAddress(key.currency0), getAddress(key.currency1), key.fee, key.tickSpacing, getAddress(key.hooks ?? ZERO)],
  ))
}

/** The pair-filter set S: the catalog's tokens on the chain (native = 0x0 unless `native: false`), plus the wrapped native. Sorted, lower-case. */
export function pairFilterSet(cfg, catalogAssets) {
  const s = new Set()
  for (const a of catalogAssets) {
    if (a.contract) s.add(lc(getAddress(a.contract)))
    else if (cfg.native !== false) s.add(ZERO)
  }
  if (cfg.wrapped) s.add(lc(cfg.wrapped))
  return [...s].sort()
}

const WORD = /^[0-9a-f]{64}$/
const wordAt = (hex, i) => hex.slice(2 + 64 * i, 2 + 64 * (i + 1))
/** Signed int24 from a 32-byte word (sign-extended in ABI), or null when the word is not a sign-extended int24. */
function int24Word(w) {
  const v = BigInt.asIntN(256, BigInt('0x' + w))
  return v >= -8388608n && v <= 8388607n ? Number(v) : null // eslint-disable-line anywalletkit/no-number-bigint -- int24 range checked
}
function uintWord(w, bits) {
  const v = BigInt('0x' + w)
  return v < 1n << BigInt(bits) ? v : null
}
const addrWord = (w) => (/^0{24}[0-9a-f]{40}$/.test(w) ? '0x' + w.slice(24) : null)

/**
 * One raw `Initialize` log → a decoded row, or null with the reason when it is not a well-formed log of `poolManager`.
 * Strict: exact topic count, 5 data words, int24/uint24/uint160/address ranges, `removed` logs refused.
 */
export function decodeInitializeLog(log, poolManager) {
  if (!log || log.removed === true) return { error: 'removed or empty log' }
  if (lc(log.address) !== lc(poolManager)) return { error: `log from ${log.address}, not the PoolManager` }
  const t = log.topics
  if (!Array.isArray(t) || t.length !== 4 || lc(t[0]) !== INITIALIZE_TOPIC) return { error: 'not an Initialize log' }
  const data = lc(log.data ?? '')
  if (!/^0x[0-9a-f]*$/.test(data) || data.length !== 2 + 64 * 5) return { error: 'Initialize data is not 5 words' }
  const [w0, w1, w2, w3, w4] = [0, 1, 2, 3, 4].map((i) => wordAt(data, i))
  const c0 = addrWord(lc(t[2]).slice(2)), c1 = addrWord(lc(t[3]).slice(2))
  const fee = uintWord(w0, 24), tickSpacing = int24Word(w1), hooks = addrWord(w2), sqrtPriceX96 = uintWord(w3, 160), tick = int24Word(w4)
  if (!WORD.test(lc(t[1]).slice(2)) || !c0 || !c1 || fee === null || tickSpacing === null || !hooks || sqrtPriceX96 === null || tick === null) return { error: 'Initialize fields out of range' }
  const block = Number(BigInt(log.blockNumber)) // eslint-disable-line anywalletkit/no-number-bigint -- block numbers are < 2^53
  return { id: lc(t[1]), currency0: c0, currency1: c1, fee: Number(fee), tickSpacing, hooks, sqrtPriceX96: sqrtPriceX96.toString(), tick, block } // eslint-disable-line anywalletkit/no-number-bigint -- uint24
}

/**
 * The static rules, in order (each drops with its reason): hookless; both currencies in S by address; fee <= cap;
 * the protocol's key rules (currency0 < currency1, 1 <= tickSpacing <= 32767, a static fee); PoolId recomputed = the log id.
 */
export function staticRules(rows, { tokens, feeCap = FEE_CAP }) {
  const S = new Set(tokens.map(lc))
  const dropped = new Map()
  const stage = {}
  const rules = [
    ['hooked', (r) => lc(r.hooks) !== ZERO],
    ['not-catalog', (r) => !S.has(lc(r.currency0)) || !S.has(lc(r.currency1))],
    ['fee-above-cap', (r) => !(r.fee <= feeCap)],
    ['bad-key', (r) => !(BigInt(r.currency0) < BigInt(r.currency1)) || !(r.tickSpacing >= 1 && r.tickSpacing <= 32767) || (r.fee & 0xc00000) !== 0],
    ['id-mismatch', (r) => poolIdOf(r) !== lc(r.id)],
  ]
  let kept = rows
  for (const [reason, test] of rules) {
    kept = kept.filter((r) => { if (!test(r)) return true; dropped.set(r.id, reason); return false })
    stage[reason] = kept.length
  }
  return { kept, dropped, stage }
}

/** One spacing from a price bound or beyond it: a pool there cannot be swapped one way. */
export const atBound = (tick, tickSpacing) => tick - tickSpacing <= MIN_TICK || tick + tickSpacing >= MAX_TICK

/**
 * The gate verdict for one pool at block B: 'live', a drop reason ('no-liquidity', 'at-bound'), or an `invariant`
 * error (sqrtPriceX96 = 0 or lpFee != fee on an initialized hookless pool: the read is wrong, so the chain fails).
 */
export function gateVerdict(key, slot0, liquidity) {
  if (slot0.sqrtPriceX96 === 0n) return { invariant: `${key.id}: sqrtPriceX96 is 0 at the pinned block for a pool its Initialize log created` }
  if (slot0.lpFee !== key.fee) return { invariant: `${key.id}: lpFee ${slot0.lpFee} != key fee ${key.fee} on a hookless pool` }
  if (liquidity === 0n) return { drop: 'no-liquidity' }
  if (atBound(slot0.tick, key.tickSpacing)) return { drop: 'at-bound' }
  return { live: true }
}

/** Deterministic order: by currency0, currency1, fee, tickSpacing. */
export function sortPools(pools) {
  return [...pools].sort((a, b) => (lc(a.currency0) < lc(b.currency0) ? -1 : lc(a.currency0) > lc(b.currency0) ? 1 : lc(a.currency1) < lc(b.currency1) ? -1 : lc(a.currency1) > lc(b.currency1) ? 1 : a.fee - b.fee || a.tickSpacing - b.tickSpacing))
}

// ---------------------------------------------------------------------------------------------
// Multicall3 + StateView ABI.
// ---------------------------------------------------------------------------------------------
export const MC3_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])
export const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
  'function poolManager() view returns (address)',
])

/** Decodes one aggregate3 answer strictly: n results, every one successful, returnData of the exact size. */
export function decodeAggregate(hex, expectSizes) {
  const results = decodeFunctionResult({ abi: MC3_ABI, functionName: 'aggregate3', data: hex })
  if (!Array.isArray(results) || results.length !== expectSizes.length) throw new Error(`aggregate3 returned ${results?.length} results for ${expectSizes.length} calls`)
  return results.map((r, i) => {
    if (!r.success) throw new Error(`sub-call ${i} failed (${r.returnData.slice(0, 10)})`)
    if ((r.returnData.length - 2) / 2 !== expectSizes[i]) throw new Error(`sub-call ${i} returned ${(r.returnData.length - 2) / 2} bytes, not ${expectSizes[i]}`)
    return r.returnData
  })
}
export function decodeSlot0(hex) {
  const [sqrtPriceX96, tick, protocolFee, lpFee] = decodeAbiParameters([{ type: 'uint160' }, { type: 'int24' }, { type: 'uint24' }, { type: 'uint24' }], hex)
  return { sqrtPriceX96, tick, protocolFee, lpFee }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC: one request at a time per worker, classified errors, retries with backoff. URLs never leave this object.
// ---------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Error kinds from an RPC/HTTP failure: 'range' and 'too-many' split the window; 'no-state' re-pins; the rest retry. */
export function classifyRpcError(status, message, code) {
  const m = String(message ?? '').toLowerCase()
  if (status === 429 || code === -32005 || code === -32007 || /rate|too many requests|request limit|exhausted|throttl|capacity/.test(m)) return 'rate-limit'
  if (/log response size|query returned more than|logs count|count limit|too many logs|more than \d+ results|result set|response size|limit exceeded \(\d+\)|10000 results|returned more than/.test(m)) return 'too-many'
  if (/block range|range|blocks? (is |are )?(too large|limited|exceeds?)|max(imum)? (allowed )?range|exceed(ed|s)? max|limited to|too large|ranges over/.test(m) || status === 413) return 'range'
  if (/missing trie|header not found|historical state|state.*(not available|unavailable|pruned)|archive|pruned/.test(m)) return 'no-state'
  if (/revert/.test(m) || code === 3) return 'revert'
  if (status && status >= 500) return 'server'
  if (status && status >= 400) return 'http'
  return 'other'
}

/**
 * Every spelling of every endpoint a `Rpc` was made for — as given, without its scheme, host + path (+ query), path
 * (+ query), user:pass, and each path segment or query value long enough to be a key — longest first (TOOLING-2: only
 * the exact URL was taken out, so a node's 404 body "Cannot POST /v2/<key>" printed the key). `redactUrls` takes them
 * out of a text, and any other `scheme://…` too, as scripts/verify-live.mjs does.
 */
const SPELLINGS = new Set()
let spellingsByLength = []
export function addUrlSpellings(raw) {
  const add = (s) => { if (s && s.length >= 6) SPELLINGS.add(s) }
  const u = String(raw).trim()
  const bare = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/\//, '')
  add(u)
  add(bare)
  for (const text of [u, `https://${bare}`]) {
    try {
      const p = new URL(text)
      add(p.href)
      add(p.href.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''))
      add(`${p.host}${p.pathname}${p.search}`)
      if (p.pathname.length > 1 || p.search) add(`${p.pathname}${p.search}`)
      if (p.username || p.password) add(`${p.username}:${p.password}`)
      for (const seg of p.pathname.split('/')) if (seg.length >= 16) add(seg)
      for (const v of p.searchParams.values()) if (v.length >= 16) add(v)
    } catch { /* not a URL: the spellings above */ }
  }
  spellingsByLength = [...SPELLINGS].sort((a, b) => b.length - a.length)
}
export function redactUrls(s) {
  let t = String(s)
  for (const u of spellingsByLength) if (t.includes(u)) t = t.split(u).join('<url>')
  return t.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
}

export class Rpc {
  constructor(url, label) { this.url = url; this.label = label; this.requests = 0; this.errors = {}; addUrlSpellings(url) }
  async call(method, params, { retries = 6, timeoutMs = 60_000 } = {}) {
    let last
    for (let attempt = 0; attempt <= retries; attempt++) {
      let status = 0, message = '', code
      try {
        this.requests++
        const r = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: this.requests, method, params }), signal: AbortSignal.timeout(timeoutMs) })
        status = r.status
        const text = await r.text()
        // Every text the error may carry is redacted before it is cut, so no part of an endpoint survives the cut.
        if (!r.ok) message = redactUrls(text).slice(0, 200)
        else {
          let j
          try { j = JSON.parse(text) } catch { message = `bad JSON: ${redactUrls(text).slice(0, 80)}` }
          if (j && j.error) { message = redactUrls(String(j.error.message ?? JSON.stringify(j.error))); code = j.error.code }
          else if (j && 'result' in j) return j.result
          else if (j) message = 'no result'
        }
      } catch (e) {
        message = redactUrls(String(e?.message ?? e))
      }
      const kind = classifyRpcError(status, message, code)
      this.errors[kind] = (this.errors[kind] ?? 0) + 1
      last = Object.assign(new Error(`${this.label}: ${method} ${status ? `HTTP ${status} ` : ''}${message.slice(0, 160)}`), { kind })
      if (kind === 'range' || kind === 'too-many' || kind === 'no-state' || kind === 'revert') throw last
      if (attempt < retries) await sleep(Math.min(30_000, (kind === 'rate-limit' ? 1500 : 600) * 2 ** attempt) + Math.random() * 300)
    }
    throw last
  }
}

// ---------------------------------------------------------------------------------------------
// Index: Initialize logs over [from, to], chunked, split on refusals, failed over between endpoints.
// ---------------------------------------------------------------------------------------------
const hexBlock = (n) => '0x' + n.toString(16)

/**
 * Fetches every Initialize log of `poolManager` in [from, to] with `topics`. `eps` = [{rpc, window, workers}], tried in
 * order per chunk. Returns decoded rows (deduplicated by id) and stats; throws when a range cannot be fetched anywhere.
 */
export async function scanInitialize({ eps, poolManager, topics, from, to, onProgress, resume }) {
  if (!eps.length) throw new Error('no log endpoint')
  const rows = new Map(resume?.rows?.map((r) => [r.id, r]) ?? [])
  const start = resume?.scannedTo != null ? resume.scannedTo + 1 : from
  const chunk = eps[0].window
  const chunks = []
  for (let a = start; a <= to; a += chunk) chunks.push([a, Math.min(to, a + chunk - 1)])
  const stats = { chunks: chunks.length, calls: 0, splits: 0, failovers: 0, logs: 0, bad: 0 }
  const done = new Set()
  let firstUndone = 0
  let stop = false

  /** A node that has not reached block b answers eth_getLogs up to its own head without saying so: wait for it, then fail over. */
  async function ensureHead(ep, b) {
    for (let i = 0; i < 6; i++) {
      if ((ep.head ?? -1) >= b) return
      ep.head = Number(BigInt(await ep.rpc.call('eth_blockNumber', []))) // eslint-disable-line anywalletkit/no-number-bigint -- block numbers are < 2^53
      if (ep.head >= b) return
      await sleep(5_000)
    }
    throw Object.assign(new Error(`${ep.rpc.label}: head ${ep.head} is behind block ${b}`), { kind: 'behind' })
  }
  async function getLogs(ep, a, b) {
    await ensureHead(ep, b)
    stats.calls++
    const logs = await ep.rpc.call('eth_getLogs', [{ address: poolManager, topics, fromBlock: hexBlock(a), toBlock: hexBlock(b) }])
    if (!Array.isArray(logs)) throw Object.assign(new Error(`${ep.rpc.label}: eth_getLogs answered a non-array`), { kind: 'other' })
    return logs
  }
  async function fetchRange(a, b, i) {
    const ep = eps[i]
    if (b - a + 1 > ep.window) {
      for (let x = a; x <= b; x += ep.window) await fetchRange(x, Math.min(b, x + ep.window - 1), i)
      return
    }
    let logs
    try {
      logs = await getLogs(ep, a, b)
    } catch (e) {
      if ((e.kind === 'range' || e.kind === 'too-many') && b > a) {
        stats.splits++
        const mid = Math.floor((a + b) / 2)
        await fetchRange(a, mid, i)
        await fetchRange(mid + 1, b, i)
        return
      }
      if (i + 1 < eps.length) { stats.failovers++; await fetchRange(a, b, i + 1); return }
      throw e
    }
    for (const log of logs) {
      const bn = Number(BigInt(log.blockNumber ?? '0x0')) // eslint-disable-line anywalletkit/no-number-bigint -- block numbers are < 2^53
      if (bn < a || bn > b) throw new Error(`${ep.rpc.label}: a log at block ${bn} outside the asked range ${a}..${b}`)
      const d = decodeInitializeLog(log, poolManager)
      if (d.error) { stats.bad++; throw new Error(`${ep.rpc.label}: ${d.error} at block ${bn}`) }
      rows.set(d.id, d)
      stats.logs++
    }
  }
  let next = 0
  const workers = []
  eps.forEach((ep, i) => {
    if (ep.window < chunk) return
    for (let w = 0; w < (ep.workers ?? 0); w++) {
      workers.push((async () => {
        while (!stop && next < chunks.length) {
          const k = next++
          const [a, b] = chunks[k]
          try { await fetchRange(a, b, i) } catch (e) { stop = true; throw e }
          done.add(k)
          while (done.has(firstUndone)) firstUndone++
          // Every chunk up to firstUndone is in `rows`: a checkpoint may resume after its last block.
          onProgress?.({ done: done.size, of: chunks.length, contiguous: firstUndone > 0 ? chunks[firstUndone - 1][1] : start - 1, rows })
        }
      })())
    }
  })
  if (!workers.length) throw new Error('no endpoint has workers for the chunk size')
  const results = await Promise.allSettled(workers)
  const failed = results.find((r) => r.status === 'rejected')
  if (failed) throw failed.reason
  if (done.size !== chunks.length) throw new Error(`index incomplete: ${done.size} of ${chunks.length} windows`)
  return { rows: [...rows.values()], stats }
}

// ---------------------------------------------------------------------------------------------
// Gate: StateView reads at one block through Multicall3.
// ---------------------------------------------------------------------------------------------
async function aggregate(rpcs, calls, block, expectSizes) {
  const data = encodeFunctionData({ abi: MC3_ABI, functionName: 'aggregate3', args: [calls.map((c) => ({ target: c.to, allowFailure: true, callData: c.data }))] })
  let last
  for (const rpc of rpcs) {
    try {
      const hex = await rpc.call('eth_call', [{ to: MULTICALL3, data }, hexBlock(block)])
      return decodeAggregate(hex, expectSizes)
    } catch (e) {
      last = e
      if (e.kind === 'no-state') continue
      if (!e.kind) throw e // a decode failure is a fact about this answer: no silent failover to a friendlier node
    }
  }
  throw last
}

export async function gate(cfg, rpcs, keys, block) {
  const sv = cfg.stateView
  const [pm] = await aggregate(rpcs, [{ to: sv, data: encodeFunctionData({ abi: STATE_VIEW_ABI, functionName: 'poolManager' }) }], block, [32])
  if (lc(getAddress('0x' + pm.slice(-40))) !== lc(cfg.poolManager)) throw new Error(`StateView.poolManager() = 0x${pm.slice(-40)}, not the pinned PoolManager`)
  const live = []
  const dropped = new Map()
  for (let i = 0; i < keys.length; i += GATE_CHUNK / 2) {
    const part = keys.slice(i, i + GATE_CHUNK / 2)
    const calls = part.flatMap((k) => [
      { to: sv, data: encodeFunctionData({ abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [k.id] }) },
      { to: sv, data: encodeFunctionData({ abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [k.id] }) },
    ])
    const res = await aggregate(rpcs, calls, block, part.flatMap(() => [128, 32]))
    part.forEach((k, j) => {
      const slot0 = decodeSlot0(res[2 * j])
      const [liquidity] = decodeAbiParameters([{ type: 'uint128' }], res[2 * j + 1])
      const v = gateVerdict(k, slot0, liquidity)
      if (v.invariant) throw new Error(v.invariant)
      if (v.drop) dropped.set(k.id, v.drop)
      else live.push({ ...k, liquidity: liquidity.toString(), tickNow: slot0.tick })
    })
  }
  return { live, dropped }
}

// ---------------------------------------------------------------------------------------------
// Output.
// ---------------------------------------------------------------------------------------------
const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const cs = (a) => (lc(a) === ZERO ? ZERO : getAddress(a))

export function toEntry(p) {
  return { currency0: cs(p.currency0), currency1: cs(p.currency1), fee: p.fee, tickSpacing: p.tickSpacing, id: lc(p.id), ...(p.since !== undefined ? { since: p.since } : {}) }
}

const ENTRY_LINE = /^\s*\{currency0: "(0x[0-9a-fA-F]{40})", currency1: "(0x[0-9a-fA-F]{40})", fee: (\d+), tickSpacing: (\d+), id: "(0x[0-9a-f]{64})"(?:, since: (\d+))?\},\s*$/

/**
 * The pools a generated chain file lists (what renderChainFile wrote), each with its `since` when it has one. Every
 * entry line must parse and recompute to its own PoolId: a file this cannot read back fails the build of the chain (a
 * list is never shrunk by a parse error).
 */
export function parseChainFile(text) {
  const lines = String(text).split('\n')
  const at = lines.findIndex((l) => l.trim() === 'pools: [')
  const end = at < 0 ? -1 : lines.findIndex((l, i) => i > at && l.trim() === '],')
  if (at < 0 || end < 0) throw new Error('the previous pool list does not parse (no pools: [ … ] block)')
  const out = []
  for (const line of lines.slice(at + 1, end)) {
    const m = ENTRY_LINE.exec(line)
    if (!m) throw new Error(`the previous pool list has a line it cannot read: ${line.trim().slice(0, 80)}`)
    const e = { currency0: m[1], currency1: m[2], fee: Number(m[3]), tickSpacing: Number(m[4]), id: m[5], ...(m[6] !== undefined ? { since: Number(m[6]) } : {}) }
    if (poolIdOf({ ...e, hooks: ZERO }) !== e.id) throw new Error(`the previous pool list entry ${e.id} does not match its key`)
    out.push(e)
  }
  return out
}

/**
 * The list a build writes (step 5): every pool of `previous` (null: the chain had no file) kept with its `since`; every
 * pool of `fresh` not in it added with `since: block` — or with none when `baseline`, or when it was listed before.
 * Returns {entries (sorted), added, kept} (`kept`: previous pools this build's gate no longer passes).
 */
export function mergeEntries(previous, fresh, { block, baseline = false }) {
  const byId = new Map()
  for (const p of previous ?? []) byId.set(lc(p.id), toEntry(p))
  let added = 0
  const freshIds = new Set()
  for (const p of fresh) {
    const id = lc(p.id)
    freshIds.add(id)
    if (byId.has(id)) continue
    const { since: _ignored, ...e } = toEntry(p)
    byId.set(id, baseline ? e : { ...e, since: block })
    added++
  }
  const kept = [...byId.keys()].filter((id) => !freshIds.has(id)).length
  return { entries: sortPools([...byId.values()]), added, kept }
}

export function renderChainFile(cfg, meta, entries) {
  const n = (x) => x.toLocaleString('en-US')
  return [
    `// Generated by scripts/build-v4-pools.mjs on ${meta.builtAt}. Do not edit by hand: rerun the script.`,
    `// ${cfg.name} (${cfg.chainId}). PoolManager ${getAddress(cfg.poolManager)}, StateView ${getAddress(cfg.stateView)}.`,
    `// Index: Initialize logs over blocks ${n(meta.fromBlock)}..${n(meta.block)}, pair-filtered on the ${meta.tokens.length} tokens below (${meta.initialized} pools).`,
    `// Rules: hookless; both currencies in the catalog by address; fee <= ${meta.feeCap} pips; PoolId recomputed. Live at block ${n(meta.block)}:`,
    `// sqrtPriceX96 != 0, lpFee = fee, liquidity > 0, tick more than one spacing inside the bounds. Floor: live.`,
    ...(meta.kept ? [`// Lists only grow: ${meta.kept} pool(s) of earlier builds kept although not live at block ${n(meta.block)}.`] : []),
    ...(entries.some((e) => e.since !== undefined) ? ['// `since`: the build block of the list that added the pool (a server ranks it against v3 once v4RankedListBlock covers it).'] : []),
    `import type {V4ChainPools} from "./types.js";`,
    '',
    `export const V4_POOLS_${cfg.chainId}: V4ChainPools = {`,
    `  chainId: ${cfg.chainId},`,
    `  poolManager: ${q(getAddress(cfg.poolManager))},`,
    `  stateView: ${q(getAddress(cfg.stateView))},`,
    `  builtAt: ${q(meta.builtAt)},`,
    `  block: ${meta.block},`,
    `  feeCap: ${meta.feeCap},`,
    '  tokens: [',
    ...meta.tokens.map((t) => `    ${q(cs(t))},`),
    '  ],',
    '  pools: [',
    ...entries.map((e) => `    {currency0: ${q(e.currency0)}, currency1: ${q(e.currency1)}, fee: ${e.fee}, tickSpacing: ${e.tickSpacing}, id: ${q(e.id)}${e.since !== undefined ? `, since: ${e.since}` : ''}},`),
    '  ],',
    '} as const;',
    '',
  ].join('\n')
}

export function renderIndex(chainIds) {
  const ids = [...chainIds].sort((a, b) => a - b)
  return [
    '// Generated by scripts/build-v4-pools.mjs. Do not edit by hand: rerun the script.',
    'import type {V4ChainPools} from "./types.js";',
    'import {freezeChainPools} from "./freeze.js";',
    ...ids.map((id) => `import {V4_POOLS_${id}} from "./${id}.js";`),
    '',
    'export type {V4ChainPools, V4ListedPool, V4PoolKey} from "./types.js";',
    '',
    '/** The pinned hookless Uniswap v4 pools per chain id (scripts/build-v4-pools.mjs). A chain missing here has no list.',
    ' *  Frozen all the way down (freeze.ts): no pool row, array or list can be changed after load. */',
    'export const UNISWAP_V4_POOLS: Readonly<Record<number, V4ChainPools>> = Object.freeze({',
    ...ids.map((id) => `  ${id}: freezeChainPools(V4_POOLS_${id}),`),
    '});',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------------------------
// Catalog, env, endpoints.
// ---------------------------------------------------------------------------------------------
async function loadCatalog() {
  for (const spec of ['@anywalletkit/swap2-assets', new URL('../../swap2-assets/src/index.ts', import.meta.url).href]) {
    try { const m = await import(spec); if (typeof m.ccChain === 'function') return m } catch { /* next */ }
  }
  throw new Error('swap2-assets catalog not loadable: build packages/swap2-assets or use Node >= 22.18')
}

function loadEnvFile(file) {
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*((?:UNISWAP_V4_)?RPC_\d+)\s*=\s*(.+?)\s*$/.exec(l)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
  }
}
const envUrls = (id) => (process.env[`UNISWAP_V4_RPC_${id}`] || process.env[`RPC_${id}`] || '').split(',').map((s) => s.trim()).filter(Boolean)
const hostLabel = (url) => { try { const u = new URL(url); return u.host } catch { return 'rpc' } }

function endpointsFor(cfg) {
  const env = envUrls(cfg.chainId)
  const rpcs = new Map()
  const rpcOf = (url, label) => { if (!rpcs.has(url)) rpcs.set(url, new Rpc(url, label)); return rpcs.get(url) }
  const expand = (url) => (url === ENV ? env.map((u, i) => [u, `env#${i}`]) : [[url, hostLabel(url)]])
  const logs = cfg.logs.flatMap((e) => expand(e.url).map(([u, label]) => ({ rpc: rpcOf(u, label), window: e.window, workers: e.workers })))
  const state = cfg.state.flatMap((u) => expand(u).map(([url, label]) => rpcOf(url, label)))
  return { logs, state, all: () => [...rpcs.values()] }
}

// ---------------------------------------------------------------------------------------------
// One chain.
// ---------------------------------------------------------------------------------------------
async function buildChain(cfg, catalog, { feeCap, cacheDir }) {
  const t0 = Date.now()
  const tokens = pairFilterSet(cfg, catalog.ccChain(`eip155:${cfg.chainId}`)?.assets ?? [])
  if (tokens.length < 2) throw new Error('fewer than two catalog tokens')
  const eps = endpointsFor(cfg)
  if (!eps.state.length) throw new Error('no state endpoint (set RPC_<chainId>)')
  const head = Number(BigInt(await eps.state[0].call('eth_blockNumber', []))) // eslint-disable-line anywalletkit/no-number-bigint -- block numbers are < 2^53
  const block = head - (cfg.confirm ?? 20)
  const topicsS = tokens.map(topicOf)
  const topics = [INITIALIZE_TOPIC, null, topicsS, topicsS]
  const filterKey = JSON.stringify({ pm: lc(cfg.poolManager), from: cfg.deployBlock, topics })
  const cacheFile = cacheDir ? join(cacheDir, `${cfg.chainId}.index.json`) : null
  let resume = null
  if (cacheFile && existsSync(cacheFile)) {
    const c = JSON.parse(readFileSync(cacheFile, 'utf8'))
    if (c.filterKey === filterKey && c.scannedTo <= block) { resume = c; console.error(`  resuming from the cached index (scanned to ${c.scannedTo}, ${c.rows.length} pools)`) }
  }
  let lastSave = Date.now()
  const save = (rows, scannedTo) => {
    if (!cacheFile) return
    const keep = [...rows.values()].filter((r) => r.block <= scannedTo)
    writeFileSync(cacheFile + '.tmp', JSON.stringify({ filterKey, scannedTo, rows: keep }))
    renameSync(cacheFile + '.tmp', cacheFile)
  }
  const { rows, stats } = await scanInitialize({
    eps: eps.logs, poolManager: cfg.poolManager, topics, from: cfg.deployBlock, to: block, resume,
    onProgress: ({ done, of, contiguous, rows: r }) => {
      if (Date.now() - lastSave > 20_000) { lastSave = Date.now(); save(r, contiguous); console.error(`  ${cfg.name}: ${done}/${of} windows, ${r.size} pools, contiguous to ${contiguous}`) }
    },
  })
  save(new Map(rows.map((r) => [r.id, r])), block)
  const { kept, dropped, stage } = staticRules(rows, { tokens, feeCap })
  const g = await gate(cfg, eps.state, kept, block)
  for (const [id, why] of g.dropped) dropped.set(id, why)
  const final = sortPools(g.live)
  const requests = eps.all().reduce((n, r) => n + r.requests, 0)
  const errorKinds = {}
  for (const r of eps.all()) for (const [k, v] of Object.entries(r.errors)) errorKinds[k] = (errorKinds[k] ?? 0) + v
  return {
    cfg, block, tokens, final, dropped,
    summary: { chain: cfg.name, chainId: cfg.chainId, block, fromBlock: cfg.deployBlock, initialized: rows.length, ...stage, live: final.length, getLogs: stats.calls, splits: stats.splits, failovers: stats.failovers, requests, errors: JSON.stringify(errorKinds), seconds: Math.round((Date.now() - t0) / 1000) },
  }
}

async function main() {
  const args = process.argv.slice(2)
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
  const only = opt('--chain') ? new Set(opt('--chain').split(',').map(Number)) : null
  const dry = args.includes('--dry')
  const baseline = args.includes('--baseline')
  if (opt('--env')) loadEnvFile(opt('--env'))
  const cacheDir = opt('--cache') ?? null
  if (cacheDir) mkdirSync(cacheDir, { recursive: true })
  const feeCap = opt('--fee-cap') ? Number(opt('--fee-cap')) : FEE_CAP
  if (!Number.isInteger(feeCap) || feeCap < 1 || feeCap > FEE_CAP) throw new Error(`--fee-cap must be 1..${FEE_CAP}`)
  const builtAt = new Date().toISOString().slice(0, 10)
  const catalog = await loadCatalog()
  mkdirSync(OUT_DIR, { recursive: true })
  const chains = CHAINS.filter((c) => !only || only.has(c.chainId))
  if (only) for (const id of only) if (!CHAINS.some((c) => c.chainId === id)) throw new Error(`chain ${id} is not in CHAINS`)
  const failed = new Set()
  const rows = []
  // Chains run in parallel: each has its own endpoints.
  await Promise.all(chains.map(async (cfg) => {
    console.error(`== ${cfg.name} (${cfg.chainId})`)
    let r
    try { r = await buildChain(cfg, catalog, { feeCap, cacheDir }) } catch (e) { const why = redactUrls(e?.message ?? e); console.error(`  ${cfg.name} FAILED: ${why}`); failed.add(cfg.chainId); rows.push({ chain: cfg.name, chainId: cfg.chainId, error: why }); return }
    rows.push(r.summary)
    const reasons = {}
    for (const [, why] of r.dropped) reasons[why] = (reasons[why] ?? 0) + 1
    console.error(`  ${cfg.name}: block ${r.block}; dropped by reason: ${JSON.stringify(reasons)}; live ${r.final.length}`)
    for (const p of r.final) console.error(`    + ${cfg.chainId} ${cs(p.currency0)}/${cs(p.currency1)} ${p.fee}/${p.tickSpacing} L=${p.liquidity} ${p.id.slice(0, 10)}`)
    // Step 5: the previous file, read back; lists only grow.
    const file = join(OUT_DIR, `${cfg.chainId}.ts`)
    let previous = null
    try { previous = existsSync(file) ? parseChainFile(readFileSync(file, 'utf8')) : null } catch (e) { const why = redactUrls(e?.message ?? e); console.error(`  ${cfg.name} FAILED: ${why}`); failed.add(cfg.chainId); rows.push({ chain: cfg.name, chainId: cfg.chainId, error: why }); return }
    const merged = mergeEntries(previous, r.final, { block: r.block, baseline })
    console.error(`  ${cfg.name}: ${merged.added} added${merged.added && !baseline ? ` (since ${r.block})` : ''}, ${merged.kept} kept from earlier builds although not live now`)
    if (!merged.entries.length) { console.error(`  ${cfg.name}: nothing passed, no file`); return }
    if (!dry) writeFileSync(file, renderChainFile(cfg, { builtAt, block: r.block, fromBlock: cfg.deployBlock, tokens: r.tokens, feeCap, initialized: r.summary.initialized, kept: merged.kept }, merged.entries))
  }))
  if (!dry) {
    // A full run drops the files of chains no longer in CHAINS (lists only grow: a chain in CHAINS keeps its file); a
    // chain that failed keeps its last file.
    if (!only) for (const f of readdirSync(OUT_DIR)) { const m = /^(\d+)\.ts$/.exec(f); if (m && !CHAINS.some((c) => c.chainId === Number(m[1])) && !failed.has(Number(m[1]))) rmSync(join(OUT_DIR, f)) }
    const present = readdirSync(OUT_DIR).map((f) => /^(\d+)\.ts$/.exec(f)?.[1]).filter(Boolean).map(Number)
    writeFileSync(join(OUT_DIR, 'index.ts'), renderIndex(present))
  }
  if (failed.size) process.exitCode = 1
  const cols = ['chain', 'chainId', 'fromBlock', 'block', 'initialized', 'hooked', 'not-catalog', 'fee-above-cap', 'bad-key', 'id-mismatch', 'live', 'getLogs', 'splits', 'failovers', 'requests', 'errors', 'seconds']
  console.log(`| ${cols.join(' | ')} |`)
  console.log(`|${cols.map(() => '---').join('|')}|`)
  for (const r of rows.sort((a, b) => a.chainId - b.chainId)) console.log(r.error ? `| ${r.chain} | ${r.chainId} | error: ${r.error} |` : `| ${cols.map((c) => r[c] ?? '').join(' | ')} |`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
