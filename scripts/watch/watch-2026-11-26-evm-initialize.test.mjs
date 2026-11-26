// node --test scripts/watch/watch-2026-11-26-evm-initialize.test.mjs — the stateful `evm-initialize` source (Uniswap v4 pool
// list, UNISWAP-V4-RESEARCH §5.3):
//   - evm-initialize.mjs: PoolId, the strict Initialize decoder, the list's rules, aggregate3 encode / strict decode;
//   - runInitializeSource: the first run takes a baseline at the head; later runs scan from lastBlock + 1, report a new
//     hookless catalog pool under the fee cap (and again when it turns live), ignore hooked / fee-trap / non-catalog / listed
//     pools, report a listed pool once it reads dead three runs in a row, cap the calls per run and say it is behind;
//     a failed read fails the run (nothing advances);
//   - end to end through watch.mjs: state carries over between runs, the digest names the new pool, a failing RPC keeps
//     the previous state, and the source reads the pin list from the package's built entry.
import {test} from "node:test";
import assert from "node:assert/strict";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {DEAD_RUNS, INITIALIZE_TOPIC, ZERO, decodeAggregate3, decodeInitialize, describeInitialize, disqualify, encodeAggregate3, poolIdOf, runInitializeSource} from "./evm-initialize.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PM = "0x188d586ddcf52439676ca21a244753fa19f9ea8e", SV = "0x77395f3b2e73ae90843717371294fa97cc419d64";
const AUSD = "0x00000000efe302beaa2b3e6e1b18d08d69a9012a", USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603", OTHER = "0x530639a4ad89dd2d5ff31ee4a4b5ef01cb8d0656";
const w = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, "0");
const topic = (a) => "0x" + a.slice(2).padStart(64, "0");
function rawLog(key, block, {id = poolIdOf(key), address = PM} = {}) {
  return {address, blockNumber: "0x" + block.toString(16), removed: false, topics: [INITIALIZE_TOPIC, id, topic(key.currency0), topic(key.currency1)],
    data: "0x" + w(key.fee) + w(BigInt.asUintN(256, BigInt(key.tickSpacing))) + w(key.hooks ?? ZERO) + w(1n << 96n) + w(0)};
}
/** Result[] of aggregate3 for return-data hex strings (success unless the entry is null). */
function encodeResults(list) {
  const tuples = list.map((d) => { const h = (d ?? "0x").slice(2); return w(d === null ? 0 : 1) + w(64) + w(h.length / 2) + h.padEnd(Math.ceil(h.length / 64) * 64, "0"); });
  let off = list.length * 32;
  const heads = tuples.map((t) => { const x = w(off); off += t.length / 2; return x; });
  return "0x" + w(32) + w(list.length) + heads.join("") + tuples.join("");
}
const slot0 = (live) => "0x" + w(live ? 1n << 96n : 0n) + w(0) + w(0) + w(500);
const liq = (live) => "0x" + w(live ? 10n ** 18n : 0n);
/** A fake chain: `logs` (raw), `live` (id → bool), `head`. eth_call answers aggregate3 of getSlot0 / getLiquidity. */
function chain({logs = [], live = {}, head = 1000, failCall = false} = {}) {
  const st = {logs, live, head, calls: []};
  st.call = async (method, params) => {
    st.calls.push([method, params]);
    if (method === "eth_blockNumber") return "0x" + st.head.toString(16);
    if (method === "eth_getLogs") {
      const a = Number(BigInt(params[0].fromBlock)), b = Number(BigInt(params[0].toBlock));
      if (st.maxRange && b - a + 1 > st.maxRange) throw Object.assign(new Error("block range too large"), {rpcError: true});
      return st.logs.filter((l) => Number(BigInt(l.blockNumber)) >= a && Number(BigInt(l.blockNumber)) <= b);
    }
    if (method === "eth_call") {
      if (failCall) throw new Error("HTTP 429");
      const items = [...params[0].data.matchAll(/(c815641c|fa6793d5)([0-9a-f]{64})/g)];
      return encodeResults(items.map(([, sel, id]) => (st.failId === "0x" + id ? null : sel === "c815641c" ? slot0(st.live["0x" + id] ?? false) : liq(st.live["0x" + id] ?? false))));
    }
    throw new Error(`unexpected ${method}`);
  };
  return st;
}
const LISTED = {currency0: ZERO, currency1: AUSD, fee: 500, tickSpacing: 1};
const LIST = {tokens: [ZERO, AUSD, USDC], feeCap: 100000, pools: [{...LISTED, id: poolIdOf(LISTED)}]};
const SRC = {chainId: 143, poolManager: PM, stateView: SV, window: 100, confirm: 10};

