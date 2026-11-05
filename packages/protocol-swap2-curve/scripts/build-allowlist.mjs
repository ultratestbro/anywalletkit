#!/usr/bin/env node
// Builds the curated Curve pool allowlist: src/pools/<chainId>.ts per chain + src/pools/index.ts.
// Read-only and rerunnable. The Curve API is used for discovery and USD prices only; every field
// that ends up in a file (coins, decimals, balances, code hash, registration, quotes) is re-read
// on-chain at one pinned block per chain. Plain Node 22.18+; the only import is the workspace catalog
// (@anywalletkit/swap2-assets) for the TVL anchors.
//
//   node scripts/build-allowlist.mjs                 every chain
//   node scripts/build-allowlist.mjs --chain 1,8453  some chains
//   node scripts/build-allowlist.mjs --dry           print the summary, write nothing
//
// RPCs: the public endpoints below; CURVE_RPC_<chainId> overrides one (never printed).
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'src', 'pools')

export const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const ZERO = '0x0000000000000000000000000000000000000000'
const DAY = 86_400
export const MIN_AGE_DAYS = 30
export const TVL_MIN_ETHEREUM = 1_000_000
export const TVL_MIN_OTHER = 250_000
export const CAP_ETHEREUM = 80
export const CAP_OTHER = 40

// ---------------------------------------------------------------------------------------------
// Chains: wallet chains where Router NG is deployed (CURVE-INTEGRATION.md §2.2). `v1` = slug on
// api.curve.finance/v1, `v2` = chain served only by api2.curve.finance. MetaRegistry and the NG
// factories are from Curve's deployments.json (2026-11-05); the script checks each has code.
// Left out: Arc 5042 (no pools, WETH 0), zkSync 324 (EraVM router ABI unverified), Fraxtal 252
// (not a wallet chain).
// ---------------------------------------------------------------------------------------------
export const CHAINS = [
  { chainId: 1, name: 'Ethereum', family: 'ng5', v1: 'ethereum', rpc: 'https://ethereum-rpc.publicnode.com', metaRegistry: '0xF98B45FA17DE75FB1aD0e7aFD971b0ca00e379fC', factories: ['0x6A8cbed756804B16E05E741eDaBd5cB544AE21bf', '0x98EE851a00abeE0d95D08cF4CA2BdCE32aeaAF7F', '0x0c0e5f2fF0ff18a3be9b835635039256dC4B4963'] },
  { chainId: 42161, name: 'Arbitrum', family: 'ng5', v1: 'arbitrum', rpc: 'https://arbitrum-one-rpc.publicnode.com', metaRegistry: '0x13526206545e2DC7CcfBaF28dC88F440ce7AD3e0', factories: ['0x9AF14D26075f142eb3F292D5065EB3faa646167b', '0x98EE851a00abeE0d95D08cF4CA2BdCE32aeaAF7F', '0xbC0797015fcFc47d9C1856639CaE50D0e69FbEE8'] },
  { chainId: 8453, name: 'Base', family: 'ng5', v1: 'base', rpc: 'https://base-rpc.publicnode.com', metaRegistry: '0x87DD13Dd25a1DBde0E1EdcF5B8Fa6cfff7eABCaD', factories: ['0xd2002373543Ce3527023C75e7518C274A51ce712', '0xc9Fe0C63Af9A39402e8a5514f9c43Af0322b665F', '0xA5961898870943c68037F6848d2D866Ed2016bcB'] },
  { chainId: 10, name: 'Optimism', family: 'ng5', v1: 'optimism', rpc: 'https://optimism-rpc.publicnode.com', metaRegistry: '0xc65CB3156225380BEda366610BaB18D5835A1647', factories: ['0x5eeE3091f747E60a045a2E715a4c71e600e31F6E', '0x98EE851a00abeE0d95D08cF4CA2BdCE32aeaAF7F', '0xc6C09471Ee39C7E30a067952FcC89c8922f9Ab53'] },
  { chainId: 137, name: 'Polygon', family: 'ng5', v1: 'polygon', rpc: 'https://polygon-bor-rpc.publicnode.com', metaRegistry: '0x296d2B5C23833A70D07c8fCBB97d846c1ff90DDD', factories: ['0x1764ee18e8B3ccA4787249Ceb249356192594585', '0x98EE851a00abeE0d95D08cF4CA2BdCE32aeaAF7F', '0xC1b393EfEF38140662b91441C6710Aa704973228'] },
  { chainId: 56, name: 'BSC', family: 'ng5', v1: 'bsc', rpc: 'https://bsc-rpc.publicnode.com', metaRegistry: '0x4C7A5A5D57F98D362f1c00D7135F0dA5B6f82227', factories: ['0xd7E72f3615aa65b92A4DBdC211E296a35512988B', '0x98EE851a00abeE0d95D08cF4CA2BdCE32aeaAF7F', '0x38f8D93406fA2d9924DcFcB67dB5B0521Fb20F7D'] },
  { chainId: 100, name: 'Gnosis', family: 'ng5', v1: 'xdai', rpc: 'https://gnosis-rpc.publicnode.com', metaRegistry: '0xb6265659d7e9FEccB59e076e949Da556FC5E1429', factories: ['0xbC0797015fcFc47d9C1856639CaE50D0e69FbEE8', '0x98EE851a00abeE0d95D08cF4CA2BdCE32aeaAF7F', '0xb47988aD49DCE8D909c6f9Cf7B26caF04e1445c8'] },
  { chainId: 43114, name: 'Avalanche', family: 'ng5', v1: 'avalanche', rpc: 'https://avalanche-c-chain-rpc.publicnode.com', metaRegistry: '0xB6845b562F01eB02ef20CBB63553d2a768e5a1Cb', factories: ['0x1764ee18e8B3ccA4787249Ceb249356192594585', '0x98EE851a00abeE0d95D08cF4CA2BdCE32aeaAF7F', '0x3d6cB2F6DcF47CDd9C13E4e3beAe9af041d8796a'] },
  { chainId: 146, name: 'Sonic', family: 'lite4', v1: 'sonic', rpc: 'https://rpc.soniclabs.com', metaRegistry: '0x1764ee18e8B3ccA4787249Ceb249356192594585', factories: ['0x7C2085419BE6a04f4ad88ea91bC9F5C6E6C463D8', '0x1A83348F9cCFD3Fe1A8C0adBa580Ac4e267Fe495', '0x635742dCC8313DCf8c904206037d962c042EAfBd'] },
  { chainId: 130, name: 'Unichain', family: 'lite4', v2: 'unichain', rpc: 'https://unichain-rpc.publicnode.com', archiveRpc: 'https://mainnet.unichain.org', metaRegistry: '0x5eeE3091f747E60a045a2E715a4c71e600e31F6E', factories: ['0x604388Bb1159AFd21eB5191cE22b4DeCdEE2Ae22', '0xc9Fe0C63Af9A39402e8a5514f9c43Af0322b665F', '0x5702BDB1Ec244704E3cBBaAE11a0275aE5b07499'] },
  { chainId: 5000, name: 'Mantle', family: 'lite4', v1: 'mantle', rpc: 'https://rpc.mantle.xyz', metaRegistry: '0x0c59d36b23f809f8b6C7cb4c8C590a0AC103baEf', factories: ['0x5eeE3091f747E60a045a2E715a4c71e600e31F6E', '0x98EE851a00abeE0d95D08cF4CA2BdCE32aeaAF7F', '0x0C9D8c7e486e822C29488Ff51BFf0167B4650953'] },
  { chainId: 143, name: 'Monad', family: 'lite4', v2: 'monad', rpc: 'https://rpc.monad.xyz', metaRegistry: '0xe6dA14500f0b5783E2325F9C5a7eE5d99DA0fB42', factories: ['0x8271e06E5887FE5ba05234f5315c19f3Ec90E8aD', '0xe7FBd704B938cB8fe26313C3464D4b7B7348c88C', '0x6E28493348446503db04A49621d8e6C9A40015FB'] },
  { chainId: 9745, name: 'Plasma', family: 'lite4', v2: 'plasma', rpc: 'https://rpc.plasma.to', metaRegistry: '0xe6dA14500f0b5783E2325F9C5a7eE5d99DA0fB42', factories: ['0x8271e06E5887FE5ba05234f5315c19f3Ec90E8aD', '0xe7FBd704B938cB8fe26313C3464D4b7B7348c88C', '0x6E28493348446503db04A49621d8e6C9A40015FB'] },
  { chainId: 999, name: 'HyperEVM', family: 'lite4', v1: 'hyperliquid', rpc: 'https://rpc.hyperliquid.xyz/evm', metaRegistry: '0x5eeE3091f747E60a045a2E715a4c71e600e31F6E', factories: ['0x604388Bb1159AFd21eB5191cE22b4DeCdEE2Ae22', '0xc9Fe0C63Af9A39402e8a5514f9c43Af0322b665F', '0x5702BDB1Ec244704E3cBBaAE11a0275aE5b07499'] },
  { chainId: 57073, name: 'Ink', family: 'lite4', v2: 'ink', rpc: 'https://rpc-gel.inkonchain.com', metaRegistry: '0x06452f9c013fc37169B57Eab8F50A7A48c9198A3', factories: ['0x046207cB759F527b6c10C2D61DBaca45513685CC', '0xd125E7a0cEddF89c6473412d85835450897be6Dc', '0x5Ea9DD3b6f042A34Df818C6c1324BC5A7c61427a'] },
  { chainId: 196, name: 'X Layer', family: 'lite4', v1: 'x-layer', rpc: 'https://rpc.xlayer.tech', metaRegistry: '0x87DD13Dd25a1DBde0E1EdcF5B8Fa6cfff7eABCaD', factories: ['0x5eeE3091f747E60a045a2E715a4c71e600e31F6E', '0x0c59d36b23f809f8b6C7cb4c8C590a0AC103baEf', '0xd3B17f862956464ae4403cCF829CE69199856e1e'] },
  { chainId: 4663, name: 'Robinhood', family: 'lite4', v2: 'robinhood', rpc: 'https://rpc.mainnet.chain.robinhood.com', metaRegistry: '0xe6dA14500f0b5783E2325F9C5a7eE5d99DA0fB42', factories: ['0x8271e06E5887FE5ba05234f5315c19f3Ec90E8aD', '0xe7FBd704B938cB8fe26313C3464D4b7B7348c88C', '0x6E28493348446503db04A49621d8e6C9A40015FB'] },
  { chainId: 98866, name: 'Plume', family: 'lite4', v2: 'plume', rpc: 'https://rpc.plume.org', metaRegistry: '0xB4c6A1e8A14e9Fe74c88b06275b747145DD41206', factories: ['0x5aEa9aaDd0974e8914229a23699bB6b343c97B09', '0xa17b39BF1c2FE776Af38a999bE7Bb7bEa737a6EC', '0x729c764aE95e7a9DEA9F950B5AEdbF1A9F3D7c03'] },
]

