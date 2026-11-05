// Filter rules of build-allowlist.mjs on fixtures. No network.
//   node --test scripts/build-allowlist.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ETH, ageDecision, anchoredTvl, anchorsFor, assetTypeDecision, checksum, coinsMatch, dedupe, fromV1, fromV2, keccakHex, ngMetaTypes, ngPlainOracles, probeAmount, rankAndCap,
  renderChainFile, renderIndex, routerPoolType, staticFilters, usdOf, vyperEthRisk, assertCurveHost,
} from './build-allowlist.mjs'

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const NOW = Date.UTC(2026, 10, 5) / 1000
const coin = (address, usdPrice = 1) => ({ address, decimals: 6, usdPrice, symbol: '' })
const pool = (over = {}) => ({
  id: 'factory-stable-ng-1', address: '0x1111111111111111111111111111111111111111', name: 'USDC/USDT', registry: 'factory-stable-ng', implementation: 'plainstableng',
  factory: null, coins: [coin(USDC), coin(USDT)], underlying: null, isMeta: false, basePool: null, isBroken: false, tvlApi: 5_000_000, createdAt: NOW - 90 * 86_400, createdBlock: null, ...over,
})
const run = (pools, chainId = 1, hidden = new Set()) => staticFilters(pools, { chainId, hidden, weth: WETH })

