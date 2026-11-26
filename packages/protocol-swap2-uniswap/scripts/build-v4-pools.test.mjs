// Rules and drivers of build-v4-pools.mjs on fixtures and fake RPCs. No network.
//   node --test scripts/build-v4-pools.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { encodeAbiParameters, encodeFunctionResult, decodeFunctionData } from 'viem'
import {
  CHAINS, FEE_CAP, INITIALIZE_TOPIC, MC3_ABI, Rpc, ZERO, atBound, baselineAllowed, classifyRpcError, decodeAggregate, decodeInitializeLog, gate, gateVerdict,
  mergeEntries, pairFilterSet, parseChainFile, poolIdOf, renderChainFile, renderIndex, scanInitialize, sortPools, staticRules, toEntry, topicOf,
} from './build-v4-pools.mjs'

const PM = '0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e' // Monad PoolManager
const SV = '0x77395F3b2E73aE90843717371294fa97cC419D64'
const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a'
const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'
const HOOK = '0x0000000000000000000000000000000000000080'
const recorded = JSON.parse(readFileSync(new URL('../tests/fixtures/v4/monad-initialize-logs.json', import.meta.url), 'utf8'))

/** A raw Initialize log for a key (as eth_getLogs returns it). */
function rawLog(key, { block = 100, id = poolIdOf(key), sqrtPriceX96 = 79228162514264337593543950336n, tick = 0, address = PM } = {}) {
  return {
    address, blockNumber: '0x' + block.toString(16), removed: false,
    topics: [INITIALIZE_TOPIC, id, topicOf(key.currency0), topicOf(key.currency1)],
    data: encodeAbiParameters([{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }], [key.fee, key.tickSpacing, key.hooks ?? ZERO, sqrtPriceX96, tick]),
  }
}
const row = (key, extra) => decodeInitializeLog(rawLog(key, extra), PM)

test('PoolId = keccak256(abi.encode(key)): the research vector (Monad NATIVE/AUSD 500/1) and the recorded logs', () => {
  assert.equal(poolIdOf({ currency0: ZERO, currency1: AUSD, fee: 500, tickSpacing: 1 }), '0xadaf30776f551bccdfb307c3fd8cdec198ca9a852434c8022ee32d1ccedd8219')
  assert.ok(recorded.logs.length >= 2)
  for (const log of recorded.logs) {
    const d = decodeInitializeLog(log, PM)
    assert.equal(d.error, undefined)
    assert.equal(poolIdOf(d), d.id, 'a live Initialize log recomputes to its own id')
  }
})

test('decodeInitializeLog is strict: another emitter, removed logs, wrong topics or data, out-of-range fields', () => {
  const key = { currency0: ZERO, currency1: AUSD, fee: 500, tickSpacing: 1 }
  const ok = row(key)
  assert.deepEqual({ ...ok, sqrtPriceX96: undefined }, { id: poolIdOf(key), currency0: ZERO, currency1: AUSD.toLowerCase(), fee: 500, tickSpacing: 1, hooks: ZERO, sqrtPriceX96: undefined, tick: 0, block: 100 })
  assert.match(decodeInitializeLog(rawLog(key, { address: SV }), PM).error, /not the PoolManager/)
  assert.match(decodeInitializeLog({ ...rawLog(key), removed: true }, PM).error, /removed/)
  assert.match(decodeInitializeLog({ ...rawLog(key), topics: rawLog(key).topics.slice(0, 3) }, PM).error, /not an Initialize/)
  assert.match(decodeInitializeLog({ ...rawLog(key), data: rawLog(key).data + '00'.repeat(32) }, PM).error, /5 words/)
  const bigFee = rawLog(key)
  bigFee.data = '0x' + (1n << 24n).toString(16).padStart(64, '0') + bigFee.data.slice(66)
  assert.match(decodeInitializeLog(bigFee, PM).error, /out of range/)
  const dirtyTopic = rawLog(key)
  dirtyTopic.topics[3] = '0x' + 'ff'.repeat(12) + AUSD.slice(2).toLowerCase()
  assert.match(decodeInitializeLog(dirtyTopic, PM).error, /out of range/)
  assert.equal(row({ ...key, tickSpacing: 60 }, { tick: -887200 }).tick, -887200, 'negative int24 decodes')
})