// ---------------------------------------------------------------------------------------------
// Hard excludes (CURVE-INTEGRATION.md §5.1–5.2), by address on any chain.
// ---------------------------------------------------------------------------------------------
export const HARD_EXCLUDE = new Map([
  // Real USDT + a fake 18-decimal "USDT" (0x810ecC2a…). Registered in MetaRegistry, returned by the stable-ng factory.
  ['0xa6d9f4f3a67b35e81dfa560b0fcde9b0751f1f53', 'fake USDT pool'],
  // Drained 2023-07-30 (Vyper 0.2.15–0.3.0 reentrancy lock, native ETH). Still registered; not in getHiddenPools.
  ['0xc4c319e2d4d66cca4464c0c2b32c9bd23ebe784e', 'alETH/ETH, drained 2023-07-30'],
  ['0x9848482da3ee3076165ce6497eda906e66bb85c5', 'pETH/ETH, drained 2023-07-30'],
  ['0xc897b98272aa23714464ea2a0bd5180f1b8c0025', 'msETH/ETH, drained 2023-07-30'],
  ['0x8301ae4fc9c624d1d396cbdaa1ed877821d7c511', 'CRV/ETH, drained 2023-07-30'],
])

// Tokens whose transfers move a different amount than asked (fee-on-transfer) or whose balances
// change on their own (rebasing). The router transfers the full amount in and quotes on balances,
// so these break `min_dy`. stETH is deliberately absent: its 1–2 wei rounding is the provider's call.
export const BAD_TOKENS = new Map([
  ['0xd46ba6d942050d489dbd938a2c909a5d5039a161', 'AMPL (rebasing)'],
  ['0x45804880de22913dafe09f4980848ece6ecbaf78', 'PAXG (fee on transfer)'],
  ['0x59d9356e565ab3a36dd77763fc0d87feaf85508c', 'USDM (rebasing)'],
])

// Stable-ng rate oracles (asset type 1) trusted beyond the default rule (the coin reports its own rate).
// Key: `${chainId}:${oracle}` lower-case. Empty on purpose; add one only after reading the oracle.
export const ORACLE_ALLOW = new Set([])

// ---------------------------------------------------------------------------------------------
// Keccak-256, EIP-55 and ABI words.
// ---------------------------------------------------------------------------------------------
// Node's OpenSSL has keccak-256 from 3.2 (Node 24); otherwise viem's (a dependency of this package).
const keccakBytes = await (async () => {
  try { createHash('keccak-256'); return (buf) => createHash('keccak-256').update(buf).digest() } catch { /* fall back */ }
  const { keccak256 } = await import('viem')
  return (buf) => Buffer.from(keccak256(buf, 'bytes'))
})()
export function keccakHex(hexOrUtf8, utf8 = false) {
  const buf = utf8 ? Buffer.from(hexOrUtf8, 'utf8') : Buffer.from(hexOrUtf8.replace(/^0x/, ''), 'hex')
  return '0x' + keccakBytes(buf).toString('hex')
}
if (keccakHex('', true) !== '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470') throw new Error('keccak-256 self-test failed')

export function checksum(address) {
  const a = address.toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(a)) throw new Error(`not an address: ${address}`)
  const h = keccakHex(a, true).slice(2)
  let out = '0x'
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i]
  return out
}
const lc = (a) => String(a).toLowerCase()
const sel = (sig) => keccakHex(sig, true).slice(0, 10)
const word = (v) => (typeof v === 'string' ? v.replace(/^0x/, '').toLowerCase() : v.toString(16)).padStart(64, '0')
const enc = (sig, ...args) => sel(sig) + args.map(word).join('')
const words = (hex) => { const h = (hex ?? '0x').replace(/^0x/, ''); const w = []; for (let i = 0; i + 64 <= h.length; i += 64) w.push(h.slice(i, i + 64)); return w }
const wordAddr = (w) => '0x' + w.slice(24)
const isAddrWord = (w) => /^0{24}[0-9a-f]{40}$/.test(w)
const decUint = (hex) => BigInt('0x' + (words(hex)[0] ?? '0'))
const decAddr = (hex) => { const w = words(hex)[0]; return w && isAddrWord(w) ? lc(wordAddr(w)) : null }
/** ABI-decoded `uint256[]`/`uint8[]` (a DynArray return): offset, length, items. */
const decUintArray = (hex) => { const w = words(hex); if (w.length < 2) return null; const off = Number(BigInt('0x' + w[0]) / 32n); const n = Number(BigInt('0x' + w[off])); if (n > 8 || off + 1 + n > w.length) return null; return w.slice(off + 1, off + 1 + n).map((x) => BigInt('0x' + x)) }

