// node --test scripts/watch/watch-2026-11-26-zeroex-canary.test.mjs — 0x's 2026-11-24 Settler release (UNISWAP-V4-RESEARCH
// §7.4, gaps G2, G4, G5): the watch flagged it, but
//   G2 the canary note was the last four lines cut to 300 characters (Telegram: 160), and one NEW line is longer than
//      that, so only one of seven chains was named. verify:live now ends a failed run with `Reason:` (every chain that is
//      not ok, by verdict); the note leads with it, whole, and the Telegram cut keeps it whole.
//   G4 verify:live counted a chain no RPC answered as ok (exit 0), had no Monad endpoint, and the canary's 0x job passed
//      none of our RPCs. An unreachable chain now fails the run; the job gets RPC_<chainId> for every RPC variable set.
//   G5 a new deployment on a pinned chain refuses native-coin sales from that day but read like any failure. verify:live
//      prints `Severity: high` then; the canary keeps it on the job (state, day file, Telegram).
// The real 0x verify-live runs offline here (fetch stubbed per chain, no key, nothing leaves the machine), like
// watch-2026-11-15-across-fees.test.mjs; the canary runs in a sandbox with a stand-in job.
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {NOTE_MAX, REASON_MAX, failingLines, noteOf, retryTextOf, rpcOverrides, runStatus, severityOf, shortNote} from "./canary-status.mjs";
import {RATE_LIMIT_WAIT_MS, RETRY_WAIT_MS, retryWaitMs} from "./retry-wait.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "../../packages/protocol-swap2-0x");
const built = existsSync(resolve(pkg, "dist/index.js"));

// ── the note, the severity, the RPC overrides ───────────────────────────────

// The shape of the 2026-11-25 run (verify-live-no-quotes.txt in the research data): seven NEW lines, each longer than 300.
const NEW_LINE = (id, name) => `NEW chain   ${String(id).padEnd(6)} ${name.padEnd(16)} Settler 0x7130a552999c7e2cae6b38f9336e90c457abd47d (deployment 23; pinned 22 / previous 21, token sales up to 24), previous 0x103502909141f7025a94b7b99a276dcd128e21a8 (deployment 22) · registry impl 0x0e992c001e375785846eeb9cd69411b53f30f24b owner 0xf36b9f50e59870a24f42f9ba43b2ad0a4b8f2f51 — 0x deployed Settler 23: native-coin sales to it are refused until newestLiveNonce / previousLiveNonce for chain ${id} are raised in src/chains.ts (token sales use it inside the margin) — check it, then raise them`;
const SEVEN = [[42161, "Arbitrum"], [1, "Ethereum"], [10, "Optimism"], [56, "BNB Smart Chain"], [137, "Polygon"], [8453, "Base"], [43114, "Avalanche"]];
const clean = (s) => String(s).replace(/https?:\/\/\S+/g, "<url>").replace(/\s+/g, " ").trim();
const SEVEN_SEVERITY = "Severity: high — sales through the Settler in force are refused today: native-coin sales on 1, 10, 56, 137, 8453, 42161, 43114 (a new deployment): check it, then update the pins in src/chains.ts";

test("a failed 0x run's note names every chain that is not ok, whole, and the Telegram cut keeps them", () => {
  assert.ok(NEW_LINE(1, "Ethereum").length > NOTE_MAX, "one NEW line is longer than the whole note");
  const reason = "Reason: NEW on 1, 10, 56, 137, 8453, 42161, 43114";
  const out = [...SEVEN.map(([id, name]) => NEW_LINE(id, name)), "FAILED (7)", SEVEN_SEVERITY, reason].join("\n");
  const r = runStatus({code: 1, signal: null, out});
  assert.equal(r.status, "fail");
  assert.equal(r.severity, "high");
  const note = noteOf(r);
  // the Reason line whole, then the first failing line in the room that is left (review 2026-11-26, LIVE-2)
  assert.equal(note, `${reason} | ${clean(NEW_LINE(42161, "Arbitrum")).slice(0, NOTE_MAX - reason.length - 3)}`);
  assert.equal(note.length, NOTE_MAX);
  for (const [id] of SEVEN) assert.match(note.slice(0, reason.length), new RegExp(`\\b${id}\\b`));
  assert.equal(shortNote(note, 160), `${reason} | …`);
  assert.equal(shortNote(note, 20), `${reason} | …`, "a Reason part is never cut to make a line shorter");
});

