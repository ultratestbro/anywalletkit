// The `evm-initialize` watch source (watch.mjs): a stateful scan of a Uniswap v4 PoolManager's `Initialize` log for new
// hookless pools between catalog tokens, and a liveness check of the module's pinned pool list. Pure functions plus one
// scan driver over an injected JSON-RPC caller; no dependencies beyond keccak256 from evm-call.mjs (the watch sandbox
// tests copy these files alone).
//
// Source: {id, type: "evm-initialize", chainId, poolManager, stateView, pools: {from: "dist/index.js", export: "UNISWAP_V4_POOLS"},
//          logsRpc?: "https://…" (a public endpoint with wide eth_getLogs windows), window?: 10000, feeCap?: 100000,
//          maxCalls?: 300, confirm?: 20}
// State (the stored meta): lastBlock (the index ends here), seen (qualifying pools not in the pinned list, with their
// live flag at the last run), deadRuns (per listed pool, consecutive runs it read dead).
// Compared value: the unlisted qualifying pools (id + live) and the listed pools dead for 3 runs in a row. So the digest
// reports a new pool once (and again when it turns live: rebuild + release), and a listed pool once it has been dead for
// three runs (a removal candidate, never removed automatically). Any failed read fails the source: the previous state is
// kept and the same blocks are scanned again next run.
//
//   node --test scripts/watch/watch-2026-11-26-evm-initialize.test.mjs
import {keccak256} from "./evm-call.mjs";

export const INITIALIZE_TOPIC = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
export const ZERO = "0x0000000000000000000000000000000000000000";
export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
/** Owner decision 5: 10%. */
export const FEE_CAP = 100_000;
/** Consecutive dead readings before a listed pool is reported. */
export const DEAD_RUNS = 3;
const MIN_TICK = -887272, MAX_TICK = 887272;
const SEL = {aggregate3: "0x82ad56cb", getSlot0: "0xc815641c", getLiquidity: "0xfa6793d5"};

const lc = (a) => String(a).toLowerCase();
const hexToBytes = (hex) => { const h = hex.replace(/^0x/, ""); const out = new Uint8Array(h.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16); return out; };
const w = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, "0");
const wordAt = (h, i) => h.slice(64 * i, 64 * (i + 1));
const addrWord = (x) => (/^0{24}[0-9a-f]{40}$/.test(x) ? "0x" + x.slice(24) : null);
const int24 = (x) => { const v = BigInt.asIntN(256, BigInt("0x" + x)); return v >= -8388608n && v <= 8388607n ? Number(v) : null; };
const uintBits = (x, bits) => { const v = BigInt("0x" + x); return v < 1n << BigInt(bits) ? v : null; };

if (keccak256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)") !== INITIALIZE_TOPIC) throw new Error("Initialize topic self-test failed");
if (keccak256("getSlot0(bytes32)").slice(0, 10) !== SEL.getSlot0 || keccak256("getLiquidity(bytes32)").slice(0, 10) !== SEL.getLiquidity || keccak256("aggregate3((address,bool,bytes)[])").slice(0, 10) !== SEL.aggregate3) throw new Error("selector self-test failed");

/** keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)), lower-case. */
export function poolIdOf(k) {
  return keccak256(hexToBytes(w(k.currency0) + w(k.currency1) + w(k.fee) + w(BigInt.asUintN(256, BigInt(k.tickSpacing))) + w(k.hooks ?? ZERO)));
}

/** One raw log → {id, currency0, currency1, fee, tickSpacing, hooks, block} or {error}. Strict, like scripts/build-v4-pools.mjs. */
export function decodeInitialize(log, poolManager) {
  if (!log || log.removed === true) return {error: "removed or empty log"};
  if (lc(log.address) !== lc(poolManager)) return {error: `log from ${log.address}, not the PoolManager`};
  const t = log.topics;
  if (!Array.isArray(t) || t.length !== 4 || lc(t[0]) !== INITIALIZE_TOPIC) return {error: "not an Initialize log"};
  const d = lc(log.data ?? "").replace(/^0x/, "");
  if (!/^[0-9a-f]*$/.test(d) || d.length !== 64 * 5) return {error: "Initialize data is not 5 words"};
  const id = lc(t[1]), c0 = addrWord(lc(t[2]).slice(2)), c1 = addrWord(lc(t[3]).slice(2));
  const fee = uintBits(wordAt(d, 0), 24), tickSpacing = int24(wordAt(d, 1)), hooks = addrWord(wordAt(d, 2));
  if (!/^0x[0-9a-f]{64}$/.test(id) || !c0 || !c1 || fee === null || tickSpacing === null || !hooks || uintBits(wordAt(d, 3), 160) === null || int24(wordAt(d, 4)) === null) return {error: "Initialize fields out of range"};
  if (!/^0x[0-9a-f]+$/i.test(String(log.blockNumber ?? ""))) return {error: "no block number"};
  return {id, currency0: c0, currency1: c1, fee: Number(fee), tickSpacing, hooks, block: Number(BigInt(log.blockNumber))};
}