// ---------------------------------------------------------------------------------------------
// HTTP (Curve API, *.curve.finance only) and JSON-RPC (batched, retried, gentle).
// ---------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function assertCurveHost(url) {
  const { protocol, hostname } = new URL(url)
  if (protocol !== 'https:' || !(hostname === 'curve.finance' || hostname.endsWith('.curve.finance'))) throw new Error(`refusing non-curve.finance URL: ${url}`)
}

async function getJson(url) {
  assertCurveHost(url)
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(60_000) })
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`)
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${url}`), { fatal: true })
      return await r.json()
    } catch (e) {
      if (e.fatal || attempt >= 4) throw e
      await sleep(1000 * 2 ** attempt)
    }
  }
}

const REVERT = /revert|invalid opcode|out of gas|execution aborted|stack underflow|invalid jump/i
const NO_STATE = /archive|missing trie|no state|historical state|header not found|block not found|state.*not available|pruned/i

class Rpc {
  constructor(url, label) { this.url = url; this.label = label; this.batch = 25; this.requests = 0 }
  async post(body) {
    for (let attempt = 0; ; attempt++) {
      try {
        this.requests++
        const r = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) })
        if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`)
        const text = await r.text()
        let json
        try { json = JSON.parse(text) } catch { throw new Error(`bad JSON from ${this.label}: ${text.slice(0, 80)}`) }
        if (!Array.isArray(body)) return json
        if (!Array.isArray(json)) {
          // No batch support (or a batch-level error): fall back to one request per call.
          if (this.batch > 1) { this.batch = 1; return this.singles(body) }
          throw new Error(`batch refused by ${this.label}: ${JSON.stringify(json).slice(0, 120)}`)
        }
        return json
      } catch (e) {
        if (attempt >= 6) throw new Error(`${this.label}: ${e.message}`)
        await sleep(2000 * 2 ** attempt)
      }
    }
  }
  async singles(body) { const out = []; for (const b of body) { out.push(await this.post(b)); await sleep(40) } return out }
  /** Runs [method, params] calls; each result is {ok, value} or {ok:false, revert, noState, message}. Transport errors retry, then throw. */
  async run(calls) {
    const results = new Array(calls.length)
    let pending = calls.map((c, i) => i)
    for (let round = 0; pending.length && round < 5; round++) {
      const retry = []
      for (let s = 0; s < pending.length; s += this.batch) {
        const idx = pending.slice(s, s + this.batch)
        const body = idx.map((i) => ({ jsonrpc: '2.0', id: i, method: calls[i][0], params: calls[i][1] }))
        const res = this.batch === 1 ? [await this.post(body[0])] : await this.post(body)
        const byId = new Map(res.map((x) => [Number(x.id), x]))
        for (const i of idx) {
          const x = byId.get(i)
          if (x && 'result' in x) { results[i] = { ok: true, value: x.result }; continue }
          const message = x?.error ? `${x.error.message ?? ''} ${typeof x.error.data === 'string' ? x.error.data : ''}` : 'missing response'
          if (x?.error && (REVERT.test(message) || x.error.code === 3)) results[i] = { ok: false, revert: true, message }
          else if (x?.error && NO_STATE.test(message)) results[i] = { ok: false, noState: true, message }
          else retry.push(i)
        }
        await sleep(120)
      }
      pending = retry
      if (pending.length) await sleep(1500 * (round + 1))
    }
    if (pending.length) throw new Error(`${this.label}: ${pending.length} calls failed after retries (${calls[pending[0]][0]})`)
    return results
  }
}

// ---------------------------------------------------------------------------------------------
// Discovery: normalise both API generations into one shape.
// ---------------------------------------------------------------------------------------------
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))
const cleanName = (s) => String(s ?? '').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().slice(0, 64) || 'Curve pool'

/** api.curve.finance/v1 getPools/all/<slug> row → normalised pool. */
export function fromV1(p) {
  const coins = (p.coins ?? []).map((c) => ({ address: lc(c.address), decimals: num(c.decimals), usdPrice: num(c.usdPrice), symbol: c.symbol ?? '' }))
  const und = Array.isArray(p.underlyingCoins) ? p.underlyingCoins.map((c) => ({ address: lc(c.address), decimals: num(c.decimals), usdPrice: num(c.usdPrice), symbol: c.symbol ?? '' })) : null
  return {
    id: p.id, address: lc(p.address), name: cleanName(p.name), registry: p.registryId, implementation: p.implementation ?? '',
    factory: typeof p.factory === 'string' ? lc(p.factory) : null, coins, underlying: und, isMeta: !!p.isMetaPool, basePool: p.basePoolAddress ? lc(p.basePoolAddress) : null,
    isBroken: !!p.isBroken, tvlApi: num(p.usdTotal) ?? 0, createdAt: num(p.creationTs) > 0 ? num(p.creationTs) : null, createdBlock: num(p.creationBlockNumber) > 0 ? num(p.creationBlockNumber) : null,
  }
}

/** api2.curve.finance get_pools/<chainId> row → normalised pool. Registry ids use `_`; v1 uses `-`. */
export function fromV2(p) {
  const coins = (p.coins ?? []).map((c) => ({ address: lc(c.address), decimals: num(c.decimals), usdPrice: num(c.usd_price), symbol: c.symbol ?? '' }))
  return {
    id: String(p.id ?? '').replace(/_/g, '-'), address: lc(p.address), name: cleanName(p.name), registry: String(p.registry_id ?? '').replace(/_/g, '-'),
    implementation: p.implementation_address ? lc(p.implementation_address) : '', factory: null, coins, underlying: null,
    isMeta: !!p.is_meta_pool, basePool: p.base_pool ? lc(p.base_pool) : null, isBroken: !!p.is_broken, tvlApi: num(p.tvl) ?? 0, createdAt: null, createdBlock: null,
  }
}

async function discover(chain, hidden) {
  if (chain.v1) {
    const j = await getJson(`https://api.curve.finance/v1/getPools/all/${chain.v1}`)
    if (!Array.isArray(j?.data?.poolData)) throw new Error(`no poolData for ${chain.v1}`)
    return { pools: dedupe(j.data.poolData.map(fromV1)), hidden: new Set(hidden[chain.v1] ?? []) }
  }
  const j = await getJson(`https://api2.curve.finance/get_pools/${chain.chainId}`)
  const rows = Array.isArray(j?.data?.pool_data) ? j.data.pool_data : null
  if (!rows) throw new Error(`no pools for ${chain.chainId} on api2`)
  return { pools: dedupe(rows.map(fromV2)), hidden: new Set(hidden[chain.v2] ?? []) }
}

// ---------------------------------------------------------------------------------------------
// Pure rules (unit-tested in build-allowlist.test.mjs).
// ---------------------------------------------------------------------------------------------
export const tvlThreshold = (chainId) => (chainId === 1 ? TVL_MIN_ETHEREUM : TVL_MIN_OTHER)
export const capFor = (chainId) => (chainId === 1 ? CAP_ETHEREUM : CAP_OTHER)

/** Router NG `pool_type` for an API registry id, or null (LLAMMA, unknown families). */
export function routerPoolType(registry, nCoins) {
  switch (registry) {
    case 'main': case 'factory': case 'factory-crvusd': return 1
    case 'factory-stable-ng': return 10
    case 'crypto': return nCoins === 2 ? 2 : nCoins === 3 ? 3 : null
    case 'factory-crypto': return nCoins === 2 ? 2 : null
    case 'factory-twocrypto': return 20
    case 'factory-tricrypto': return 30
    default: return null
  }
}
/** Stable pools take int128 indices; crypto pools uint256. */
export const isStableType = (poolType) => poolType === 1 || poolType === 10