test('static rules run in order: hooked, not-catalog (by address), fee above the 10% cap, bad key, id mismatch', () => {
  const tokens = [ZERO, AUSD.toLowerCase(), USDC.toLowerCase()]
  const good = row({ currency0: ZERO, currency1: AUSD, fee: 500, tickSpacing: 1 })
  const hooked = row({ currency0: ZERO, currency1: AUSD, fee: 500, tickSpacing: 1, hooks: HOOK })
  const lookalike = row({ currency0: ZERO, currency1: '0x530639a4ad89dd2d5ff31ee4a4b5ef01cb8d0656', fee: 3000, tickSpacing: 60 })
  const atCap = row({ currency0: ZERO, currency1: USDC, fee: FEE_CAP, tickSpacing: 2000 })
  const trap = row({ currency0: ZERO, currency1: USDC, fee: 990000, tickSpacing: 1 })
  const forged = row({ currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10 }, { id: '0x' + '11'.repeat(32) })
  const { kept, dropped, stage } = staticRules([good, hooked, lookalike, atCap, trap, forged], { tokens })
  assert.deepEqual(kept.map((r) => r.id), [good.id, atCap.id])
  assert.equal(dropped.get(hooked.id), 'hooked')
  assert.equal(dropped.get(lookalike.id), 'not-catalog', 'a look-alike "MON" token is not the native coin')
  assert.equal(dropped.get(trap.id), 'fee-above-cap', 'a 99% fee pool never qualifies')
  assert.equal(dropped.get(forged.id), 'id-mismatch')
  assert.deepEqual(stage, { hooked: 5, 'not-catalog': 4, 'fee-above-cap': 3, 'bad-key': 3, 'id-mismatch': 2 })
  assert.equal(staticRules([atCap], { tokens, feeCap: 99_999 }).dropped.get(atCap.id), 'fee-above-cap')
})

test('the pair filter: catalog tokens by address, 0x0 for the native coin unless the chain says native: false, plus the wrapped native', () => {
  const monad = CHAINS.find((c) => c.chainId === 143)
  const s = pairFilterSet(monad, [{ contract: null }, { contract: USDC }, { contract: AUSD }])
  assert.deepEqual(s, [ZERO, AUSD.toLowerCase(), monad.wrapped.toLowerCase(), USDC.toLowerCase()].sort())
  const arc = CHAINS.find((c) => c.chainId === 5042)
  assert.equal(arc.native, false)
  assert.ok(!pairFilterSet(arc, [{ contract: null }, { contract: '0x3600000000000000000000000000000000000000' }]).includes(ZERO), 'Arc: native in/out refused')
  assert.ok(!CHAINS.some((c) => [999, 1868, 4217, 7777777].includes(c.chainId)), 'HyperEVM (no quote) and the non-catalog chains are not built')
  for (const c of CHAINS) assert.ok(c.logs.length && c.state.length && Number.isInteger(c.deployBlock), `${c.name} has endpoints and a deploy block`)
})

test('the gate: invariants fail the chain, dead pools drop, live pools stay', () => {
  const key = { id: '0x01', fee: 500, tickSpacing: 10 }
  const s = (o) => ({ sqrtPriceX96: 1n << 96n, tick: 0, protocolFee: 0, lpFee: 500, ...o })
  assert.match(gateVerdict(key, s({ sqrtPriceX96: 0n }), 5n).invariant, /sqrtPriceX96 is 0/)
  assert.match(gateVerdict(key, s({ lpFee: 3000 }), 5n).invariant, /lpFee 3000/)
  assert.deepEqual(gateVerdict(key, s(), 0n), { drop: 'no-liquidity' })
  assert.deepEqual(gateVerdict(key, s({ tick: -887263 }), 5n), { drop: 'at-bound' })
  assert.deepEqual(gateVerdict(key, s({ tick: 887262 }), 5n), { drop: 'at-bound' })
  assert.deepEqual(gateVerdict(key, s({ tick: -887261 }), 5n), { live: true })
  assert.equal(atBound(887271, 1), true)
  assert.equal(atBound(887270, 1), false)
})