/** The list's rules: hookless, both currencies in `tokens`, fee <= cap, key rules, PoolId recomputed. The reason it fails, or null. */
export function disqualify(row, tokens, feeCap = FEE_CAP) {
  if (lc(row.hooks) !== ZERO) return "hooked";
  const S = tokens instanceof Set ? tokens : new Set([...tokens].map(lc));
  if (!S.has(lc(row.currency0)) || !S.has(lc(row.currency1))) return "not-catalog";
  if (!(row.fee <= feeCap)) return "fee-above-cap";
  if (!(BigInt(row.currency0) < BigInt(row.currency1)) || !(row.tickSpacing >= 1 && row.tickSpacing <= 32767)) return "bad-key";
  if (poolIdOf(row) !== lc(row.id)) return "id-mismatch";
  return null;
}

/** Live = liquidity > 0 and the tick more than one spacing inside the bounds (the build's gate). sqrtP 0 reads as not live. */
export const isLive = (s, tickSpacing) => s.sqrtPriceX96 !== 0n && s.liquidity > 0n && s.tick - tickSpacing > MIN_TICK && s.tick + tickSpacing < MAX_TICK;

/** aggregate3 calldata for StateView reads (allowFailure true: a failure comes back as data and fails the source). */
export function encodeAggregate3(calls) {
  const n = calls.length;
  const tuples = calls.map((c) => {
    const data = c.data.replace(/^0x/, "");
    const padded = data.padEnd(Math.ceil(data.length / 64) * 64, "0");
    return w(c.to) + w(1) + w(96) + w(data.length / 2) + padded;
  });
  let off = n * 32;
  const heads = tuples.map((t) => { const h = w(off); off += t.length / 2; return h; });
  return SEL.aggregate3 + w(32) + w(n) + heads.join("") + tuples.join("");
}

/** Decodes Result[] strictly: n entries, every one successful with exactly `sizes[i]` bytes; returns the return-data hex per call. */
export function decodeAggregate3(hex, sizes) {
  const h = lc(hex ?? "").replace(/^0x/, "");
  if (!/^[0-9a-f]*$/.test(h) || h.length % 64 !== 0 || h.length < 128) throw new Error("aggregate3 answer is not ABI words");
  const words = h.length / 64;
  const num = (i) => { if (i < 0 || i >= words) throw new Error("aggregate3 answer is truncated"); const v = BigInt("0x" + wordAt(h, i)); if (v > BigInt(h.length)) throw new Error("aggregate3 offset out of range"); return Number(v); };
  const base = num(0) / 32;
  if (!Number.isInteger(base)) throw new Error("aggregate3 offset not word-aligned");
  const n = num(base);
  if (n !== sizes.length) throw new Error(`aggregate3 returned ${n} results for ${sizes.length} calls`);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = base + 1 + num(base + 1 + i) / 32;
    if (!Number.isInteger(t)) throw new Error("aggregate3 tuple offset not word-aligned");
    const ok = num(t);
    if (ok !== 1) throw new Error(ok === 0 ? `sub-call ${i} failed` : `sub-call ${i}: success is not a bool`);
    const b = t + num(t + 1) / 32;
    if (!Number.isInteger(b)) throw new Error("aggregate3 bytes offset not word-aligned");
    const len = num(b);
    if (len !== sizes[i]) throw new Error(`sub-call ${i} returned ${len} bytes, not ${sizes[i]}`);
    if (b + 1 + Math.ceil(len / 32) > words) throw new Error("aggregate3 answer is truncated");
    out.push(h.slice(64 * (b + 1), 64 * (b + 1) + len * 2));
  }
  return out;
}