test("a Reason line and no cause line: the note fills its room with the job's failing lines, never with the Severity / count lines", () => {
  // Live 2026-11-26 with a bogus ZEROEX_API_KEY: the note was `Reason: BAD quote on 143` alone, the HTTP 401 dropped.
  const ok = (id) => `ok  chain   ${String(id).padEnd(6)} Chain            Settler 0x${"1".repeat(40)} (deployment 22; pinned 22 / previous 21, token sales up to 24)`;
  const keyRejected = "BAD quote   Monad MON → AUSD (native)              zeroex: API key rejected (HTTP 401) [key_rejected]";
  let r = runStatus({code: 1, signal: null, out: [ok(1), ok(8453), keyRejected, "FAILED (1)", "Reason: BAD quote on 143"].join("\n")});
  assert.equal(noteOf(r), `Reason: BAD quote on 143 | ${clean(keyRejected)}`);
  assert.deepEqual(failingLines(r.lines), [keyRejected]);
  // a BAD chain names its failing checks on its own line, and the note keeps them
  const badChain = "BAD chain   143    Monad            failing: owner, settler, pins · Settler — (deployment ?; pinned 12 / previous 11, token sales up to 14) · registry impl 0x1d owner —";
  r = runStatus({code: 1, signal: null, out: [ok(1), badChain, "FAILED (1)", "Severity: high — x", "Reason: BAD on 143"].join("\n")});
  assert.equal(noteOf(r), `Reason: BAD on 143 | ${clean(badChain)}`);
  assert.match(noteOf(r), /failing: owner, settler, pins/);
  // no tagged line: the last four lines that are not Reason / Severity / FAILED
  r = runStatus({code: 1, signal: null, out: ["a", "b", "c", "d", "e", "FAILED (2)", "Severity: high — x", "Reason: BAD on 1"].join("\n")});
  assert.equal(noteOf(r), "Reason: BAD on 1 | b | c | d | e");
});

test("the retry wait sees a 429 on any failing corridor of a Reason run, not only the ones the note has room for", () => {
  const bad = (i, why) => `BAD quote   Corridor ${i} ${"x".repeat(60)} zeroex: ${why}`;
  const lines = [bad(1, "no route [no_route]"), bad(2, "no route [no_route]"), bad(3, "no route [no_route]"), bad(4, "no route [no_route]"), bad(5, "rate limited (HTTP 429) [upstream_unavailable]"), "FAILED (5)", "Reason: BAD quote on 8453"];
  const r = runStatus({code: 1, signal: null, out: lines.join("\n")});
  assert.doesNotMatch(noteOf(r), /429/, "the fifth corridor is past the note's room");
  assert.match(retryTextOf(r), /HTTP 429/);
  assert.equal(retryWaitMs(retryTextOf(r)), RATE_LIMIT_WAIT_MS);
  // a run without a Reason line: the note alone, as before
  const plain = {status: "fail", lines: ["one", "two", "Error: boom"], soft: []};
  assert.equal(retryTextOf(plain), noteOf(plain));
  assert.equal(retryWaitMs(retryTextOf(plain)), RETRY_WAIT_MS);
  assert.equal(retryTextOf({status: "warn", lines: ["Reason: x", "BAD 429"], soft: ["warn"]}), "warn");
});

test("a note is at most NOTE_MAX long without a Reason part and at most REASON_MAX with one", () => {
  const long = (n) => `Reason: NEW on ${Array.from({length: n}, (_, i) => i + 1).join(", ")}`;
  for (const n of [1, 5, 40, 60, 80, 120, 400]) {
    const note = noteOf({status: "fail", lines: [`BAD chain ${"y".repeat(400)}`, "TypeError: z", long(n)], soft: []});
    assert.ok(note.length <= Math.max(NOTE_MAX, REASON_MAX), `${n}: ${note.length}`);
    if (long(n).length + 3 < NOTE_MAX) assert.equal(note.length, Math.min(NOTE_MAX, long(n).length + 3 + "TypeError: z".length), String(n));
  }
  assert.ok(noteOf({status: "fail", lines: ["x".repeat(900)], soft: []}).length <= NOTE_MAX);
});