/**
 * Pre-NG pools that send native ETH and may be compiled with Vyper 0.2.15–0.3.0 (broken reentrancy lock,
 * 2023-07-30): factory-v2 `plain2eth*` pools (the drained alETH/pETH/msETH family) and main-registry crypto
 * pools holding WETH created from 2021-07 (0.2.15) until the fix, except the two known to be built with an
 * unaffected compiler. Their state can be drained mid-route; never route into them.
 */
export const VYPER_SAFE_CRYPTO = new Map([
  ['0xd51a44d3fae010294c616388b506acda1bfaae46', 'tricrypto2, Vyper 0.2.12'],
  ['0xb576491f1e6e5e62f1d8f26062ee822b40b0e0d4', 'CVX/ETH, Vyper 0.3.1'],
])
export function vyperEthRisk(p, weth) {
  const hasEth = p.coins.some((c) => c.address === lc(ETH))
  if (p.registry === 'factory' && hasEth && /^plain2eth/.test(p.implementation)) return true
  if (p.registry === 'crypto' && weth && p.coins.some((c) => c.address === lc(weth)) && !VYPER_SAFE_CRYPTO.has(p.address)) {
    const t = p.createdAt
    return t === null || (t >= Date.UTC(2021, 6, 1) / 1000 && t < Date.UTC(2023, 7, 1) / 1000)
  }
  return false
}

/** One row per pool address (the API lists some pools under two registries): the first wins. */
export function dedupe(pools) {
  const seen = new Set()
  return pools.filter((p) => (seen.has(p.address) ? false : (seen.add(p.address), true)))
}

/** The API-only filters, in order. Returns survivors and a reason per dropped address. */
export function staticFilters(pools, { chainId, hidden, weth }) {
  const dropped = new Map()
  const stage = {}
  const threshold = tvlThreshold(chainId)
  const rules = [
    ['hard-exclude', (p) => HARD_EXCLUDE.has(p.address)],
    ['hidden', (p) => hidden.has(p.id)],
    ['broken', (p) => p.isBroken],
    ['unsupported-type', (p) => routerPoolType(p.registry, p.coins.length) === null],
    ['lt-2-coins', (p) => p.coins.length < 2],
    ['tvl', (p) => !(p.tvlApi >= threshold)],
    ['bad-token', (p) => [...p.coins, ...(p.underlying ?? [])].some((c) => BAD_TOKENS.has(c.address))],
    ['vyper-eth', (p) => vyperEthRisk(p, weth)],
  ]
  let kept = pools
  for (const [reason, test] of rules) {
    kept = kept.filter((p) => { if (!test(p)) return true; dropped.set(p.address, reason); return false })
    stage[reason] = kept.length
  }
  return { kept, dropped, stage }
}

/** On-chain `coins(i)` must equal the API's, by address and order. */
export function coinsMatch(apiCoins, chainCoins) {
  return apiCoins.length === chainCoins.length && apiCoins.every((c, i) => lc(c) === lc(chainCoins[i]))
}

/**
 * Stable-ng asset types: 0 plain, 1 rate oracle, 2 rebasing, 3 ERC-4626. 2 and 3 are refused; 1 is kept
 * only when the oracle is the coin itself (wstETH-style self-reported rate) or explicitly allowed.
 * `oracles[i]` is the oracle address for coin i (the zero address: none set), or null when it could not be read.
 */
export function assetTypeDecision(types, coins, oracles, chainId) {
  if (!types || types.length !== coins.length) return 'asset-types-unreadable'
  for (let i = 0; i < types.length; i++) {
    const t = types[i]
    if (t === 0) continue
    if (t === 2) return 'asset-type-2-rebasing'
    if (t === 3) return 'asset-type-3-erc4626'
    if (t !== 1) return 'asset-type-unknown'
    const o = oracles?.[i]
    if (!o) return 'asset-type-1-oracle-unreadable'
    if (o === ZERO) continue // type 1 without an oracle: the pool uses its fixed rate multiplier
    if (lc(o) !== lc(coins[i]) && !ORACLE_ALLOW.has(`${chainId}:${lc(o)}`)) return 'asset-type-1-foreign-oracle'
  }
  return null
}

/** Age rule: >= 30 days; unknown age is kept only with TVL >= 2x the chain threshold. */
export function ageDecision(createdAt, tvlUsd, chainId, nowSec) {
  if (createdAt === null || createdAt === undefined) return tvlUsd >= 2 * tvlThreshold(chainId) ? null : 'age-unknown'
  return nowSec - createdAt >= MIN_AGE_DAYS * DAY ? null : 'too-young'
}

/** Deterministic order (TVL desc, then address) and the per-chain cap. */
export function rankAndCap(pools, chainId) {
  const sorted = [...pools].sort((a, b) => b.tvlUsd - a.tvlUsd || (lc(a.address) < lc(b.address) ? -1 : 1))
  const cap = capFor(chainId)
  return { kept: sorted.slice(0, cap), cut: sorted.slice(cap) }
}

/** USD value of on-chain balances with API prices, whole dollars, bigint math (no Number(bigint) on amounts). */
export function usdOf(balances, decimals, prices) {
  let micro = 0n
  for (let i = 0; i < balances.length; i++) {
    const p = prices[i]
    if (!(p > 0) || !Number.isFinite(p)) continue
    micro += (balances[i] * BigInt(Math.round(p * 1e6))) / 10n ** BigInt(decimals[i])
  }
  const dollars = micro / 1_000_000n
  return dollars > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(dollars) // eslint-disable-line anywalletkit/no-number-bigint -- clamped above
}

/** Anchored TVL (see verifyOnChain step 9): whole dollars, never above the full on-chain value or the API's. */
export function anchoredTvl(balances, decimals, prices, anchorFlags, apiTvl) {
  const nA = anchorFlags.filter(Boolean).length
  if (!nA) return 0
  const pick = (xs) => xs.filter((_, i) => anchorFlags[i])
  const anchored = usdOf(pick(balances), pick(decimals), pick(prices))
  const estimate = Math.floor((anchored * balances.length) / nA)
  return Math.floor(Math.min(estimate, usdOf(balances, decimals, prices), apiTvl))
}

/** Probe amount for get_dy: about $100 of coin i, or 1/1000 of a unit without a price. */
export function probeAmount(decimals, usdPrice) {
  const unit = 10n ** BigInt(decimals)
  if (!(usdPrice > 0) || !Number.isFinite(usdPrice)) return unit / 1000n > 0n ? unit / 1000n : 1n
  const a = (unit * 100n * 1_000_000n) / BigInt(Math.max(1, Math.round(usdPrice * 1e6)))
  return a > 0n ? a : 1n
}

// ---------------------------------------------------------------------------------------------
// Stable-ng immutables. Asset types of metapools and every rate oracle are not public; Vyper 0.3.10
// appends immutables to the runtime code, 32-byte words in declaration order, aligned to the end:
//   plain (CurveStableSwapNG):     … factory, coins[9], asset_types[9], [contains_rebasing], rate_multipliers[9], rate_oracles[9], …
//   meta  (CurveStableSwapMetaNG): … math, factory, coins[9], asset_type, contains_rebasing, rate_multiplier, rate_oracle, …
// (DynArray[x, 8] = length word + 8 slots; a rate oracle word = method_id << 224 | oracle.) Located by the
// coins array, anchored on the factory word before it and cross-checked; anything off → null (refused).
// ---------------------------------------------------------------------------------------------
const tailWords = (code) => { const h = (code ?? '0x').replace(/^0x/, ''); return words('0x' + h.slice(h.length % 64)) }
const oracleOf = (v) => (v ? lc('0x' + v.slice(24)) : null)