test('classifyRpcError: throttles retry, range/result caps split, missing state re-pins', () => {
  assert.equal(classifyRpcError(429, ''), 'rate-limit')
  assert.equal(classifyRpcError(200, '50/second request limit reached', -32007), 'rate-limit')
  assert.equal(classifyRpcError(200, 'getLogs request exceeded max allowed range'), 'range')
  assert.equal(classifyRpcError(413, 'eth_getLogs is limited to a 10,000 range', -32614), 'range')
  assert.equal(classifyRpcError(200, 'ranges over 100 blocks are not supported on free plan'), 'range')
  assert.equal(classifyRpcError(200, 'logs count limit exceeded (10000)'), 'too-many')
  assert.equal(classifyRpcError(200, 'query returned more than 10000 results'), 'too-many')
  assert.equal(classifyRpcError(200, 'missing trie node abc'), 'no-state')
  assert.equal(classifyRpcError(200, 'execution reverted', 3), 'revert')
  assert.equal(classifyRpcError(502, 'bad gateway'), 'server')
})

/** A fake endpoint: `answer(method, params)` returns a result or throws {kind}. */
function fakeRpc(label, answer) {
  const r = new Rpc('http://127.0.0.1:1', label)
  r.seen = []
  r.call = async (method, params) => { r.requests++; r.seen.push([method, params]); return answer(method, params) }
  return r
}
const rangeOf = (p) => [Number(BigInt(p[0].fromBlock)), Number(BigInt(p[0].toBlock))]

test('scanInitialize: chunks, splits a window the node refuses, fails over, dedupes, and refuses logs outside the asked range', async () => {
  const k1 = { currency0: ZERO, currency1: AUSD, fee: 500, tickSpacing: 1 }
  const k2 = { currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10 }
  const logs = [rawLog(k1, { block: 15 }), rawLog(k2, { block: 37 })]
  const inRange = (p) => { const [a, b] = rangeOf(p); return logs.filter((l) => Number(BigInt(l.blockNumber)) >= a && Number(BigInt(l.blockNumber)) <= b) }
  const primary = fakeRpc('p', (m, p) => {
    if (m === 'eth_blockNumber') return '0x64'
    const [a, b] = rangeOf(p)
    if (b - a + 1 > 5) throw Object.assign(new Error('range'), { kind: 'range' })
    if (a >= 30) throw Object.assign(new Error('boom'), { kind: 'server' })
    return inRange(p)
  })
  const backup = fakeRpc('b', (m, p) => (m === 'eth_blockNumber' ? '0x64' : inRange(p)))
  const { rows, stats } = await scanInitialize({ eps: [{ rpc: primary, window: 10, workers: 2 }, { rpc: backup, window: 10, workers: 0 }], poolManager: PM, topics: [INITIALIZE_TOPIC], from: 0, to: 49 })
  assert.deepEqual(rows.map((r) => r.id).sort(), [poolIdOf(k1), poolIdOf(k2)].sort())
  assert.ok(stats.splits >= 5 && stats.failovers >= 1, JSON.stringify(stats))
  for (const [m, p] of primary.seen) if (m === 'eth_getLogs') assert.ok(rangeOf(p)[0] < 30 || rangeOf(p)[1] - rangeOf(p)[0] + 1 <= 10)
  const liar = fakeRpc('l', (m) => (m === 'eth_blockNumber' ? '0x64' : [rawLog(k1, { block: 99 })]))
  await assert.rejects(scanInitialize({ eps: [{ rpc: liar, window: 10, workers: 1 }], poolManager: PM, topics: [INITIALIZE_TOPIC], from: 0, to: 9 }), /outside the asked range/)
  const dead = fakeRpc('d', (m) => { if (m === 'eth_blockNumber') return '0x64'; throw Object.assign(new Error('down'), { kind: 'server' }) })
  await assert.rejects(scanInitialize({ eps: [{ rpc: dead, window: 10, workers: 1 }], poolManager: PM, topics: [INITIALIZE_TOPIC], from: 0, to: 9 }), /down/)
})

test('scanInitialize waits for a node behind the range end instead of reading its shorter answer', async () => {
  let head = 5
  const slow = fakeRpc('s', (m) => (m === 'eth_blockNumber' ? '0x' + (head += 5).toString(16) : []))
  const r = await scanInitialize({ eps: [{ rpc: slow, window: 100, workers: 1 }], poolManager: PM, topics: [INITIALIZE_TOPIC], from: 0, to: 12 })
  assert.equal(r.rows.length, 0)
  assert.ok(slow.seen.filter(([m]) => m === 'eth_blockNumber').length >= 2)
}, { timeout: 20_000 })