test("the Reason part leads; cause lines fill what room is left; a long Reason is capped, not dropped", () => {
  const lines = ["TypeError: fetch failed", "BAD quote Base USDC → ETH (Permit2) boom", "FAILED (2)", "Reason: unreachable on 143; BAD quote on 8453"];
  const note = noteOf({status: "fail", lines, soft: []});
  assert.equal(note, "Reason: unreachable on 143; BAD quote on 8453 | TypeError: fetch failed");
  assert.equal(shortNote(note, 30), "Reason: unreachable on 143; BAD quote on 8453 | …");
  const long = `Reason: NEW on ${Array.from({length: 400}, (_, i) => i + 1).join(", ")}`;
  const capped = noteOf({status: "fail", lines: [long], soft: []});
  assert.equal(capped.length, 600);
  assert.ok(capped.startsWith("Reason: NEW on 1, 2, 3") && capped.endsWith("…"));
});

test("without a Reason line the note is what it was: cause lines, else the last four lines, URLs cut, at most 300", () => {
  // The rule before 2026-11-26, as canary.mjs had it inline (Reason was then one of the cause names).
  const before = ({status, lines, soft}) => {
    const cause = [...new Set(lines.map((l) => l.trim()).filter((l) => /^(\w*Error: |(Details|Status|Reason|function): )/.test(l)))].slice(0, 4);
    return (status === "fail" ? (cause.length ? cause : lines.slice(-4)).join(" | ") : soft.slice(0, 3).join(" | ")).replace(/https?:\/\/\S+/g, "<url>").replace(/\s+/g, " ").slice(0, 300);
  };
  const runs = [
    {status: "fail", lines: ["a", "b", "HTTP request failed.", "Status: 429", "URL: https://rpc.example/key123", "Details: Too Many Requests", "Version: viem@2"], soft: []},
    {status: "fail", lines: ["one", "two", "three", "four", "five https://x.example/secret"], soft: []},
    {status: "fail", lines: ["x".repeat(500)], soft: []},
    {status: "warn", lines: [], soft: ["reserve → Error: frozen", "cap reached FAILED", "3", "4"]},
    {status: "ok", lines: ["ok"], soft: []},
  ];
  for (const r of runs) assert.equal(noteOf(r), before(r), JSON.stringify(r).slice(0, 80));
  assert.doesNotMatch(noteOf(runs[1]), /secret|x\.example/);
  assert.equal(shortNote("plain note without a reason", 5), "plain");
});

test("severity: the highest a run reports for itself, none when it reports none", () => {
  assert.equal(severityOf(["Severity: low", "Severity: HIGH — x", "Severity: medium"]), "high");
  assert.equal(severityOf(["severity: medium"]), "medium");
  assert.equal(severityOf(["ok", "Severity: urgent", "the Severity: high is quoted", " Severity:high"]), null);
  assert.equal(runStatus({code: 0, signal: null, out: "ok\n"}).severity, null);
});

test("RPC overrides: RPC_<chainId> for every RPC variable that is set, nothing for the rest", () => {
  const names = {1: "EVM_RPC_URL", 143: "MONAD_RPC_URL", 8453: "BASE_RPC_URL", 10: "OPTIMISM_RPC_URL"};
  assert.deepEqual(rpcOverrides({EVM_RPC_URL: "https://a.example/k", MONAD_RPC_URL: "https://m.example/k", OPTIMISM_RPC_URL: ""}, names), {RPC_1: "https://a.example/k", RPC_143: "https://m.example/k"});
  assert.deepEqual(rpcOverrides({}, names), {});
});

test("RPC overrides: ours first, the chain's public endpoint after it as the retry (review 2026-11-26, F2)", () => {
  const names = {1: "EVM_RPC_URL", 143: "MONAD_RPC_URL", 8453: "BASE_RPC_URL", 10: "OPTIMISM_RPC_URL"};
  const pub = {1: "https://eth.public.example", 143: "https://rpc.monad.example", 10: "https://op.public.example"};
  assert.deepEqual(rpcOverrides({EVM_RPC_URL: "https://a.example/k", MONAD_RPC_URL: "https://m.example/k", BASE_RPC_URL: "https://b.example/k", OPTIMISM_RPC_URL: ""}, names, pub), {
    RPC_1: "https://a.example/k,https://eth.public.example",
    RPC_143: "https://m.example/k,https://rpc.monad.example",
    RPC_8453: "https://b.example/k", // no public endpoint known: ours alone
  });
  assert.deepEqual(rpcOverrides({EVM_RPC_URL: "https://eth.public.example"}, names, pub), {RPC_1: "https://eth.public.example"}, "ours is the public one: not twice");
  assert.deepEqual(rpcOverrides({}, names, pub), {});
});