test("PoolId, the Initialize decoder and the list's rules match the build script", () => {
  assert.equal(poolIdOf(LISTED), "0xadaf30776f551bccdfb307c3fd8cdec198ca9a852434c8022ee32d1ccedd8219", "research vector: Monad NATIVE/AUSD 500/1");
  const k = {currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10};
  const d = decodeInitialize(rawLog(k, 7), PM);
  assert.deepEqual(d, {id: poolIdOf(k), currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10, hooks: ZERO, block: 7});
  assert.match(decodeInitialize(rawLog(k, 7, {address: SV}), PM).error, /not the PoolManager/);
  assert.match(decodeInitialize({...rawLog(k, 7), removed: true}, PM).error, /removed/);
  assert.match(decodeInitialize({...rawLog(k, 7), data: "0x" + w(1n << 24n) + rawLog(k, 7).data.slice(66)}, PM).error, /out of range/);
  const S = new Set([ZERO, AUSD, USDC]);
  assert.equal(disqualify(d, S), null);
  assert.equal(disqualify({...d, hooks: "0x0000000000000000000000000000000000000080"}, S), "hooked");
  assert.equal(disqualify({...d, currency1: OTHER, id: poolIdOf({...k, currency1: OTHER})}, S), "not-catalog");
  assert.equal(disqualify({...d, fee: 990000, id: poolIdOf({...k, fee: 990000})}, S), "fee-above-cap");
  assert.equal(disqualify({...d, id: "0x" + "11".repeat(32)}, S), "id-mismatch");
});

test("aggregate3: calldata layout and a strict answer decoder (failed sub-call, wrong size, truncation)", () => {
  const id = "0x" + "ab".repeat(32);
  const data = encodeAggregate3([{to: SV, data: "0xc815641c" + id.slice(2)}]);
  assert.equal(data, "0x82ad56cb" + w(32) + w(1) + w(32) + w(SV) + w(1) + w(96) + w(36) + "c815641c" + id.slice(2) + "0".repeat(56));
  assert.deepEqual(decodeAggregate3(encodeResults([slot0(true), liq(true)]), [128, 32]), [slot0(true).slice(2), liq(true).slice(2)]);
  assert.throws(() => decodeAggregate3(encodeResults([null]), [128]), /sub-call 0 failed/);
  assert.throws(() => decodeAggregate3(encodeResults([liq(true)]), [128]), /32 bytes, not 128/);
  assert.throws(() => decodeAggregate3(encodeResults([liq(true)]), [32, 32]), /1 results for 2/);
  assert.throws(() => decodeAggregate3(encodeResults([slot0(true)]).slice(0, -64), [128]), /truncated/);
  assert.throws(() => decodeAggregate3("0x", [32]), /not ABI words/);
});

test("runs: baseline at the head, then new pools from lastBlock + 1; only hookless catalog pools under the cap count", async () => {
  const c = chain({head: 1000});
  const r0 = await runInitializeSource(SRC, {call: c.call, list: LIST});
  assert.equal(r0.meta.lastBlock, 990, "first run: baseline at head − confirm, nothing scanned");
  assert.equal(c.calls.filter(([m]) => m === "eth_getLogs").length, 0);
  assert.deepEqual(JSON.parse(r0.value), {dead: [], pending: []});

  const fresh = {currency0: ZERO, currency1: USDC, fee: 3000, tickSpacing: 60};
  c.logs.push(
    rawLog(fresh, 995),
    rawLog({...fresh, hooks: "0x0000000000000000000000000000000000000080"}, 996),
    rawLog({...fresh, fee: 880000}, 997),
    rawLog({...fresh, currency1: OTHER}, 998),
    rawLog(LISTED, 999),
    rawLog({...fresh, fee: 100}, 980), // before lastBlock: already covered by the baseline
  );
  c.head = 1100;
  c.live[poolIdOf(LISTED)] = true;
  const r1 = await runInitializeSource(SRC, {call: c.call, prev: r0.meta, list: LIST});
  assert.equal(r1.meta.lastBlock, 1090);
  const gl = c.calls.filter(([m]) => m === "eth_getLogs");
  assert.equal(gl[0][1][0].fromBlock, "0x" + (991).toString(16), "scans from lastBlock + 1");
  assert.deepEqual(gl[0][1][0].topics.slice(0, 2), [INITIALIZE_TOPIC, null]);
  assert.deepEqual(r1.meta.pending.map((p) => [p.id, p.live]), [[poolIdOf(fresh), false]]);
  assert.notEqual(r1.value, r0.value);
  assert.match(describeInitialize(r0.meta, r1.meta), /new hookless pool .* 3000\/60 .* at block 995 \(not live yet\)/);

  c.live[poolIdOf(fresh)] = true;
  c.head = 1150;
  const r2 = await runInitializeSource(SRC, {call: c.call, prev: r1.meta, list: LIST});
  assert.notEqual(r2.value, r1.value);
  assert.match(describeInitialize(r1.meta, r2.meta), /is live now — rebuild the list \+ release/);
  const r3 = await runInitializeSource(SRC, {call: c.call, prev: r2.meta, list: LIST});
  assert.equal(r3.value, r2.value, "nothing new: same value, no diff");

  const relisted = {...LIST, pools: [...LIST.pools, {...fresh, id: poolIdOf(fresh)}]};
  const r4 = await runInitializeSource(SRC, {call: c.call, prev: r3.meta, list: relisted});
  assert.deepEqual(r4.meta.pending, [], "a rebuilt list takes the pool out of the unlisted set");
});