/** StateView getSlot0 + getLiquidity for each id at `blockTag`, chunked; returns {id → {sqrtPriceX96, tick, liquidity}}. */
export async function readPools(call, stateView, ids, blockTag, chunk = 150) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk);
    const calls = part.flatMap((id) => [{to: stateView, data: SEL.getSlot0 + id.slice(2)}, {to: stateView, data: SEL.getLiquidity + id.slice(2)}]);
    const res = decodeAggregate3(await call("eth_call", [{to: MULTICALL3, data: encodeAggregate3(calls)}, blockTag]), part.flatMap(() => [128, 32]));
    part.forEach((id, j) => {
      const s = res[2 * j], l = res[2 * j + 1];
      const tick = int24(wordAt(s, 1));
      if (tick === null) throw new Error(`getSlot0(${id}): tick out of range`);
      out.set(id, {sqrtPriceX96: BigInt("0x" + wordAt(s, 0)), tick, liquidity: BigInt("0x" + l)});
    });
  }
  return out;
}

const RANGE = /block range|range|too large|limited to|exceed|max(imum)? .*block|more than|response size|logs count|too many|result/i;
/** eth_getLogs over [from, to] in `window`-block steps, halving a window the node refuses. At most `maxCalls` calls. */
export async function scanLogs(call, {poolManager, topics, from, to, window, maxCalls}) {
  const logs = [];
  let calls = 0, a = from, win = window;
  while (a <= to) {
    if (calls >= maxCalls) return {logs, scannedTo: a - 1, calls};
    const b = Math.min(to, a + win - 1);
    calls++;
    let got;
    try {
      got = await call("eth_getLogs", [{address: poolManager, topics, fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16)}]);
    } catch (e) {
      if (e.rpcError && RANGE.test(e.message) && b > a) { win = Math.max(1, Math.floor((b - a + 1) / 2)); continue; }
      throw e;
    }
    if (!Array.isArray(got)) throw new Error("eth_getLogs answered a non-array");
    logs.push(...got.map((l) => ({...l, _from: a, _to: b})));
    a = b + 1;
  }
  return {logs, scannedTo: to, calls};
}

const label = (p) => `${p.currency0.slice(0, 8)}…/${p.currency1.slice(0, 8)}… ${p.fee}/${p.tickSpacing}`;
const canonicalValue = (pending, dead) => JSON.stringify({dead: dead.map((d) => d.id).sort(), pending: pending.map((p) => `${p.id}:${p.live ? 1 : 0}`).sort()});

/**
 * One run. `call(method, params)` = the state RPC (eth_blockNumber, eth_call), `logsCall` = the log RPC (eth_getLogs and its
 * eth_blockNumber); both throw on failure. `prev` = the stored meta of the last run (undefined on the first). `list` =
 * {tokens, pools, feeCap} of the chain from the module's built pin list. Returns {value, meta, problems}.
 */