// ── the real 0x verify-live, offline ────────────────────────────────────────

const SLOT_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const word = (hex) => "0x" + hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/**
 * One world per chain of the 0x table: `[current, previous]` deployment nonces the registry names, or "down" (every
 * request on that chain fails as an unreachable host does). Runs scripts/verify-live.mjs --no-quotes with RPC_<id>
 * pointing each chain at its own stub URL (`urls[id]` instead, when given). The stub's host says how the endpoint
 * behaves: rpc.test answers; down.test is unreachable; wrong.test answers for chain 1; rl.test answers ownerOf(2)
 * with a JSON-RPC rate-limit error (-32005, as rpc.monad.xyz does), every time; flaky.test does that on the first
 * ownerOf(2) only; paused.test reverts ownerOf(2) (a paused registry).
 */
async function verifyLive(world, urls = {}) {
  const m = await import(pathToFileURL(resolve(pkg, "dist/index.js")).href);
  const chains = {};
  for (const [id, c] of Object.entries(m.ZEROEX_CHAINS)) {
    const w = world[id] ?? [c.newestLiveNonce, c.previousLiveNonce];
    chains[id] = w === "down" ? "down" : {
      registry: c.registry.toLowerCase(), impl: "0x" + "1d".repeat(20), owner: "0xf36b9f50e59870a24f42f9ba43b2ad0a4b8f2f51",
      current: m.zeroExSettlerAddress(Number(id), w[0]).toLowerCase(), prev: m.zeroExSettlerAddress(Number(id), w[1]).toLowerCase(),
      code: [c.registry, m.ZEROEX_PERMIT2, c.wrappedNative].map((a) => a.toLowerCase()),
    };
  }
  const stub = `globalThis.fetch = async (url, init) => {
    const W = ${JSON.stringify(chains)}, SLOT = ${JSON.stringify(SLOT_IMPL)}, word = ${word.toString()};
    const host = new URL(String(url)).hostname, id = String(url).split("/").pop(), c = W[id];
    if (!c || c === "down" || host === "down.test") throw new TypeError("fetch failed");
    const {method, params} = JSON.parse(init.body);
    const ok = (result) => new Response(JSON.stringify({jsonrpc: "2.0", id: 1, result}), {headers: {"content-type": "application/json"}});
    const fail = (code, message) => new Response(JSON.stringify({jsonrpc: "2.0", id: 1, error: {code, message}}), {headers: {"content-type": "application/json"}});
    if (method === "eth_chainId") return ok("0x" + Number(host === "wrong.test" ? 1 : id).toString(16));
    if (method === "eth_call" && params[0].data.startsWith("0x6352211e")) {
      if (host === "rl.test") return fail(-32005, "request rate exceeded");
      if (host === "flaky.test" && (globalThis.flaky = (globalThis.flaky ?? 0) + 1) === 1) { process.stderr.write("stub: ownerOf(2) rate-limited once\\n"); return fail(-32005, "request rate exceeded"); }
      if (host === "paused.test") return fail(3, "execution reverted");
    }
    if (method === "eth_getStorageAt") return ok(params[1] === SLOT && params[0].toLowerCase() === c.registry ? word(c.impl) : word("0"));
    if (method === "eth_getCode") { const a = params[0].toLowerCase(); return ok([...c.code, c.impl, c.current, c.prev].includes(a) ? "0x" + "ab".repeat(58) : "0x"); }
    if (method === "eth_call") {
      const d = params[0].data;
      if (d === "0x8da5cb5b") return ok(word(c.owner));
      if (d.startsWith("0x6352211e")) return ok(word(c.current));
      if (d.startsWith("0xe2603dc2")) return ok(word(c.prev));
    }
    return new Response(JSON.stringify({jsonrpc: "2.0", id: 1, error: {code: -32601, message: "no"}}));
  };`;
  const env = {...process.env};
  delete env.ZEROEX_API_KEY;
  for (const k of Object.keys(env)) if (/^RPC_\d+$/.test(k)) delete env[k];
  for (const id of Object.keys(chains)) env[`RPC_${id}`] = urls[id] ?? `http://rpc.test/${id}`;
  const r = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(stub)}`, "scripts/verify-live.mjs", "--no-quotes"], {cwd: pkg, env, encoding: "utf8", timeout: 60_000});
  const out = `${r.stdout}${r.stderr}`;
  return {code: r.status, out, lines: out.trim().split("\n"), canary: runStatus({code: r.status, signal: r.signal, out})};
}

test("verify:live: every chain of the table, Monad included, ok on its pins — exit 0, no Reason, no Severity", {skip: !built && "build protocol-swap2-0x first"}, async () => {
  const r = await verifyLive({});
  assert.equal(r.code, 0, r.out);
  const okChains = r.lines.filter((l) => /^ok {2}chain /.test(l));
  assert.equal(okChains.length, 8, r.out);
  assert.ok(okChains.some((l) => /chain {3}143 {4}Monad .*deployment 12; pinned 12 \/ previous 11, token sales up to 14\), previous 0x031d28683ffc9936903a31670bc618b8bc9b65dd \(deployment 11\)/.test(l)), r.out);
  assert.equal(r.lines.at(-1), "ok");
  assert.doesNotMatch(r.out, /^(Reason|Severity):/m);
  assert.equal(r.canary.status, "ok");
  assert.equal(r.canary.severity, null);
});

test("verify:live: a new deployment on two pinned chains and Monad unreachable — exit 1, Severity high, the last line names all three", {skip: !built && "build protocol-swap2-0x first"}, async () => {
  const m = await import(pathToFileURL(resolve(pkg, "dist/index.js")).href);
  const next = (id) => [m.ZEROEX_CHAINS[id].newestLiveNonce + 1, m.ZEROEX_CHAINS[id].newestLiveNonce];
  const r = await verifyLive({1: next(1), 8453: next(8453), 143: "down"});
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^NEW chain {3}1 /m);
  assert.match(r.out, /^NEW chain {3}8453 /m);
  assert.match(r.out, /^\?\?\? chain {3}143 {4}Monad {12}no RPC answered \(2 tries, RPC_143; last: fetch failed\) — the chain is unchecked, which fails this run$/m);
  assert.doesNotMatch(r.out, /rpc\.test/, "no RPC URL is printed");
  assert.deepEqual(r.lines.slice(-3), [
    "FAILED (3)",
    "Severity: high — sales through the Settler in force are refused today: native-coin sales on 1, 8453 (a new deployment): check it, then update the pins in src/chains.ts",
    "Reason: NEW on 1, 8453; unreachable on 143",
  ]);
  assert.equal(r.canary.status, "fail");
  assert.equal(r.canary.severity, "high");
  const reason = "Reason: NEW on 1, 8453; unreachable on 143";
  const note = noteOf(r.canary);
  assert.ok(note.startsWith(`${reason} | `) && note.length <= NOTE_MAX, note);
  // the room after the Reason part goes to the job's own failing lines, in the order it printed them
  const tagged = r.lines.filter((l) => /^(NEW|\?\?\?) chain/.test(l)).map(clean);
  assert.equal(note, `${reason} | ${tagged.join(" | ").slice(0, NOTE_MAX - reason.length - 3)}`);
});

test("verify:live: Monad unreachable alone fails the run (it was `ok — no RPC for 143` before), with no severity", {skip: !built && "build protocol-swap2-0x first"}, async () => {
  const r = await verifyLive({143: "down"});
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(r.lines.slice(-2), ["FAILED (1)", "Reason: unreachable on 143"]);
  assert.equal(r.canary.status, "fail");
  assert.equal(r.canary.severity, null);
});

test("verify:live: past the margin (every sale refused) and a rollback below the pinned previous are high; another previous alone is not", {skip: !built && "build protocol-swap2-0x first"}, async () => {
  const m = await import(pathToFileURL(resolve(pkg, "dist/index.js")).href);
  const b = m.ZEROEX_CHAINS[8453], e = m.ZEROEX_CHAINS[1], o = m.ZEROEX_CHAINS[10];
  const r = await verifyLive({8453: [b.newestLiveNonce + 3, b.newestLiveNonce + 2], 1: [e.previousLiveNonce - 1, e.previousLiveNonce - 2], 10: [o.newestLiveNonce, o.previousLiveNonce - 1]});
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^PIN chain {3}8453 /m);
  assert.match(r.out, /^OLD chain {3}1 /m);
  assert.match(r.out, /^PREV chain {3}10 /m);
  assert.equal(r.lines.at(-1), "Reason: PIN on 8453; OLD on 1; PREV on 10");
  // what is refused and why, per chain (it said "a new deployment: native-coin sales" for every case before)
  assert.equal(r.lines.at(-2), "Severity: high — sales through the Settler in force are refused today: every sale on 8453 (a new deployment past the margin); every sale on 1 (a rollback below the pinned previous): check it, then update the pins in src/chains.ts");
});

// ── review 2026-11-26: an RPC fault is never a refused sale ─────────────────

test("verify:live: Monad's ownerOf(2) answered with a JSON-RPC rate limit on both tries — unreachable, no Severity (it was BAD, severity high)", {skip: !built && "build protocol-swap2-0x first"}, async () => {
  const r = await verifyLive({}, {143: "http://rl.test/143"});
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /^BAD chain/m);
  assert.doesNotMatch(r.out, /^Severity:/m);
  assert.match(r.out, /^\?\?\? chain {3}143 {4}Monad {12}no RPC answered \(2 tries, RPC_143; last: eth_call: RPC error -32005 request rate exceeded\) — the chain is unchecked, which fails this run$/m);
  assert.deepEqual(r.lines.slice(-2), ["FAILED (1)", "Reason: unreachable on 143"]);
  assert.equal(r.canary.severity, null);
  assert.doesNotMatch(r.out, /rl\.test/, "no RPC URL is printed");
});

test("verify:live: a rate limit on the first ownerOf(2) only is retried — ok", {skip: !built && "build protocol-swap2-0x first"}, async () => {
  const r = await verifyLive({}, {143: "http://flaky.test/143"});
  assert.equal(r.code, 0, r.out);
  assert.equal(r.lines.filter((l) => l === "stub: ownerOf(2) rate-limited once").length, 1, "the first read was refused");
  assert.match(r.out, /^ok {2}chain {3}143 /m);
  assert.equal(r.lines.filter((l) => !l.startsWith("stub: ")).at(-1), "ok");
});

test("verify:live: RPC_<id>=url,url — the second is tried when the first is down, or answers for another chain", {skip: !built && "build protocol-swap2-0x first"}, async () => {
  for (const first of ["http://down.test/143", "http://wrong.test/143", "http://rl.test/143"]) {
    const r = await verifyLive({}, {143: `${first},http://rpc.test/143`});
    assert.equal(r.code, 0, `${first}: ${r.out}`);
    assert.match(r.out, /^ok {2}chain {3}143 {4}Monad /m, first);
    assert.doesNotMatch(r.out, /^(Reason|Severity):/m, first);
  }
  // both answer for another chain: unchecked, which fails the run, and says why (it read Ethereum's registry as BAD before)
  const r = await verifyLive({}, {143: "http://wrong.test/143,http://wrong.test/143"});
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^\?\?\? chain {3}143 .*last: the RPC answered for chain 1\)/m);
  assert.doesNotMatch(r.out, /^Severity:/m);
  assert.equal(r.lines.at(-1), "Reason: unreachable on 143");
});