test('gate(): one Multicall3 read per chunk at the pinned block; a failed sub-call or a wrong StateView fails the chain', async () => {
  const cfg = CHAINS.find((c) => c.chainId === 143)
  const k = { currency0: ZERO, currency1: AUSD, fee: 500, tickSpacing: 1 }
  const keys = [{ ...k, id: poolIdOf(k) }]
  const word = (v) => encodeAbiParameters([{ type: 'uint256' }], [v])
  const slot0 = encodeAbiParameters([{ type: 'uint160' }, { type: 'int24' }, { type: 'uint24' }, { type: 'uint24' }], [1n << 96n, 5, 0, 500])
  const answer = (results) => encodeFunctionResult({ abi: MC3_ABI, functionName: 'aggregate3', result: results })
  const rpcWith = (pm, failSlot0 = false) => fakeRpc('g', (m, p) => {
    assert.equal(m, 'eth_call')
    assert.equal(p[1], '0x7b', 'every read at the pinned block')
    const { args } = decodeFunctionData({ abi: MC3_ABI, data: p[0].data })
    if (args[0].length === 1) return answer([{ success: true, returnData: encodeAbiParameters([{ type: 'address' }], [pm]) }])
    return answer([{ success: !failSlot0, returnData: failSlot0 ? '0x' : slot0 }, { success: true, returnData: word(7n) }])
  })
  const ok = await gate(cfg, [rpcWith(PM)], keys, 123)
  assert.deepEqual(ok.live.map((x) => x.id), [keys[0].id])
  await assert.rejects(gate(cfg, [rpcWith(SV)], keys, 123), /not the pinned PoolManager/)
  await assert.rejects(gate(cfg, [rpcWith(PM, true)], keys, 123), /sub-call 0 failed/)
})

test('decodeAggregate refuses a short answer, a count mismatch and a wrong return size', () => {
  const enc = (rs) => encodeFunctionResult({ abi: MC3_ABI, functionName: 'aggregate3', result: rs })
  assert.throws(() => decodeAggregate(enc([{ success: true, returnData: '0x' + '00'.repeat(32) }]), [32, 32]), /1 results for 2/)
  assert.throws(() => decodeAggregate(enc([{ success: true, returnData: '0x' + '00'.repeat(31) }]), [32]), /31 bytes/)
  assert.throws(() => decodeAggregate('0x', [32]))
})