test('keccak and EIP-55 match known vectors', () => {
  assert.equal(keccakHex('', true), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
  assert.equal(checksum(USDC), '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')
  assert.equal(checksum(ETH.toLowerCase()), ETH)
})

test('TVL thresholds: $1M on Ethereum, $250k elsewhere', () => {
  const low = pool({ tvlApi: 999_999 })
  assert.equal(run([low]).dropped.get(low.address), 'tvl')
  assert.equal(run([pool({ tvlApi: 1_000_000 })]).kept.length, 1)
  assert.equal(run([pool({ tvlApi: 249_999 })], 8453).kept.length, 0)
  assert.equal(run([pool({ tvlApi: 250_000 })], 8453).kept.length, 1)
})

test('hidden, broken and hard-excluded pools are dropped', () => {
  const hidden = pool({ id: 'factory-v2-0', address: '0x2222222222222222222222222222222222222222' })
  const broken = pool({ isBroken: true, address: '0x3333333333333333333333333333333333333333' })
  const fake = pool({ address: '0xa6d9f4f3a67b35e81dfa560b0fcde9b0751f1f53', tvlApi: 50_000_000 })
  const aleth = pool({ address: '0xc4c319e2d4d66cca4464c0c2b32c9bd23ebe784e', registry: 'factory', tvlApi: 50_000_000 })
  const crveth = pool({ address: '0x8301ae4fc9c624d1d396cbdaa1ed877821d7c511', registry: 'crypto', tvlApi: 50_000_000 })
  const { kept, dropped } = run([hidden, broken, fake, aleth, crveth, pool()], 1, new Set(['factory-v2-0']))
  assert.deepEqual(kept.map((p) => p.address), [pool().address])
  assert.equal(dropped.get(hidden.address), 'hidden')
  assert.equal(dropped.get(broken.address), 'broken')
  assert.equal(dropped.get(fake.address), 'hard-exclude')
  assert.equal(dropped.get(aleth.address), 'hard-exclude')
  assert.equal(dropped.get(crveth.address), 'hard-exclude')
})

test('LLAMMA / unknown families, single-coin pools and bad tokens are dropped', () => {
  const llamma = pool({ registry: 'crvusd-amm', address: '0x4444444444444444444444444444444444444444' })
  const single = pool({ coins: [coin(USDC)], address: '0x5555555555555555555555555555555555555555' })
  const ampl = pool({ coins: [coin(USDC), coin('0xd46ba6d942050d489dbd938a2c909a5d5039a161')], address: '0x6666666666666666666666666666666666666666' })
  const { kept, dropped } = run([llamma, single, ampl])
  assert.equal(kept.length, 0)
  assert.equal(dropped.get(llamma.address), 'unsupported-type')
  assert.equal(dropped.get(single.address), 'lt-2-coins')
  assert.equal(dropped.get(ampl.address), 'bad-token')
})

test('router pool types', () => {
  assert.equal(routerPoolType('main', 3), 1)
  assert.equal(routerPoolType('factory', 2), 1)
  assert.equal(routerPoolType('factory-crvusd', 2), 1)
  assert.equal(routerPoolType('factory-stable-ng', 4), 10)
  assert.equal(routerPoolType('crypto', 2), 2)
  assert.equal(routerPoolType('crypto', 3), 3)
  assert.equal(routerPoolType('factory-crypto', 2), 2)
  assert.equal(routerPoolType('factory-twocrypto', 2), 20)
  assert.equal(routerPoolType('factory-tricrypto', 3), 30)
  assert.equal(routerPoolType('factory-eywa', 2), null)
})

test('Vyper 0.2.15–0.3.0 native-ETH pools', () => {
  const eth = { address: ETH.toLowerCase(), decimals: 18, usdPrice: 3000 }
  assert.equal(vyperEthRisk(pool({ registry: 'factory', implementation: 'plain2eth', coins: [eth, coin(USDC)] }), WETH), true)
  assert.equal(vyperEthRisk(pool({ registry: 'factory', implementation: 'plain2basic', coins: [eth, coin(USDC)] }), WETH), false)
  const crypto = { registry: 'crypto', coins: [coin(USDT), coin(WETH)] }
  assert.equal(vyperEthRisk(pool({ ...crypto, createdAt: Date.UTC(2021, 10, 1) / 1000 }), WETH), true)
  assert.equal(vyperEthRisk(pool({ ...crypto, createdAt: Date.UTC(2021, 5, 1) / 1000 }), WETH), false)
  assert.equal(vyperEthRisk(pool({ ...crypto, createdAt: Date.UTC(2021, 10, 1) / 1000, address: '0xd51a44d3fae010294c616388b506acda1bfaae46' }), WETH), false) // tricrypto2
})

test('stable-ng asset types: 2 and 3 refused, 1 only with a self-reported or allowed oracle', () => {
  const coins = [USDC, USDT]
  assert.equal(assetTypeDecision([0, 0], coins, [], 1), null)
  assert.equal(assetTypeDecision([0, 2], coins, [], 1), 'asset-type-2-rebasing')
  assert.equal(assetTypeDecision([3, 0], coins, [], 1), 'asset-type-3-erc4626')
  assert.equal(assetTypeDecision([0, 1], coins, [null, USDT], 1), null)
  assert.equal(assetTypeDecision([0, 1], coins, [null, '0x0000000000000000000000000000000000000000'], 1), null)
  assert.equal(assetTypeDecision([0, 1], coins, [null, '0x9999999999999999999999999999999999999999'], 1), 'asset-type-1-foreign-oracle')
  assert.equal(assetTypeDecision([0, 1], coins, null, 1), 'asset-type-1-oracle-unreadable')
  assert.equal(assetTypeDecision(null, coins, [], 1), 'asset-types-unreadable')
  assert.equal(assetTypeDecision([0], coins, [], 1), 'asset-types-unreadable')
})

test('stable-ng immutables are located by coins and anchored on the factory', () => {
  const w = (x) => (typeof x === 'bigint' ? x.toString(16) : x.replace(/^0x/, '')).padStart(64, '0')
  const factory = '0x6a8cbed756804b16e05e741edabd5cb544ae21bf'
  const oracle = (addr, method = '679aefce') => method + '0'.repeat(16) + addr.slice(2)
  const slots = (n, items) => [w(BigInt(n)), ...items.map(w), ...Array(8 - items.length).fill(w(0n))]
  const plain = ['60806040', w(2n), w(2n), w(factory), ...slots(2, [USDC, USDT]), ...slots(2, [0n, 1n]), w(0n), ...slots(2, [10n ** 30n, 10n ** 30n]), ...slots(2, [0n]).slice(0, 2), oracle(USDT), ...Array(6).fill(w(0n)), w(7n)]
  const code = '0x' + 'ab'.repeat(13) + plain.join('')
  assert.deepEqual(ngPlainOracles(code, [USDC, USDT], [0, 1], new Set([factory])), ['0x0000000000000000000000000000000000000000', USDT])
  assert.equal(ngPlainOracles(code, [USDC, USDT], [0, 1], new Set(['0x9999999999999999999999999999999999999999'])), null) // wrong factory
  assert.equal(ngPlainOracles(code, [USDC, USDT], [1, 1], new Set([factory])), null) // types disagree
  assert.equal(ngPlainOracles(code, [USDT, USDC], [0, 1], new Set([factory])), null) // coin order
  const lp = '0x6c3f90f043a72fa612cbac8115ee7e52bde6e490'
  const meta = ['00', w(factory), ...slots(2, [USDC, lp]), w(1n), w(0n), w(10n ** 30n), oracle(USDC), w(0n)]
  assert.deepEqual(ngMetaTypes('0x' + meta.join(''), [USDC, lp], new Set([factory])), { types: [1, 0], oracles: [USDC, null] })
})

test('coin mismatch between API and chain', () => {
  assert.equal(coinsMatch([USDC, USDT], [USDC.toUpperCase().replace('0X', '0x'), USDT]), true)
  assert.equal(coinsMatch([USDC, USDT], [USDT, USDC]), false)
  assert.equal(coinsMatch([USDC, USDT], [USDC, USDT, WETH]), false)
  assert.equal(coinsMatch([USDC, USDT], [USDC, '0x810ecc2aa8b798f28633e1586a718cd48083bae9']), false) // the fake "USDT"
})

test('age: 30 days; unknown only with 2x the TVL threshold', () => {
  assert.equal(ageDecision(NOW - 31 * 86_400, 1_000_000, 1, NOW), null)
  assert.equal(ageDecision(NOW - 29 * 86_400, 9_000_000, 1, NOW), 'too-young')
  assert.equal(ageDecision(null, 1_999_999, 1, NOW), 'age-unknown')
  assert.equal(ageDecision(null, 2_000_000, 1, NOW), null)
  assert.equal(ageDecision(null, 500_000, 8453, NOW), null)
  assert.equal(ageDecision(undefined, 499_999, 8453, NOW), 'age-unknown')
})

test('rank by TVL then address, capped at 80 / 40', () => {
  const mk = (i, tvlUsd) => ({ address: `0x${i.toString(16).padStart(40, '0')}`, tvlUsd })
  const pools = Array.from({ length: 100 }, (_, i) => mk(i + 1, 1_000_000 + (i % 7)))
  const eth = rankAndCap(pools, 1)
  assert.equal(eth.kept.length, 80)
  assert.equal(eth.cut.length, 20)
  for (let i = 1; i < eth.kept.length; i++) {
    const a = eth.kept[i - 1], b = eth.kept[i]
    assert.ok(a.tvlUsd > b.tvlUsd || (a.tvlUsd === b.tvlUsd && a.address < b.address))
  }
  assert.equal(rankAndCap(pools, 8453).kept.length, 40)
})

test('USD value and probe amounts stay in bigint', () => {
  assert.equal(usdOf([1_000_000n * 10n ** 6n, 2n * 10n ** 18n], [6, 18], [1, 3000.5]), 1_006_001)
  assert.equal(usdOf([10n ** 40n], [18], [null]), 0)
  assert.equal(probeAmount(6, 1), 100_000_000n)
  assert.equal(probeAmount(8, 100_000), 100_000n)
  assert.equal(probeAmount(18, null), 10n ** 15n)
})

test('API rows normalise; duplicates collapse; only curve.finance hosts', () => {
  const v1 = fromV1({ id: '0', address: '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7', name: 'Curve.fi DAI/USDC/USDT‮', registryId: 'main', factory: true, coins: [{ address: USDC, decimals: '6', usdPrice: 1 }, { address: USDT, decimals: '6', usdPrice: 1 }], usdTotal: 10, creationTs: 0 })
  assert.equal(v1.factory, null)
  assert.equal(v1.createdAt, null)
  assert.equal(v1.name, 'Curve.fi DAI/USDC/USDT')
  const v2 = fromV2({ id: 'factory_stable_ng-6', address: USDC, registry_id: 'factory_stable_ng', coins: [], tvl: 3 })
  assert.equal(v2.registry, 'factory-stable-ng')
  assert.equal(v2.id, 'factory-stable-ng-6')
  assert.equal(dedupe([v1, { ...v1, registry: 'factory' }]).length, 1)
  assertCurveHost('https://api.curve.finance/v1/getHiddenPools')
  assertCurveHost('https://api2.curve.finance/get_pools/1')
  assert.throws(() => assertCurveHost('https://api.curve.fi/v1/getHiddenPools'))
  assert.throws(() => assertCurveHost('https://curve.finance.evil.example/x'))
  assert.throws(() => assertCurveHost('http://api.curve.finance/v1'))
})

test('rendered files are TypeScript literals with checksummed addresses and no RPC URLs', () => {
  const cfg = { chainId: 8453, name: 'Base', family: 'ng5', rpc: 'https://base-rpc.publicnode.com/secret' }
  const entry = { address: checksum(USDC), name: "it's", coins: [checksum(USDC), ETH], decimals: [6, 18], poolType: 10, swapTypes: [1], codeHash: '0x' + 'ab'.repeat(32), tvlUsd: 1, createdAt: 2 }
  const src = renderChainFile(cfg, '2026-11-05', 123, [entry], 'api.curve.finance/v1/getPools/all/base')
  assert.match(src, /export const POOLS_8453: CurveChainPools = \{/)
  assert.match(src, /name: 'it\\'s'/)
  assert.ok(!src.includes('publicnode'))
  assert.match(renderIndex([8453, 1]), /import \{ POOLS_1 \} from '\.\/1\.js'\nimport \{ POOLS_8453 \}/)
})

test('TVL counts only anchor coins: a pool of two mispriced tokens is worth nothing', () => {
  const bal = [10n ** 24n, 10n ** 24n]
  // ethPUSSY/bscPUSSY-style: the API prices both at $5k, neither is an anchor.
  assert.equal(anchoredTvl(bal, [18, 18], [5000, 5000], [false, false], 5e9), 0)
  // USDC + an unpriced/unknown token: the USDC side, doubled, capped by the full on-chain value.
  assert.equal(anchoredTvl([10n ** 12n, 10n ** 24n], [6, 18], [1, 1], [true, false], 1e9), 2_000_000)
  assert.equal(anchoredTvl([10n ** 12n, 10n ** 12n], [6, 6], [1, 1], [true, true], 1_500_000), 1_500_000) // API lower
  const anchors = anchorsFor(1, { ccChain: () => ({ assets: [{ contract: USDC }, { contract: null }] }) })
  assert.ok(anchors.has(USDC) && anchors.has(ETH.toLowerCase()) && anchors.has('0xf939e0a03fb07f59a73314e73794be0e57ac1b4e'))
  assert.ok(!anchors.has(USDT))
})