test("verify:live: a registry that reverts ownerOf(2) (paused) is the chain's answer — BAD, severity high, its failing checks on its line", {skip: !built && "build protocol-swap2-0x first"}, async () => {
  const r = await verifyLive({}, {143: "http://paused.test/143"});
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^BAD chain {3}143 {4}Monad {12}failing: settler, pins · Settler — \(deployment \?; pinned 12 \/ previous 11, token sales up to 14\), previous /m);
  assert.deepEqual(r.lines.slice(-3), [
    "FAILED (1)",
    "Severity: high — sales through the Settler in force are refused today: every sale on 143 (the registry names no Settler this module can tell): check the registry and the Settler it names (no pin raise fixes it)",
    "Reason: BAD on 143",
  ]);
  assert.equal(r.canary.severity, "high");
  assert.match(noteOf(r.canary), /^Reason: BAD on 143 \| BAD chain 143 Monad failing: settler, pins · Settler — /);
});

// ── the canary hands the 0x job our RPCs, and keeps its Reason and Severity ─

test("the canary's zeroex job gets RPC_<chainId> for every RPC variable set; its note is the job's Reason line and its severity is kept", async () => {
  const root = mkdtempSync(join(tmpdir(), "canary-1126-"));
  mkdirSync(join(root, "scripts/watch"), {recursive: true});
  for (const f of ["canary.mjs", "canary-status.mjs", "html-text.mjs", "retry-wait.mjs"]) copyFileSync(join(here, f), join(root, "scripts/watch", f));
  mkdirSync(join(root, "watch"), {recursive: true});
  writeFileSync(join(root, "watch/addresses.json"), JSON.stringify({eip155: "0x0000000000000000000000000000000000000001", solana: "x", ton: "x"}));
  // A stand-in for the 0x verify-live: it records which RPC_<id> it was given (names, and whether each value is ours,
  // never the value) and ends as a failed run does. The canary retries a failure once, after 20 s.
  const job = join(root, "packages/protocol-swap2-0x/scripts");
  mkdirSync(job, {recursive: true});
  writeFileSync(join(job, "verify-live.mjs"), `import {writeFileSync} from "node:fs";
    const seen = Object.keys(process.env).filter((k) => /^RPC_\\d+$/.test(k)).sort().map((k) => [k, process.env[k].split(",").map((u) => (u.startsWith("http://ours.example/") ? "ours" : u.startsWith("https://") ? "public" : "other")).join("+")]);
    writeFileSync(new URL("./seen.json", import.meta.url), JSON.stringify(seen));
    console.log("${NEW_LINE(143, "Monad").replace(/"/g, '\\"')}");
    console.log("FAILED (1)");
    console.log("Severity: high — sales through the Settler in force are refused today: native-coin sales on 143 (a new deployment): check it, then update the pins in src/chains.ts");
    console.log("Reason: NEW on 143");
    process.exit(1);`);
  const srv = createServer((req, res) => { req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({jsonrpc: "2.0", id: 1, result: "0x10"})); }); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const local = `http://127.0.0.1:${srv.address().port}`;
  try {
    // EVM / Base / Arbitrum answer the canary's own block-number reads (approvals jobs); Monad and Polygon are "ours".
    const env = {PATH: process.env.PATH, EVM_RPC_URL: local, BASE_RPC_URL: local, ARBITRUM_RPC_URL: local, MONAD_RPC_URL: "http://ours.example/monad", POLYGON_RPC_URL: "http://ours.example/polygon", OPTIMISM_RPC_URL: ""};
    const child = spawn(process.execPath, [join(root, "scripts/watch/canary.mjs"), "--only", "zeroex"], {env, stdio: ["ignore", "pipe", "pipe"]});
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 1, err);
    const seen = JSON.parse(readFileSync(join(job, "seen.json"), "utf8"));
    // ours first, the chain's public endpoint after it as the retry (F2: our RPC alone, before)
    assert.deepEqual(seen.filter(([k]) => ["RPC_137", "RPC_143"].includes(k)), [["RPC_137", "ours+public"], ["RPC_143", "ours+public"]]);
    assert.ok(!seen.some(([k]) => k === "RPC_10"), "an empty variable passes nothing");
    assert.deepEqual(seen.filter(([k]) => ["RPC_1", "RPC_8453"].includes(k)), [["RPC_1", "other+public"], ["RPC_8453", "other+public"]]);
    assert.match(err, /^fail +[\d.]+s {2}zeroex \[severity high\] {2}— Reason: NEW on 143 \| …$/m);
    assert.doesNotMatch(err, /ours\.example|127\.0\.0\.1|publicnode|monad\.xyz/, "no RPC URL reaches the canary's output");
    const note = `Reason: NEW on 143 | ${clean(NEW_LINE(143, "Monad")).slice(0, NOTE_MAX - "Reason: NEW on 143".length - 3)}`;
    const state = JSON.parse(readFileSync(join(root, "watch/canary/state.json"), "utf8"));
    assert.deepEqual({...state.zeroex, at: undefined}, {status: "fail", note, severity: "high", at: undefined});
    assert.equal("retryText" in state.zeroex, false, "the retry text is not stored");
    const day = JSON.parse(readFileSync(join(root, "watch/canary", `${new Date().toISOString().slice(0, 10)}.json`), "utf8"));
    assert.deepEqual(day.failing, [{id: "zeroex", status: "fail", note, severity: "high"}]);
    assert.deepEqual(day.transitions, [{id: "zeroex", module: "zeroex", from: "new", to: "fail", note, severity: "high"}]);
  } finally { srv.close(); }
});