export async function runInitializeSource(s, {call, logsCall = call, prev, list}) {
  if (!list || !Array.isArray(list.tokens) || !Array.isArray(list.pools)) throw new Error(`no pinned v4 pool list for chain ${s.chainId}`);
  for (const k of ["poolManager", "stateView"]) if (list[k] && lc(list[k]) !== lc(s[k])) throw new Error(`the manifest's ${k} ${s[k]} is not the one the pinned list was built from (${list[k]})`);
  const feeCap = s.feeCap ?? FEE_CAP;
  if (!Number.isInteger(feeCap) || feeCap < 1 || feeCap > FEE_CAP) throw new Error("feeCap must be 1..100000");
  const window = s.window ?? 10_000, maxCalls = s.maxCalls ?? 300, confirm = s.confirm ?? 20;
  const tokens = new Set(list.tokens.map(lc));
  const listedIds = new Set(list.pools.map((p) => lc(p.id)));
  const headState = Number(BigInt(await call("eth_blockNumber", [])));
  const headLogs = logsCall === call ? headState : Number(BigInt(await logsCall("eth_blockNumber", [])));
  const target = Math.min(headState, headLogs) - confirm;
  const from = prev?.lastBlock != null ? prev.lastBlock + 1 : target + 1;

  // New pools since the last run.
  const topicList = [...tokens].sort().map((t) => "0x" + t.slice(2).padStart(64, "0"));
  const seen = new Map(Object.entries(prev?.seen ?? {}));
  let scannedTo = Math.max(from - 1, prev?.lastBlock ?? target), calls = 0;
  if (from <= target) {
    const r = await scanLogs(logsCall, {poolManager: s.poolManager, topics: [INITIALIZE_TOPIC, null, topicList, topicList], from, to: target, window, maxCalls});
    scannedTo = r.scannedTo;
    calls = r.calls;
    for (const log of r.logs) {
      const d = decodeInitialize(log, s.poolManager);
      if (d.error) throw new Error(`eth_getLogs: ${d.error}`);
      if (d.block < log._from || d.block > log._to) throw new Error(`eth_getLogs: a log at block ${d.block} outside ${log._from}..${log._to}`);
      if (disqualify(d, tokens, feeCap) || listedIds.has(d.id)) continue;
      seen.set(d.id, {currency0: d.currency0, currency1: d.currency1, fee: d.fee, tickSpacing: d.tickSpacing, block: d.block, live: false});
    }
  }
  for (const id of [...seen.keys()]) if (listedIds.has(id)) seen.delete(id); // a rebuild listed it

  // Liveness of the listed pools and of the unlisted ones, at one block.
  const listedKeys = new Map(list.pools.map((p) => [lc(p.id), p]));
  const ids = [...listedKeys.keys(), ...seen.keys()];
  const states = ids.length ? await readPools(call, s.stateView, ids, "0x" + target.toString(16)) : new Map();
  const deadRuns = {};
  for (const [id, p] of listedKeys) {
    const live = isLive(states.get(id), p.tickSpacing);
    const runs = live ? 0 : (prev?.deadRuns?.[id] ?? 0) + 1;
    if (runs) deadRuns[id] = runs;
  }
  for (const [id, p] of seen) seen.set(id, {...p, live: isLive(states.get(id), p.tickSpacing)});

  const pending = [...seen].map(([id, p]) => ({id, label: label(p), ...p})).sort((a, b) => (a.id < b.id ? -1 : 1));
  const dead = Object.entries(deadRuns).filter(([, n]) => n >= DEAD_RUNS).map(([id, runs]) => ({id, label: label(listedKeys.get(id)), runs})).sort((a, b) => (a.id < b.id ? -1 : 1));
  const behind = target - scannedTo;
  const meta = {lastBlock: scannedTo, readAt: target, calls, listed: listedKeys.size, seen: Object.fromEntries(seen), deadRuns, pending, dead, ...(behind > 0 ? {behind} : {})};
  const problems = behind > 0 ? [`Initialize index ${behind} blocks behind block ${target} (${calls} eth_getLogs this run; catching up)`] : [];
  return {value: canonicalValue(pending, dead), meta, problems};
}

/** The digest line for a change between two stored readings. */
export function describeInitialize(before, after) {
  const B = new Map((before?.pending ?? []).map((p) => [p.id, p])), A = new Map((after?.pending ?? []).map((p) => [p.id, p]));
  const parts = [];
  for (const [id, p] of A) {
    const was = B.get(id);
    if (!was) parts.push(`new hookless pool ${p.label} ${id.slice(0, 10)}… at block ${p.block}${p.live ? " — live: rebuild the list + release" : " (not live yet)"}`);
    else if (p.live && !was.live) parts.push(`${p.label} ${id.slice(0, 10)}… is live now — rebuild the list + release`);
    else if (!p.live && was.live) parts.push(`${p.label} ${id.slice(0, 10)}… is no longer live`);
  }
  for (const [id, p] of B) if (!A.has(id)) parts.push(`${p.label} ${id.slice(0, 10)}… left the unlisted set (now listed, or the list changed)`);
  const DB = new Set((before?.dead ?? []).map((d) => d.id));
  const DA = new Set((after?.dead ?? []).map((d) => d.id));
  for (const d of after?.dead ?? []) if (!DB.has(d.id)) parts.push(`listed pool ${d.label} ${d.id.slice(0, 10)}… dead ${d.runs} runs in a row — removal candidate`);
  for (const d of before?.dead ?? []) if (!DA.has(d.id)) parts.push(`listed pool ${d.label} ${d.id.slice(0, 10)}… is live again`);
  return parts.join("; ") || "pool set changed";
}