/** Plain stable-ng pool: rate oracle per coin (null = none), or null when the layout does not check out. */
export function ngPlainOracles(code, coins, types, factories) {
  const w = tailWords(code)
  const n = BigInt(coins.length)
  const target = coins.map((c) => word(lc(c)))
  for (let p = w.length - 1; p > 0; p--) {
    if (w[p] !== word(n) || !target.every((t, i) => w[p + 1 + i] === t)) continue
    if (!factories.has(lc(wordAddr(w[p - 1])))) continue
    const at = p + 9
    if (w[at] !== word(n) || !types.every((t, i) => w[at + 1 + i] === word(BigInt(t)))) continue
    // rate_multipliers follow, after pool_contains_rebasing_tokens (absent in the first stable-ng release).
    for (const rm of [at + 10, at + 9]) {
      if (w[rm] !== word(n) || !coins.every((_, i) => /^0*1(0)*$/.test(BigInt('0x' + (w[rm + 1 + i] ?? '0')).toString()))) continue
      if (w[rm + 9] !== word(n)) continue
      return coins.map((_, i) => oracleOf(w[rm + 10 + i]))
    }
  }
  return null
}

/** Stable-ng metapool: {types: [asset_type, 0], oracles: [oracle | null, null]}, or null. */
export function ngMetaTypes(code, coins, factories) {
  const w = tailWords(code)
  if (coins.length !== 2) return null
  const target = coins.map((c) => word(lc(c)))
  for (let p = w.length - 1; p > 0; p--) {
    if (w[p] !== word(2n) || !target.every((t, i) => w[p + 1 + i] === t)) continue
    if (!factories.has(lc(wordAddr(w[p - 1])))) continue
    const t = BigInt('0x' + (w[p + 9] ?? 'f'))
    if (t > 3n) continue
    return { types: [Number(t), 0], oracles: [oracleOf(w[p + 12]), null] } // eslint-disable-line anywalletkit/no-number-bigint -- uint8 <= 3
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// On-chain verification at one block.
// ---------------------------------------------------------------------------------------------
class Chain {
  constructor(cfg) {
    this.cfg = cfg
    this.rpc = new Rpc(process.env[`CURVE_RPC_${cfg.chainId}`] || cfg.rpc, `rpc ${cfg.chainId}`)
    this.archive = cfg.archiveRpc ? new Rpc(cfg.archiveRpc, `archive rpc ${cfg.chainId}`) : this.rpc
    this.block = null
    this.decimals = new Map()
    this.anchors = new Set()
  }
  get tag() { return '0x' + this.block.toString(16) }
  async pin() {
    const [head] = await this.rpc.run([['eth_blockNumber', []]])
    this.block = Number(BigInt(head.value)) - 3
    const [b] = await this.rpc.run([['eth_getBlockByNumber', [this.tag, false]]])
    this.blockTime = Number(BigInt(b.value.timestamp))
  }
  calls(list) { return this.rpc.run(list.map(([to, data]) => ['eth_call', [{ to, data }, this.tag]])) }
  async mustNotNoState(results) { if (results.some((r) => r.noState)) throw Object.assign(new Error('state at pinned block gone'), { noState: true }) }
  async tokenDecimals(addresses) {
    const need = [...new Set(addresses.map(lc))].filter((a) => !this.decimals.has(a))
    const erc = need.filter((a) => a !== lc(ETH))
    for (const a of need) if (a === lc(ETH)) this.decimals.set(a, 18)
    const res = await this.calls(erc.map((a) => [a, enc('decimals()')]))
    await this.mustNotNoState(res)
    erc.forEach((a, i) => { const r = res[i]; const d = r.ok && words(r.value).length ? decUint(r.value) : null; this.decimals.set(a, d !== null && d <= 36n ? Number(d) : null) })
    return addresses.map((a) => this.decimals.get(lc(a)))
  }
}

/** Reads coins(i) for i = 0..7 until revert, trying uint256 then int128 indices (old pools). */
async function readCoins(chain, pools, fn = 'coins') {
  const out = new Map()
  for (const variant of [`${fn}(uint256)`, `${fn}(int128)`]) {
    const todo = pools.filter((p) => !out.has(p.address))
    if (!todo.length) break
    const res = await chain.calls(todo.flatMap((p) => Array.from({ length: 8 }, (_, i) => [p.address, enc(variant, BigInt(i))])))
    await chain.mustNotNoState(res)
    todo.forEach((p, k) => {
      const list = []
      for (let i = 0; i < 8; i++) { const r = res[k * 8 + i]; const a = r.ok ? decAddr(r.value) : null; if (!a || a === ZERO) break; list.push(a) }
      if (list.length) out.set(p.address, { coins: list, int128: variant.includes('int128') })
    })
  }
  return out
}

async function verifyOnChain(chain, pools, drop) {
  const cfg = chain.cfg
  // Registry contracts must exist at the pinned block.
  const regCode = await chain.rpc.run([cfg.metaRegistry, ...cfg.factories].map((a) => ['eth_getCode', [a, chain.tag]]))
  await chain.mustNotNoState(regCode)
  const metaRegistryOk = regCode[0].ok && regCode[0].value.length > 2
  const factories = new Set(cfg.factories.filter((_, i) => regCode[i + 1].ok && regCode[i + 1].value.length > 2).map(lc))

  // 1. coins(i) == API coins.
  const coinMap = await readCoins(chain, pools)
  let live = pools.filter((p) => {
    const c = coinMap.get(p.address)
    if (!c) return drop(p, 'coins-unreadable')
    if (!coinsMatch(p.coins.map((x) => x.address), c.coins)) return drop(p, 'coin-mismatch')
    p.int128 = c.int128
    return true
  })

  // 2. Code hash (non-empty).
  const codes = await chain.rpc.run(live.map((p) => ['eth_getCode', [p.address, chain.tag]]))
  await chain.mustNotNoState(codes)
  live = live.filter((p, i) => { const r = codes[i]; if (!r.ok || r.value.length <= 2) return drop(p, 'no-code'); p.code = r.value; p.codeHash = keccakHex(r.value); return true })

  // 3. Registration: MetaRegistry.is_registered, else an NG factory listed for this chain that knows the pool.
  const reg = metaRegistryOk ? await chain.calls(live.map((p) => [cfg.metaRegistry, enc('is_registered(address)', p.address)])) : live.map(() => ({ ok: false }))
  await chain.mustNotNoState(reg)
  const viaFactory = live.filter((p, i) => !(reg[i].ok && decUint(reg[i].value) === 1n))
  const fres = await chain.calls(viaFactory.flatMap((p) => [...factories].map((f) => [f, enc('get_coins(address)', p.address)])))
  await chain.mustNotNoState(fres)
  const factoryOf = new Map()
  viaFactory.forEach((p, k) => {
    [...factories].forEach((f, j) => {
      const r = fres[k * factories.size + j]
      if (!r.ok) return
      const ws = new Set(words(r.value))
      if (p.coins.every((c) => ws.has(word(c.address)))) factoryOf.set(p.address, f)
    })
  })
  live = live.filter((p, i) => {
    if (reg[i].ok && decUint(reg[i].value) === 1n) { p.registeredVia = 'meta-registry'; return true }
    if (factoryOf.has(p.address)) { p.registeredVia = 'factory'; p.ngFactory = factoryOf.get(p.address); return true }
    return drop(p, 'not-registered')
  })

  // 4. Decimals per coin (native = 18).
  for (const p of live) p.chainDecimals = null
  const allDec = await chain.tokenDecimals(live.flatMap((p) => p.coins.map((c) => c.address)))
  let at = 0
  live = live.filter((p) => {
    const d = allDec.slice(at, at + p.coins.length); at += p.coins.length
    if (d.some((x) => x === null)) return drop(p, 'decimals-unreadable')
    p.chainDecimals = d
    return true
  })

  // 5. balances(i) > 0 for every coin (same index type as coins()).
  const bres = await chain.calls(live.flatMap((p) => p.coins.map((_, i) => [p.address, enc(p.int128 ? 'balances(int128)' : 'balances(uint256)', BigInt(i))])))
  await chain.mustNotNoState(bres)
  at = 0
  live = live.filter((p) => {
    const rs = bres.slice(at, at + p.coins.length); at += p.coins.length
    if (rs.some((r) => !r.ok)) return drop(p, 'balances-unreadable')
    p.balances = rs.map((r) => decUint(r.value))
    if (p.balances.some((b) => b === 0n)) return drop(p, 'zero-balance')
    return true
  })

  // 6. Router pool type and a get_dy(0, 1, ~$100) with the index type the router will use.
  for (const p of live) p.poolType = routerPoolType(p.registry, p.coins.length)
  const dres = await chain.calls(live.map((p) => [p.address, enc(isStableType(p.poolType) ? 'get_dy(int128,int128,uint256)' : 'get_dy(uint256,uint256,uint256)', 0n, 1n, probeAmount(p.chainDecimals[0], p.coins[0].usdPrice))]))
  await chain.mustNotNoState(dres)
  live = live.filter((p, i) => (dres[i].ok && decUint(dres[i].value) > 0n ? true : drop(p, 'get-dy-failed')))

  // 7. Stable-ng asset types (factory) and rate oracles (pool immutables).
  const ng = live.filter((p) => p.poolType === 10)
  const typeRes = await chain.calls(ng.flatMap((p) => [[p.ngFactory ?? p.factory ?? cfg.factories[0], enc('get_pool_asset_types(address)', p.address)], [p.address, enc('stored_rates()')]]))
  await chain.mustNotNoState(typeRes)
  const ngBad = new Map()
  const ngFactories = new Set([...factories, ...ng.map((p) => p.factory).filter(Boolean)])
  ng.forEach((p, i) => {
    const coins = p.coins.map((c) => c.address)
    const tr = typeRes[2 * i]
    const rates = typeRes[2 * i + 1].ok ? decUintArray(typeRes[2 * i + 1].value) : null
    let types = tr.ok ? decUintArray(tr.value)?.map((x) => Number(x)) ?? null : null // eslint-disable-line anywalletkit/no-number-bigint -- uint8
    let oracles = null
    if (types && types.length === coins.length) oracles = types.includes(1) ? ngPlainOracles(p.code, coins, types, ngFactories) : []
    else { const m = ngMetaTypes(p.code, coins, ngFactories); if (m) { types = m.types; oracles = m.oracles } }
    // "No oracle" must agree with the pool: a type-1 coin without one reports its fixed multiplier, 10^(36 - decimals).
    if (oracles && types) {
      oracles = oracles.map((o, k) => (types[k] === 1 && o === ZERO && rates?.[k] !== 10n ** BigInt(36 - p.chainDecimals[k]) ? null : o))
    }
    const why = assetTypeDecision(types, coins, oracles, cfg.chainId)
    if (why) ngBad.set(p.address, [why, why.includes('foreign') ? `oracles ${oracles.filter((o) => o && o !== ZERO).map(checksum).join(', ')}` : ''])
  })
  live = live.filter((p) => (ngBad.has(p.address) ? drop(p, ...ngBad.get(p.address)) : true))

  // 8. Underlying coins (stable metapools and lending pools) → swap_type 2, checked with get_dy_underlying.
  await verifyUnderlying(chain, live.filter((p) => isStableType(p.poolType) && (p.isMeta || p.registry === 'main' || (p.underlying && !coinsMatch(p.underlying.map((c) => c.address), p.coins.map((c) => c.address))))), drop)
  live = live.filter((p) => !p.dropped)

  // 9. TVL. API prices are not trusted on their own (a pool of two thinly traded tokens can "hold" billions), so
  // only anchor coins count: the SDK catalog's tokens on this chain, native, Curve's crvUSD/CRV. A metapool's
  // base LP counts when every base coin is an anchor; a lending pool's wrapped coin when its underlying is one.
  // The pool's figure is anchored value x n / anchored coins, capped by the full on-chain and the API's value.
  live = live.filter((p) => {
    const n = p.coins.length
    const flags = p.coins.map((c, i) => chain.anchors.has(c.address) || (p.lending && p.underlyingOk && chain.anchors.has(lc(p.chainUnderlying[i]))))
    if (p.isMeta && p.underlyingOk) flags[n - 1] = p.chainUnderlying.slice(n - 1).every((a) => chain.anchors.has(lc(a)))
    p.tvlUsd = anchoredTvl(p.balances, p.chainDecimals, p.coins.map((c) => c.usdPrice), flags, p.tvlApi)
    return p.tvlUsd >= tvlThreshold(cfg.chainId) ? true : drop(p, flags.some(Boolean) ? 'tvl-onchain' : 'no-anchor-coin')
  })
  return live
}

async function verifyUnderlying(chain, pools, drop) {
  if (!pools.length) return
  const cfg = chain.cfg
  // Metapools: base pool from the pool (base_pool() / BASE_POOL()), else from MetaRegistry; must match the API's.
  const metas = pools.filter((p) => p.isMeta)
  const bp = await chain.calls(metas.flatMap((p) => [[p.address, enc('base_pool()')], [p.address, enc('BASE_POOL()')], [cfg.metaRegistry, enc('get_base_pool(address)', p.address)]]))
  await chain.mustNotNoState(bp)
  metas.forEach((p, k) => { const r = [bp[3 * k], bp[3 * k + 1], bp[3 * k + 2]].find((x) => x.ok && decAddr(x.value) && decAddr(x.value) !== ZERO); p.chainBase = r ? decAddr(r.value) : null })
  const baseCoins = await readCoins(chain, [...new Set(metas.map((p) => p.chainBase).filter(Boolean))].map((address) => ({ address })))
  for (const p of metas) {
    const base = p.chainBase && baseCoins.get(p.chainBase)
    if (!base) { p.underlyingNote = 'base-pool-unreadable'; continue }
    if (p.basePool && p.basePool !== p.chainBase) { p.underlyingNote = 'base-pool-mismatch'; continue }
    p.chainUnderlying = [...p.coins.slice(0, -1).map((c) => c.address), ...base.coins]
  }
  // Lending pools (old main-registry pools over aTokens/cTokens/yTokens): underlying_coins(i) differs from coins(i).
  const lend = pools.filter((p) => !p.isMeta)
  const lendCoins = await readCoins(chain, lend, 'underlying_coins')
  for (const p of lend) {
    const und = lendCoins.get(p.address)?.coins
    if (!und || coinsMatch(und, p.coins.map((c) => c.address))) continue // a plain pool
    p.lending = true
    p.chainUnderlying = und
  }
  for (const p of pools) {
    if (p.chainUnderlying && p.underlying && !coinsMatch(p.underlying.map((c) => c.address), p.chainUnderlying)) { p.underlyingNote = 'underlying-mismatch'; p.chainUnderlying = null }
  }
  const withU = pools.filter((p) => p.chainUnderlying)
  const ud = await chain.tokenDecimals(withU.flatMap((p) => p.chainUnderlying))
  let at = 0
  for (const p of withU) { p.chainUnderlyingDecimals = ud.slice(at, at + p.chainUnderlying.length); at += p.chainUnderlying.length }
  const ok = withU.filter((p) => p.chainUnderlyingDecimals.every((d) => d !== null))
  const price0 = (p) => p.underlying?.[0]?.usdPrice ?? p.coins[0].usdPrice
  const res = await chain.calls(ok.map((p) => [p.address, enc('get_dy_underlying(int128,int128,uint256)', 0n, BigInt(p.chainUnderlying.length - 1), probeAmount(p.chainUnderlyingDecimals[0], price0(p)))]))
  await chain.mustNotNoState(res)
  ok.forEach((p, i) => { if (res[i].ok && decUint(res[i].value) > 0n) p.underlyingOk = true; else p.underlyingNote = 'get-dy-underlying-failed' })
  for (const p of pools) {
    if (p.underlyingOk || !p.lending && !p.underlyingNote) continue
    // A lending pool's own coins are wrapped (aTokens rebase): without a working underlying route it is refused.
    if (p.lending || p.underlyingNote === 'underlying-mismatch' && !p.isMeta) { p.dropped = true; drop(p, p.underlyingNote ?? 'underlying-unusable') }
  }
}

// Creation time: the API's when it has one; otherwise the first block where the pool's nonce is non-zero
// (contracts start at nonce 1), found by binary search on an archive-capable RPC. Unknown when there is none.
async function creationTimes(chain, pools) {
  const need = pools.filter((p) => p.createdAt === null)
  if (!need.length) return
  const rpc = chain.archive
  const probe = await rpc.run([['eth_getTransactionCount', [need[0].address, '0x1']]])
  if (!probe[0].ok) { console.error(`  ${chain.cfg.name}: no archive state, ${need.length} pool age(s) unknown`); return }
  const lo = new Map(need.map((p) => [p.address, 0]))
  const hi = new Map(need.map((p) => [p.address, chain.block]))
  const failed = new Set()
  for (let round = 0; round < 40; round++) {
    const active = need.filter((p) => !failed.has(p.address) && hi.get(p.address) - lo.get(p.address) > 1)
    if (!active.length) break
    const mids = active.map((p) => Math.floor((lo.get(p.address) + hi.get(p.address)) / 2))
    const res = await rpc.run(active.map((p, i) => ['eth_getTransactionCount', [p.address, '0x' + mids[i].toString(16)]]))
    active.forEach((p, i) => {
      const r = res[i]
      if (!r.ok) { failed.add(p.address); return }
      if (BigInt(r.value) > 0n) hi.set(p.address, mids[i]); else lo.set(p.address, mids[i])
    })
  }
  const found = need.filter((p) => !failed.has(p.address))
  const blocks = await rpc.run(found.map((p) => ['eth_getBlockByNumber', ['0x' + hi.get(p.address).toString(16), false]]))
  found.forEach((p, i) => { if (blocks[i].ok && blocks[i].value) { p.createdAt = Number(BigInt(blocks[i].value.timestamp)); p.createdBlock = hi.get(p.address) } })
}

// ---------------------------------------------------------------------------------------------
// Anchors for TVL: the SDK catalog (@anywalletkit/swap2-assets: built package, else its TypeScript source,
// which Node 22.18+ loads natively) plus Curve's own crvUSD and CRV (deployments.json `tokens`).
// ---------------------------------------------------------------------------------------------
export const CURVE_TOKENS = {
  1: ['0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E', '0xD533a949740bb3306d119CC777fa900bA034cd52'],
  42161: ['0x498Bf2B1e120FeD3ad3D42EA2165E9b73f99C1e5', '0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978'],
  8453: ['0x417Ac0e078398C154EdFadD9Ef675d30Be60Af93', '0x8Ee73c484A26e0A5df2Ee2a4960B789967dd0415'],
  10: ['0xc52d7f23a2e460248db6ee192cb23dd12bddcbf6', '0x0994206dfE8De6Ec6920FF4D779B0d950605Fb53'],
  137: ['0xc4Ce1D6F5D98D65eE25Cf85e9F2E9DcFEe6Cb5d6', '0x172370d5Cd63279eFa6d502DAB29171933a610AF'],
  56: ['0xe2fb3F127f5450DeE44afe054385d74C392BdeF4', '0x9996D0276612d23b35f90C51EE935520B3d7355B'],
  100: ['0xaBEf652195F98A91E490f047A5006B71c85f058d', '0x712b3d230F3C1c19db860d80619288b1F0BDd0Bd'],
  43114: ['0xCb7c161602d04C4e8aF1832046EE08AAF96d855D', '0xEEbC562d445F4bC13aC75c8caABb438DFae42A1B'],
  146: ['0x7FFf4C4a827C84E32c5E175052834111B2ccd270', '0x5af79133999f7908953e94b7a5cf367740ebee35'],
  5000: ['0x0994206dfe8de6ec6920ff4d779b0d950605fb53', '0xE265FC71d45fd791c9ebf3EE0a53FBB220Eb8f75'],
  57073: ['0x39fec550CC6DDCEd810eCCfA9B2931b4B5f2344D', '0xAC73671a1762FE835208Fb93b7aE7490d1c2cCb3'],
  196: ['0xda8f4eb4503acf5dec5420523637bb5b33a846f6', '0x3d5320821bfca19fb0b5428f2c79d63bd5246f89'],
}

async function loadCatalog() {
  for (const spec of ['@anywalletkit/swap2-assets', new URL('../../swap2-assets/src/index.ts', import.meta.url).href]) {
    try { const m = await import(spec); if (typeof m.ccChain === 'function') return m } catch { /* next */ }
  }
  throw new Error('swap2-assets catalog not loadable: build packages/swap2-assets or use Node >= 22.18')
}

export function anchorsFor(chainId, catalog) {
  const set = new Set([lc(ETH), ...(CURVE_TOKENS[chainId] ?? []).map(lc)])
  for (const a of catalog.ccChain(`eip155:${chainId}`)?.assets ?? []) set.add(a.contract ? lc(a.contract) : lc(ETH))
  return set
}

// ---------------------------------------------------------------------------------------------
// Output.
// ---------------------------------------------------------------------------------------------
const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

export function toEntry(p) {
  const e = {
    address: checksum(p.address), name: p.name, coins: p.coins.map((c) => (c.address === lc(ETH) ? ETH : checksum(c.address))), decimals: p.chainDecimals,
    poolType: p.poolType, swapTypes: [1], codeHash: p.codeHash, tvlUsd: p.tvlUsd,
  }
  if (p.underlyingOk) {
    e.underlying = p.chainUnderlying.map((a) => (a === lc(ETH) ? ETH : checksum(a)))
    e.underlyingDecimals = p.chainUnderlyingDecimals
    e.swapTypes = p.lending ? [2] : [1, 2]
  }
  if (p.createdAt) e.createdAt = p.createdAt
  return e
}

function renderEntry(e) {
  const parts = [`address: ${q(e.address)}`, `name: ${q(e.name)}`, `coins: [${e.coins.map(q).join(', ')}]`, `decimals: [${e.decimals.join(', ')}]`]
  if (e.underlying) parts.push(`underlying: [${e.underlying.map(q).join(', ')}]`, `underlyingDecimals: [${e.underlyingDecimals.join(', ')}]`)
  parts.push(`poolType: ${e.poolType}`, `swapTypes: [${e.swapTypes.join(', ')}]`, `codeHash: ${q(e.codeHash)}`, `tvlUsd: ${e.tvlUsd}`)
  if (e.createdAt) parts.push(`createdAt: ${e.createdAt}`)
  return `    { ${parts.join(', ')} },`
}

export function renderChainFile(cfg, builtAt, block, entries, source) {
  const t = tvlThreshold(cfg.chainId)
  return [
    `// Generated by scripts/build-allowlist.mjs on ${builtAt}. Do not edit by hand: rerun the script.`,
    `// ${cfg.name} (${cfg.chainId}), router ABI ${cfg.family}. On-chain checks at block ${block}: coins(i), decimals(),`,
    `// balances(i) > 0, code hash, MetaRegistry/factory registration, get_dy(0, 1, ~$100).`,
    `// Rules: TVL >= $${t.toLocaleString('en-US')} (on-chain balances of catalog/crvUSD coins x API prices), age >= ${MIN_AGE_DAYS} days, top ${capFor(cfg.chainId)} by TVL;`,
    `// no hidden/broken pools, no stable-ng asset type 2/3, no foreign rate oracles. Discovery: ${source}.`,
    `import type { CurveChainPools } from './types.js'`,
    '',
    `export const POOLS_${cfg.chainId}: CurveChainPools = {`,
    `  chainId: ${cfg.chainId},`,
    `  builtAt: ${q(builtAt)},`,
    `  block: ${block},`,
    '  pools: [',
    ...entries.map(renderEntry),
    '  ],',
    '} as const',
    '',
  ].join('\n')
}

export function renderIndex(chainIds) {
  const ids = [...chainIds].sort((a, b) => a - b)
  return [
    '// Generated by scripts/build-allowlist.mjs. Do not edit by hand: rerun the script.',
    `import type { CurveChainPools } from './types.js'`,
    ...ids.map((id) => `import { POOLS_${id} } from './${id}.js'`),
    '',
    `export type { CurveChainPools, CurvePool, Hex } from './types.js'`,
    '',
    '/** Curated Curve pools per chain id. A chain missing here has no pool that passed the rules. */',
    'export const CURVE_POOLS: Readonly<Record<number, CurveChainPools>> = Object.freeze({',
    ...ids.map((id) => `  ${id}: POOLS_${id},`),
    '})',
    '',
  ].join('\n')
}

// WETH per chain, only for the Vyper-ETH rule on main-registry crypto pools (Ethereum and the old L2 deployments).
const WETH = { 1: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 42161: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', 10: '0x4200000000000000000000000000000000000006', 137: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', 43114: '0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab', 100: '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1' }

async function buildChain(cfg, hidden, nowSec, catalog) {
  const t0 = Date.now()
  const { pools, hidden: hiddenIds } = await discover(cfg, hidden)
  const dropped = new Map()
  const details = new Map()
  const { kept, dropped: sdrop, stage } = staticFilters(pools, { chainId: cfg.chainId, hidden: hiddenIds, weth: WETH[cfg.chainId] })
  for (const [a, r] of sdrop) dropped.set(a, r)
  const summary = { chain: cfg.name, chainId: cfg.chainId, discovered: pools.length, ...stage }
  let verified
  const chain = new Chain(cfg)
  chain.anchors = anchorsFor(cfg.chainId, catalog)
  for (let attempt = 0; ; attempt++) {
    await chain.pin()
    const local = new Map()
    const drop = (p, reason, detail) => { local.set(p.address, reason); if (detail) details.set(p.address, detail); return false }
    const work = kept.map((p) => ({ ...p, coins: p.coins.map((c) => ({ ...c })) }))
    try {
      verified = await verifyOnChain(chain, work, drop)
      for (const [a, r] of local) dropped.set(a, r)
      break
    } catch (e) {
      if (!e.noState || attempt >= 3) throw e
      console.error(`  ${cfg.name}: pinned block ${chain.block} pruned mid-run, re-pinning`)
    }
  }
  summary.onchain = verified.length
  try { await creationTimes(chain, verified) } catch (e) { console.error(`  ${cfg.name}: creation lookup failed (${e.message}), ages from the API only`) }
  const aged = verified.filter((p) => { const why = ageDecision(p.createdAt, p.tvlUsd, cfg.chainId, chain.blockTime ?? nowSec); if (why) dropped.set(p.address, why); return !why })
  summary.age = aged.length
  const { kept: final, cut } = rankAndCap(aged, cfg.chainId)
  for (const p of cut) dropped.set(p.address, 'cap')
  summary.final = final.length
  summary.requests = chain.rpc.requests
  summary.seconds = Math.round((Date.now() - t0) / 1000)
  return { cfg, block: chain.block, pools, final, cut, dropped, details, summary, source: cfg.v1 ? `api.curve.finance/v1/getPools/all/${cfg.v1}` : `api2.curve.finance/get_pools/${cfg.chainId}` }
}

async function main() {
  const args = process.argv.slice(2)
  const only = args.includes('--chain') ? new Set(args[args.indexOf('--chain') + 1].split(',').map(Number)) : null
  const dry = args.includes('--dry')
  const builtAt = new Date().toISOString().slice(0, 10)
  const nowSec = Math.floor(Date.now() / 1000)
  const hiddenJson = await getJson('https://api.curve.finance/v1/getHiddenPools')
  const hidden = hiddenJson?.data ?? {}
  const catalog = await loadCatalog()
  mkdirSync(OUT_DIR, { recursive: true })
  const rows = []
  const written = []
  const failed = new Set()
  for (const cfg of CHAINS.filter((c) => !only || only.has(c.chainId))) {
    console.error(`== ${cfg.name} (${cfg.chainId})`)
    let r
    try { r = await buildChain(cfg, hidden, nowSec, catalog) } catch (e) { console.error(`  FAILED: ${e.message}`); failed.add(cfg.chainId); rows.push({ chain: cfg.name, chainId: cfg.chainId, error: e.message }); continue }
    rows.push(r.summary)
    const reasons = {}
    for (const [, why] of r.dropped) reasons[why] = (reasons[why] ?? 0) + 1
    console.error(`  block ${r.block}; dropped by reason: ${JSON.stringify(reasons)}`)
    const interesting = [...r.dropped].filter(([, why]) => !['tvl', 'hidden', 'broken', 'lt-2-coins'].includes(why))
    const byAddr = new Map(r.pools.map((p) => [p.address, p]))
    for (const [a, why] of interesting) { const p = byAddr.get(a); console.error(`    - ${why.padEnd(30)} ${checksum(a)} ${p?.name ?? ''} ($${Math.round(p?.tvlApi ?? 0).toLocaleString('en-US')})${r.details.has(a) ? ' ' + r.details.get(a) : ''}`) }
    for (const p of r.final) console.error(`    + ${checksum(p.address)} ${p.name} [${p.coins.map((c) => c.symbol).join('/')}] t${p.poolType} s${toEntry(p).swapTypes.join('')} $${p.tvlUsd.toLocaleString('en-US')}${p.int128 ? ' int128-coins' : ''}${p.createdAt ? '' : ' age-unknown'}`)
    if (!r.final.length) { console.error(`  ${cfg.name}: nothing passed, no file`); continue }
    if (!dry) {
      writeFileSync(join(OUT_DIR, `${cfg.chainId}.ts`), renderChainFile(cfg, builtAt, r.block, r.final.map(toEntry), r.source))
    }
    written.push(cfg.chainId)
  }
  if (!dry) {
    // A full run drops files of chains that no longer pass; a chain that failed keeps its last file.
    if (!only) for (const f of readdirSync(OUT_DIR)) { const m = /^(\d+)\.ts$/.exec(f); if (m && !written.includes(Number(m[1])) && !failed.has(Number(m[1]))) rmSync(join(OUT_DIR, f)) }
    const present = readdirSync(OUT_DIR).map((f) => /^(\d+)\.ts$/.exec(f)?.[1]).filter(Boolean).map(Number)
    writeFileSync(join(OUT_DIR, 'index.ts'), renderIndex(present))
  }
  if (failed.size) process.exitCode = 1
  const cols = ['chain', 'chainId', 'discovered', 'hard-exclude', 'hidden', 'broken', 'unsupported-type', 'lt-2-coins', 'tvl', 'bad-token', 'vyper-eth', 'onchain', 'age', 'final']
  console.log(`| ${cols.join(' | ')} |`)
  console.log(`|${cols.map(() => '---').join('|')}|`)
  for (const r of rows) console.log(r.error ? `| ${r.chain} | ${r.chainId} | error: ${r.error} |` : `| ${cols.map((c) => r[c] ?? '').join(' | ')} |`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