test("a listed pool is reported after three dead runs in a row, and once it is live again", async () => {
  const c = chain({head: 500});
  let prev;
  const runs = [];
  for (let i = 0; i < DEAD_RUNS; i++) { const r = await runInitializeSource(SRC, {call: c.call, prev, list: LIST}); runs.push(r); prev = r.meta; c.head += 10; }
  assert.deepEqual(JSON.parse(runs[1].value).dead, [], "two dead runs are not a report");
  assert.deepEqual(JSON.parse(runs[2].value).dead, [poolIdOf(LISTED)]);
  assert.match(describeInitialize(runs[1].meta, runs[2].meta), /dead 3 runs in a row — removal candidate/);
  c.live[poolIdOf(LISTED)] = true;
  const back = await runInitializeSource(SRC, {call: c.call, prev, list: LIST});
  assert.deepEqual(JSON.parse(back.value).dead, []);
  assert.match(describeInitialize(prev, back.meta), /is live again/);
});

test("a failed read fails the run; a capped run says it is behind; a refused window is halved", async () => {
  await assert.rejects(runInitializeSource(SRC, {call: chain({failCall: true}).call, prev: {lastBlock: 900}, list: LIST}), /429/);
  const c = chain({head: 1000});
  c.failId = poolIdOf(LISTED);
  await assert.rejects(runInitializeSource(SRC, {call: c.call, prev: {lastBlock: 900}, list: LIST}), /sub-call 0 failed/);
  await assert.rejects(runInitializeSource(SRC, {call: c.call, list: undefined}), /no pinned v4 pool list/);
  await assert.rejects(runInitializeSource(SRC, {call: c.call, list: {...LIST, poolManager: SV}}), /not the one the pinned list was built from/);
  const slow = chain({head: 10_000});
  const capped = await runInitializeSource({...SRC, maxCalls: 3}, {call: slow.call, prev: {lastBlock: 0}, list: LIST});
  assert.equal(capped.meta.lastBlock, 300);
  assert.equal(capped.meta.behind, 9990 - 300);
  assert.match(capped.problems[0], /behind/);
  const narrow = chain({head: 1000, logs: [rawLog({currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10}, 950)]});
  narrow.maxRange = 30;
  const split = await runInitializeSource(SRC, {call: narrow.call, prev: {lastBlock: 900}, list: LIST});
  assert.equal(split.meta.pending.length, 1);
  assert.ok(narrow.calls.filter(([m]) => m === "eth_getLogs").every(([, p]) => Number(BigInt(p[0].toBlock)) - Number(BigInt(p[0].fromBlock)) + 1 <= 100));
});