test('output: deterministic order, checksummed keys, lower-case ids, a header that states the block and the rules', () => {
  const a = { currency0: ZERO, currency1: USDC.toLowerCase(), fee: 500, tickSpacing: 10 }
  const b = { currency0: ZERO, currency1: AUSD.toLowerCase(), fee: 3000, tickSpacing: 60 }
  const c = { currency0: ZERO, currency1: AUSD.toLowerCase(), fee: 500, tickSpacing: 1 }
  const sorted = sortPools([a, b, c].map((x) => ({ ...x, id: poolIdOf(x) })))
  assert.deepEqual(sorted.map((x) => x.fee), [500, 3000, 500])
  const e = toEntry(sorted[0])
  assert.equal(e.currency1, AUSD)
  assert.equal(e.id, poolIdOf(c))
  const cfg = CHAINS.find((x) => x.chainId === 143)
  const text = renderChainFile(cfg, { builtAt: '2026-11-26', block: 123, fromBlock: cfg.deployBlock, tokens: [ZERO, AUSD.toLowerCase()], feeCap: FEE_CAP, initialized: 3 }, sorted.map(toEntry))
  assert.match(text, /export const V4_POOLS_143: V4ChainPools = \{/)
  assert.match(text, /block: 123,/)
  assert.match(text, /poolManager: "0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e",\n  stateView: "0x77395F3b2E73aE90843717371294fa97cC419D64",/)
  assert.match(text, /Floor: live/)
  assert.match(text, new RegExp(`id: "${poolIdOf(c)}"`))
  assert.match(renderIndex([8453, 143]), /import \{V4_POOLS_143\} from "\.\/143\.js";\nimport \{V4_POOLS_8453\}/)
})

/** The lists 0.5.0 ships (the first release with v4 pins, built with --baseline): per chain, [build block, pools]. */
const BASELINE_050 = Object.freeze({
  1: [26496488, 160], 10: [160031400, 89], 56: [135770107, 75], 130: [64913238, 54], 137: [97970744, 100], 143: [125461100, 38],
  196: [76909615, 19], 480: [38171496, 28], 4326: [32864586, 11], 4663: [123519529, 33], 5042: [33211219, 86], 8453: [62356188, 126],
  42161: [527612650, 152], 42220: [83777893, 13], 43114: [101406277, 27], 57073: [62180240, 17], 59144: [32712881, 13], 99901: [10878220, 11],
})

test('TOOLING-4: --baseline runs only before 0.5.0 is released (package.json still 0.4.x)', () => {
  for (const v of ['0.4.11', '0.4.12', '0.0.1']) assert.equal(baselineAllowed(v), true, v)
  for (const v of ['0.5.0', '0.5.1', '0.6.0', '1.0.0', '0.5.0-next.1', '', 'x']) assert.equal(baselineAllowed(v), false, v)
  assert.equal(Object.values(BASELINE_050).reduce((n, [, c]) => n + c, 0), 1052)
})

test('R2-1: every shipped list reads back (parseChainFile), and render → parse is the identity, since included', () => {
  const dir = new URL('../src/v4pools/', import.meta.url)
  const files = readdirSync(dir).filter((f) => /^\d+\.ts$/.test(f))
  assert.ok(files.length >= 18)
  for (const f of files) {
    const text = readFileSync(new URL(f, dir), 'utf8')
    const entries = parseChainFile(text)
    const lines = text.split('\n').filter((l) => /^\s*\{currency0: /.test(l))
    assert.equal(entries.length, lines.length, f)
    // Release-aware (TOOLING-4): the 0.5.0 lists are the baseline, their pools without `since`; a later rebuild keeps
    // them (lists only grow) and marks every pool it adds with a `since` past the 0.5.0 build. So the pools without
    // `since` stay exactly the 0.5.0 ones — a rebuild written with --baseline after 0.5.0 adds more and fails here —
    // and a chain the 0.5.0 release had no list for carries `since` on every pool.
    const chainId = Number(f.replace('.ts', ''))
    const base = BASELINE_050[chainId]
    const bare = entries.filter((e) => e.since === undefined)
    if (!base) assert.equal(bare.length, 0, `${f}: a chain without a 0.5.0 list marks every pool with since`)
    else {
      assert.equal(bare.length, base[1], `${f}: the pools without since are the 0.5.0 list's ${base[1]}`)
      assert.ok(entries.every((e) => e.since === undefined || e.since > base[0]), `${f}: every pool a rebuild added is marked past the 0.5.0 build (${base[0]})`)
    }
  }
  const cfg = CHAINS.find((c) => c.chainId === 143)
  const a = toEntry({ currency0: ZERO, currency1: AUSD, fee: 500, tickSpacing: 1, id: poolIdOf({ currency0: ZERO, currency1: AUSD, fee: 500, tickSpacing: 1 }) })
  const b = { ...toEntry({ currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10, id: poolIdOf({ currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10 }) }), since: 130_000_000 }
  const text = renderChainFile(cfg, { builtAt: '2026-12-01', block: 130_000_000, fromBlock: cfg.deployBlock, tokens: [ZERO, AUSD, USDC], feeCap: FEE_CAP, initialized: 2, kept: 1 }, sortPools([a, b]))
  assert.match(text, /since: 130000000\}/)
  assert.match(text, /Lists only grow: 1 pool\(s\) of earlier builds kept/)
  assert.deepEqual(parseChainFile(text), sortPools([a, b]))
  // A line it cannot read, or an entry whose id is not its key's, fails (a list is never shrunk by a parse error).
  assert.throws(() => parseChainFile(text.replace('fee: 500, tickSpacing: 1,', 'fee: 500, tickSpacing: 1, hooks: "0x01",')), /cannot read/)
  assert.throws(() => parseChainFile(text.replace(a.id, '0x' + '11'.repeat(32))), /does not match its key/)
  assert.throws(() => parseChainFile('export const X = {}'), /does not parse/)
})

test('R2-1: lists only grow — earlier pools kept with their since, new pools marked with the build block', () => {
  const key = (currency1, fee, tickSpacing) => ({ currency0: ZERO, currency1, fee, tickSpacing, id: poolIdOf({ currency0: ZERO, currency1, fee, tickSpacing }) })
  const A = key(AUSD, 500, 1), B = key(USDC, 500, 10), C = key(USDC, 3000, 60)
  const prev = [toEntry(A), { ...toEntry(B), since: 150 }]
  // A rebuild at block 200: A no longer passes the gate (kept, still no since), B kept with its since, C new (since 200).
  const r = mergeEntries(prev, [B, C].map(toEntry), { block: 200 })
  assert.equal(r.added, 1)
  assert.equal(r.kept, 1)
  const by = new Map(r.entries.map((e) => [e.id, e]))
  assert.equal(by.get(A.id).since, undefined)
  assert.equal(by.get(B.id).since, 150)
  assert.equal(by.get(C.id).since, 200)
  assert.deepEqual(r.entries, sortPools(r.entries))
  // A chain's first file: every pool carries the build block (apps on earlier releases have no list for the chain) …
  assert.ok(mergeEntries(null, [A, B].map(toEntry), { block: 300 }).entries.every((e) => e.since === 300))
  // … unless --baseline (a list in the first release that ships v4 pins, before it is released).
  assert.ok(mergeEntries(null, [A, B].map(toEntry), { block: 300, baseline: true }).entries.every((e) => e.since === undefined))
  assert.ok(mergeEntries(prev, [C].map(toEntry), { block: 300, baseline: true }).entries.find((e) => e.id === C.id).since === undefined)
})

test('SEC-U4-R3-2: the shipped index is renderIndex output — every chain list frozen all the way down by freezeChainPools', () => {
  const dir = new URL('../src/v4pools/', import.meta.url)
  const ids = readdirSync(dir).map((f) => /^(\d+)\.ts$/.exec(f)?.[1]).filter(Boolean).map(Number)
  const shipped = readFileSync(new URL('index.ts', dir), 'utf8')
  assert.equal(renderIndex(ids), shipped, 'src/v4pools/index.ts is exactly what the build writes')
  assert.match(shipped, /^import \{freezeChainPools\} from "\.\/freeze\.js";$/m)
  for (const id of ids) assert.match(shipped, new RegExp(`^  ${id}: freezeChainPools\\(V4_POOLS_${id}\\),$`, 'm'))
  // freeze.ts is written by hand: a full run of the build never removes it (it removes only <chainId>.ts files).
  assert.ok(readdirSync(dir).includes('freeze.ts'))
})

test('TOOLING-2: no spelling of an endpoint reaches an error text — a node echoing its path, another URL, or a body cut through one', async () => {
  const KEY = 'SECRETKEY1234567890abcdef'
  const OTHER = 'OTHERSECRET0987654321zyxw'
  // A node that answers each request as the test says: a 404 echoing the path, a JSON-RPC error naming URLs, a long body.
  const answers = [
    (req) => ({ status: 404, body: `Cannot POST ${req.url}` }),
    () => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: `upgrade at https://rpc.example/key/${OTHER} or /v2/${KEY}` } }) }),
    (req) => ({ status: 502, body: `${'x'.repeat(190)} ${req.url} gateway` }),
    (req) => ({ status: 200, body: `not json ${'y'.repeat(70)} ${req.headers.host}${req.url}` }),
  ]
  let n = 0
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => { const a = answers[n++](req); res.statusCode = a.status; res.end(a.body) })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const rpc = new Rpc(`http://127.0.0.1:${server.address().port}/v2/${KEY}`, 'env#0')
    for (let i = 0; i < answers.length; i++) {
      const e = await rpc.call('eth_blockNumber', [], { retries: 0 }).then(() => null, (x) => x)
      assert.ok(e instanceof Error, `answer ${i} is an error`)
      assert.match(e.message, /^env#0: eth_blockNumber /)
      for (const leak of [KEY, KEY.slice(0, 12), OTHER, '/v2/', '127.0.0.1:']) assert.ok(!e.message.includes(leak), `answer ${i}: "${leak}" in "${e.message}"`)
    }
  } finally {
    server.close()
  }
})