// ── end to end through watch.mjs ───────────────────────────────────────────
function sandbox(rpcUrl) {
  const root = mkdtempSync(join(tmpdir(), "watch-1126-"));
  mkdirSync(join(root, "scripts/watch"), {recursive: true});
  for (const f of ["watch.mjs", "html-text.mjs", "pins.mjs", "evm-call.mjs", "zcash-branch.mjs", "evm-initialize.mjs"]) copyFileSync(join(here, f), join(root, "scripts/watch", f));
  const pkg = join(root, "packages/protocol-swap2-uniswap");
  mkdirSync(join(pkg, "dist"), {recursive: true});
  writeFileSync(join(pkg, "dist/v4pools.js"), `export const UNISWAP_V4_POOLS = ${JSON.stringify({1: LIST})};\n`);
  writeFileSync(join(pkg, "watch.json"), JSON.stringify({module: "@anywalletkit/protocol-swap2-uniswap", sources: [
    {id: "v4-pools-ethereum", type: "evm-initialize", chainId: 1, poolManager: PM, stateView: SV, pools: {from: "dist/v4pools.js", export: "UNISWAP_V4_POOLS"}, window: 100, confirm: 10, label: "Uniswap v4 pools · test"},
  ]}));
  return root;
}
async function serve(c) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (x) => (body += x));
    req.on("end", async () => {
      const {method, params} = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      try { res.end(JSON.stringify({jsonrpc: "2.0", id: 1, result: await c.call(method, params)})); }
      catch (e) { res.end(JSON.stringify({jsonrpc: "2.0", id: 1, error: {code: -32000, message: e.message}})); }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {url: `http://127.0.0.1:${server.address().port}`, close: () => server.close()};
}
async function run(root, url, extra = []) {
  const child = spawn(process.execPath, [join(root, "scripts/watch/watch.mjs"), ...extra], {env: {PATH: process.env.PATH, GITHUB_TOKEN: "x", EVM_RPC_URL: url}, stdio: ["ignore", "pipe", "pipe"]});
  let out = "", err = "";
  child.stdout.on("data", (x) => (out += x));
  child.stderr.on("data", (x) => (err += x));
  const code = await new Promise((r) => child.on("close", r));
  return {code, out, err};
}
const stateOf = (root) => JSON.parse(readFileSync(join(root, "watch/state/protocol-swap2-uniswap.json"), "utf8")).sources["v4-pools-ethereum"];

test("watch.mjs: the evm-initialize state carries over, the digest names a new pool, an RPC failure keeps the state", async () => {
  const c = chain({head: 2000, live: {[poolIdOf(LISTED)]: true}});
  const srv = await serve(c);
  try {
    const root = sandbox(srv.url);
    const base = await run(root, srv.url, ["--baseline"]);
    assert.equal(base.code, 0, base.err);
    assert.equal(stateOf(root).meta.lastBlock, 1990);
    const fresh = {currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10};
    c.logs.push(rawLog(fresh, 1995));
    c.live[poolIdOf(fresh)] = true;
    c.head = 2100;
    const day = await run(root, srv.url);
    assert.equal(day.code, 0, day.err);
    assert.match(day.out, /1 changed/);
    assert.match(day.out, /Uniswap v4 pools · test.*new hookless pool .* 500\/10 .* — live: rebuild the list \+ release/);
    assert.equal(stateOf(root).meta.lastBlock, 2090);
    const quiet = await run(root, srv.url);
    assert.match(quiet.out, /0 changed/);
    c.head = 2200;
    const broken = chain({failCall: true, head: 2300});
    c.call = broken.call;
    const down = await run(root, srv.url);
    assert.match(down.out, /1 unreachable/);
    assert.equal(stateOf(root).meta.lastBlock, 2090, "a failed run does not advance the index");
  } finally {
    srv.close();
  }
});

test("coverage: every chain the uniswap module ships a v4 pool list for has an evm-initialize source on the same PoolManager / StateView", async () => {
  const {readdirSync} = await import("node:fs");
  const ROOT = join(here, "../..");
  const dir = join(ROOT, "packages/protocol-swap2-uniswap/src/v4pools");
  const lists = readdirSync(dir).filter((f) => /^\d+\.ts$/.test(f)).map((f) => {
    const text = readFileSync(join(dir, f), "utf8");
    const field = (k) => new RegExp(`^  ${k}: "?([0-9a-fA-Fx]+)"?,$`, "m").exec(text)?.[1];
    return {chainId: Number(field("chainId")), poolManager: field("poolManager")?.toLowerCase(), stateView: field("stateView")?.toLowerCase()};
  });
  assert.ok(lists.length >= 6, `${lists.length} lists`);
  const manifest = JSON.parse(readFileSync(join(ROOT, "packages/protocol-swap2-uniswap/watch.json"), "utf8"));
  const sources = manifest.sources.filter((s) => s.type === "evm-initialize");
  for (const l of lists) {
    assert.ok(l.poolManager && l.stateView, `chain ${l.chainId}: the list names its PoolManager and StateView`);
    const s = sources.find((x) => x.chainId === l.chainId);
    assert.ok(s, `chain ${l.chainId} has an evm-initialize source`);
    assert.equal(s.poolManager.toLowerCase(), l.poolManager, `chain ${l.chainId} PoolManager`);
    assert.equal(s.stateView.toLowerCase(), l.stateView, `chain ${l.chainId} StateView`);
    assert.deepEqual(s.pools, {from: "dist/v4pools.js", export: "UNISWAP_V4_POOLS"});
    if (s.logsRpc) assert.match(s.logsRpc, /^https:\/\/[a-z0-9.-]+(\/[a-z0-9/_-]*)?$/i, "a public endpoint, no key in the manifest");
  }
  assert.deepEqual(sources.map((s) => s.chainId).sort((a, b) => a - b), lists.map((l) => l.chainId).sort((a, b) => a - b), "no source for a chain without a list");
});
