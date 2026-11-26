#!/usr/bin/env node
// Canary: run every Earn / safety module's (and Curve swaps') own read-only `verify:live` across all its
// markets with the public test addresses (watch/addresses.json) and our RPCs, then
// report only what changed since the last run (ok → fail, warn → ok, …) plus
// anything still failing. Nothing is signed or sent on-chain.
//
//   node scripts/watch/canary.mjs [--only aave,morpho] [--timeout 240] [--send] [--dry] [--env FILE] [--retry-wait S]
// --timeout is per job (seconds); a job with its own `timeoutS` gets the longer of the two. --retry-wait sets the wait
// before a failed job's one retry (seconds; by default 20, or 60 after a rate limit: retry-wait.mjs) — for tests.
// State: watch/canary/state.json; today's rows: watch/canary/<date>.json.
import {spawn} from "node:child_process";
import {readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync} from "node:fs";
import {resolve, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {noteOf, retryKept, retryTextOf, rpcOverrides, runStatus, shortNote} from "./canary-status.mjs";
import {fitLines} from "./html-text.mjs";
import {retryWaitMs} from "./retry-wait.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ONLY = opt("--only") ? new Set(opt("--only").split(",")) : null;
const TIMEOUT_MS = Number(opt("--timeout", "240")) * 1000;
const SEND = flag("--send"), DRY = flag("--dry");
const RETRY_WAIT = opt("--retry-wait") === undefined ? null : Number(opt("--retry-wait")) * 1000;
if (RETRY_WAIT !== null && !(RETRY_WAIT >= 0)) throw new Error("--retry-wait takes a number of seconds");
const TODAY = new Date().toISOString().slice(0, 10);
if (opt("--env")) for (const l of readFileSync(resolve(opt("--env")), "utf8").split("\n")) { const i = l.indexOf("="); if (i > 0 && !l.startsWith("#") && !(l.slice(0, i).trim() in process.env)) process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
const env = process.env;
const ADDR = JSON.parse(readFileSync(resolve(ROOT, "watch/addresses.json"), "utf8"));

const RPC_ENV = {
  1: "EVM_RPC_URL", 8453: "BASE_RPC_URL", 42161: "ARBITRUM_RPC_URL", 10: "OPTIMISM_RPC_URL", 137: "POLYGON_RPC_URL", 43114: "AVALANCHE_RPC_URL", 56: "BSC_RPC_URL",
  130: "UNICHAIN_RPC_URL", 59144: "LINEA_RPC_URL", 146: "SONIC_RPC_URL", 324: "ZKSYNC_RPC_URL", 999: "HYPEREVM_RPC_URL", 42220: "CELO_RPC_URL", 100: "GNOSIS_RPC_URL",
  9745: "PLASMA_RPC_URL", 4326: "MEGAETH_RPC_URL", 4663: "ROBINHOOD_RPC_URL", 143: "MONAD_RPC_URL", 534352: "SCROLL_RPC_URL", 80094: "BERACHAIN_RPC_URL",
  480: "WORLDCHAIN_RPC_URL", 1329: "SEI_RPC_URL", 57073: "INK_RPC_URL", 98866: "PLUME_RPC_URL", 196: "XLAYER_RPC_URL",
  747474: "KATANA_RPC_URL", 5000: "MANTLE_RPC_URL", 1868: "SONEIUM_RPC_URL", 1088: "METIS_RPC_URL",
};
const PUBLIC_RPC = {
  1: "https://ethereum-rpc.publicnode.com", 8453: "https://base-rpc.publicnode.com", 42161: "https://arbitrum-one-rpc.publicnode.com", 10: "https://optimism-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com", 56: "https://bsc-rpc.publicnode.com", 43114: "https://avalanche-c-chain-rpc.publicnode.com", 4663: "https://rpc.mainnet.chain.robinhood.com",
  324: "https://mainnet.era.zksync.io", 42220: "https://forno.celo.org", 4326: "https://mainnet.megaeth.com/rpc", 9745: "https://rpc.plasma.to", 59144: "https://rpc.linea.build",
  146: "https://rpc.soniclabs.com", 100: "https://gnosis-rpc.publicnode.com", 130: "https://unichain-rpc.publicnode.com", 143: "https://rpc.monad.xyz", 999: "https://rpc.hyperliquid.xyz/evm",
  534352: "https://rpc.scroll.io", 80094: "https://rpc.berachain.com", 480: "https://worldchain-mainnet.g.alchemy.com/public", 1329: "https://evm-rpc.sei-apis.com",
  57073: "https://rpc-gel.inkonchain.com", 98866: "https://rpc.plume.org", 196: "https://rpc.xlayer.tech",
  1088: "https://andromeda.metis.io/?owner=1088", 1868: "https://rpc.soneium.org", 5000: "https://rpc.mantle.xyz", 747474: "https://rpc.katana.network",
};
const rpcFor = (chainId) => env[RPC_ENV[chainId]] || PUBLIC_RPC[chainId];
const solRpc = env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const tonRpc = env.TON_RPC_URL ? `${env.TON_RPC_URL.replace(/\/$/, "")}/jsonRPC` : "https://toncenter.com/api/v2/jsonRPC";
const nearRpc = env.NEAR_RPC_URL || "https://free.rpc.fastnear.com";
const pkg = (name) => resolve(ROOT, "packages", name, "scripts/verify-live.mjs");

// Same job list as Vaulty's app/scripts/earn-check (kept in sync by hand).
const AAVE = {1: ["core", "lido", "etherfi"], 10: ["core"], 56: ["core"], 100: ["core"], 137: ["core"], 146: ["core"], 324: ["core"], 1088: ["core"], 1868: ["core"], 5000: ["core"], 8453: ["core"], 9745: ["core"], 42161: ["core"], 42220: ["core"], 43114: ["core"], 57073: ["core"], 59144: ["core"], 534352: ["core"]};
const MORPHO = [1, 8453, 42161, 10, 137, 130, 999, 747474, 143, 4663];
const jobs = [];
jobs.push({id: "lido", module: "lido", script: pkg("protocol-staking-lido-evm"), args: [ADDR.eip155, rpcFor(1)]});
jobs.push({id: "ssv", module: "ssv", script: pkg("protocol-staking-ssv-evm"), args: [ADDR.eip155, rpcFor(1)]});
jobs.push({id: "tonstakers", module: "tonstakers", script: pkg("protocol-staking-tonstakers-ton"), args: [ADDR.ton, tonRpc]});
jobs.push({id: "jito", module: "spl-stake-pool", script: pkg("protocol-staking-spl-stake-pool-solana"), args: [ADDR.solana, solRpc]});
// Native staking checks a wallet that holds stake accounts (the script's default), not the empty test address.
jobs.push({id: "native-stake", module: "native-stake", script: pkg("protocol-staking-native-solana"), args: [], env: {SOLANA_RPC: solRpc}});
jobs.push({id: "native-monad", module: "native-monad", script: pkg("protocol-staking-native-monad"), args: [rpcFor(143), "143"]});
// NEAR staking checks real delegators (a pool's get_accounts) and known LiNEAR / rNEAR holders, not the empty test address.
// Without NEAR_RPC_URL both run side by side on the free endpoint (a burst of ~20 requests, then ~1 a second), which sets
// their pace, not the modules: 480 s each (liquid-near took 212–290 s next to native-near on 2026-11-08, native-near up to 300).
jobs.push({id: "native-near", module: "native-near", script: pkg("protocol-staking-native-near"), args: [nearRpc], timeoutS: 480});
jobs.push({id: "liquid-near", module: "liquid-near", script: pkg("protocol-staking-liquid-near"), args: [nearRpc], timeoutS: 480});
for (const preset of ["lido-earn-eth", "lido-earn-usd"]) jobs.push({id: `mellow:${preset}`, module: "mellow", script: pkg("protocol-lending-mellow-evm"), args: [ADDR.eip155, rpcFor(1), preset]});
for (const [chainId, markets] of Object.entries(AAVE)) for (const m of markets) jobs.push({id: `aave:${chainId}:${m}`, module: "aave", script: pkg("protocol-lending-aave-evm"), args: [], env: {AAVE_RPC: rpcFor(Number(chainId)), AAVE_CHAIN: chainId, AAVE_MARKET: m, AAVE_USER: ADDR.eip155}});
for (const chainId of MORPHO) jobs.push({id: `morpho:${chainId}`, module: "morpho", script: pkg("protocol-lending-morpho-evm"), args: [], env: {MORPHO_RPC: rpcFor(chainId), MORPHO_CHAIN: String(chainId), MORPHO_USER: ADDR.eip155}});
async function headOf(chainId) {
  try { const r = await (await fetch(rpcFor(chainId), {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: []}), signal: AbortSignal.timeout(15_000)})).json(); return parseInt(r.result, 16); } catch { return null; }
}
for (const chainId of [1, 8453, 42161]) {
  const head = await headOf(chainId);
  jobs.push({id: `approvals:${chainId}`, module: "approvals", script: pkg("protocol-approvals-evm"), args: [ADDR.eip155, rpcFor(chainId), "--chain", String(chainId), "--range", "10000", ...(head ? ["--from", String(Math.max(0, head - 100_000))] : [])]});
}
if (existsSync(pkg("protocol-lending-kamino-solana"))) jobs.push({id: "kamino", module: "kamino", script: pkg("protocol-lending-kamino-solana"), args: [ADDR.solana, solRpc]});
// Curve swaps: per chain with allowlisted pools (one generated src/pools/<chainId>.ts each), the router's code hash, version
// and ABI family against the pins and quotes simulated with eth_call. Savings crvUSD: the vault's identity and a
// large holder's redeem proven (the script's default holder; the empty test address would skip that proof).
const curvePools = resolve(ROOT, "packages/protocol-swap2-curve/src/pools");
const CURVE = existsSync(curvePools) ? readdirSync(curvePools).map((f) => /^(\d+)\.ts$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b) : [];
for (const chainId of CURVE) jobs.push({id: `curve:${chainId}`, module: "curve", script: pkg("protocol-swap2-curve"), args: [String(chainId), "--rpc", rpcFor(chainId)]});
jobs.push({id: "scrvusd", module: "scrvusd", script: pkg("protocol-lending-curve-evm"), args: [], env: {CURVE_RPC: rpcFor(1)}});
// Relay: every pin against /chains and on chain (depository code, allocator, owner, selectors), then live quotes verified,
// built and preflighted through the provider and the router. Keyless; RELAY_API_KEY is passed through when set.
if (existsSync(pkg("protocol-swap2-relay"))) jobs.push({id: "relay", module: "relay", script: pkg("protocol-swap2-relay"), args: [], timeoutS: 300});
// 0x: the registry (ERC-1967 proxy, owner, the Settlers it names are CREATE3 deployments with code), Permit2 and the wrapped
// natives on every chain of its table — keyless, always; a chain no RPC answered on fails it. Our RPCs go in as the
// script's RPC_<chainId> overrides where they are set (it reads no *_RPC_URL names; before, CI always ran it on its
// public fallbacks), each followed by the chain's public endpoint as the retry, so our RPC running dry or rate-limited
// does not fail the job on its own. It ends a failed run with `Reason:` (every chain that is not ok) and, when a sale
// through the Settler in force is refused today (what is refused and why, per chain), `Severity: high`. Live quotes
// (local and through createSwap2Handler) only with ZEROEX_API_KEY; without it the script says so in a neutral line.
// `summaryLines`: its Reason / Severity lines are its own (canary-status.mjs); no other job's are read as such.
if (existsSync(pkg("protocol-swap2-0x"))) jobs.push({id: "zeroex", module: "zeroex", script: pkg("protocol-swap2-0x"), args: [], env: rpcOverrides(env, RPC_ENV, PUBLIC_RPC), timeoutS: 300, summaryLines: true});
// Across: every pin on chain (SpokePool proxy, chainId, admin = HubPool, wrapped native, buffers, not paused, token
// decimals, the HubPool's registry) and /suggested-fees on nine corridors on the pinned SpokePools — keyless, always.
// Live quotes (local and through createSwap2Handler) only with ACROSS_API_KEY; without it a neutral line, exit 0.
if (existsSync(pkg("protocol-swap2-across"))) jobs.push({id: "across", module: "across", script: pkg("protocol-swap2-across"), args: [], timeoutS: 300});
// CoW Protocol: per chain, the pinned settlement / vault relayer / eth-flow read on chain and read-only quotes through
// the provider (an order and a permit signed by a throwaway key and verified locally; nothing is placed).
for (const chainId of [1, 8453, 42161]) jobs.push({id: `cow:${chainId}`, module: "cow", script: pkg("protocol-swap2-cow"), args: [String(chainId)], env: {[`COW_RPC_${chainId}`]: rpcFor(chainId)}});

// KyberSwap: router and executor code and build on all 18 chains, then an execution quote each way per chain (routes +
// build, the calldata checked, a native input simulated). Keyless; KYBERSWAP_API_KEY is passed through when set.
if (existsSync(pkg("protocol-swap2-kyberswap"))) jobs.push({id: "kyberswap", module: "kyberswap", script: pkg("protocol-swap2-kyberswap"), args: [], timeoutS: 300});
const selected = jobs.filter((j) => !ONLY || ONLY.has(j.module) || ONLY.has(j.id));
function run(job) {
  return new Promise((done) => {
    if (!existsSync(job.script)) return done({...job, status: "missing", ms: 0, note: "no verify-live script"});
    const t0 = Date.now(); let out = "";
    const child = spawn("node", [job.script, ...job.args], {cwd: dirname(job.script), env: {...process.env, ...(job.env ?? {})}, stdio: ["ignore", "pipe", "pipe"]});
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), Math.max(TIMEOUT_MS, (job.timeoutS ?? 0) * 1000)); // a job's own timeoutS can only extend --timeout
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const st = runStatus({code, signal, out, summaryLines: job.summaryLines === true});
      // A failure note names the cause (viem's Details / Status lines, the error line) rather than the stack tail; a job
      // with `summaryLines` leads it with its own `Reason:` line, whole (every chain that is not ok). URLs are cut
      // (canary-status.mjs).
      const note = noteOf(st);
      // What the retry wait is chosen from (not stored): the note, plus every failing line of a job that prints Reason.
      const retryText = retryTextOf(st);
      // `run` (the parsed output) is for the retry below only; like the retry text it is not stored.
      done({...job, status: st.status, ms: Date.now() - t0, note, retryText, run: st, ...(st.severity ? {severity: st.severity} : {})});
    });
  });
}
const results = [];
const queue = [...selected];
// One retry after 20 s for a fail / timeout: a single rate-limited or lagging RPC answer is not a module break (aave:1:lido and
// mellow:lido-earn-* alternated ok/fail across 2026-10-20..23 and passed 8/8 locally). The first failure stays in the note.
// A 429 / Too Many Requests note waits 60 s instead: 20 s after it the same burst was still on (native-monad, 2026-11-04).
// A retry that fails too keeps the higher severity of the two runs and, for a job with summaryLines, the first run's
// Reason lines it does not repeat (canary-status.mjs, retryKept): a retry on a rate-limited RPC no longer replaces a
// first run's `NEW on 8453` / `Severity: high` with `unreachable on 8453` and no severity.
async function runWithRetry(job) {
  const first = await run(job);
  if (first.status !== "fail" && first.status !== "timeout") return first;
  await new Promise((r) => setTimeout(r, RETRY_WAIT ?? retryWaitMs(first.retryText ?? first.note)));
  const second = await run(job);
  if (second.status === "fail" || second.status === "timeout") {
    if (!first.run || !second.run) return second;
    const {note, severity} = retryKept(first.run, second.run);
    const {severity: _own, ...rest} = second;
    return {...rest, note, ...(severity ? {severity} : {})};
  }
  console.error(`retry   ${job.id} passed on the second try — first: ${shortNote(first.note, 160, job.summaryLines)}`);
  return second;
}
await Promise.all(Array.from({length: 4}, async () => { for (;;) { const j = queue.shift(); if (!j) return; const r = await runWithRetry(j); results.push(r); console.error(`${r.status.padEnd(7)} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.id}${r.severity ? ` [severity ${r.severity}]` : ""}${r.note ? "  — " + shortNote(r.note, 140, r.summaryLines) : ""}`); } }));

// ── compare with the last run ──────────────────────────────────────────────
const dir = resolve(ROOT, "watch/canary"); mkdirSync(dir, {recursive: true});
const stateFile = resolve(dir, "state.json");
const prev = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
// A warn note that only differs in numbers (caps, rates) is the same warning.
const norm = (n) => (n || "").replace(/\d[\d.,]*/g, "#");
const transitions = [], failing = [];
// A failing job whose own severity changed (an unreachable chain, then a new 0x deployment) is a transition too.
const sev = (x) => (x?.severity ? {severity: x.severity} : {});
for (const r of results) {
  const p = prev[r.id];
  if (p && (p.status !== r.status || (r.status === "warn" && norm(p.note) !== norm(r.note)) || (r.status === "fail" && (p.severity ?? null) !== (r.severity ?? null)))) transitions.push({id: r.id, module: r.module, from: p.status, to: r.status, note: r.note, ...sev(r)});
  if (!p && r.status !== "ok") transitions.push({id: r.id, module: r.module, from: "new", to: r.status, note: r.note, ...sev(r)});
  if (r.status === "fail" || r.status === "timeout" || r.status === "missing") failing.push(r);
}
const next = {...prev}; for (const r of results) next[r.id] = {status: r.status, note: r.note, ...sev(r), at: new Date().toISOString()};
const counts = results.reduce((c, r) => ((c[r.status] = (c[r.status] ?? 0) + 1), c), {});
const summary = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ");
console.error(`\n${results.length} jobs: ${summary}; ${transitions.length} transitions`);
if (!DRY) {
  writeFileSync(stateFile, JSON.stringify(next, null, 1) + "\n");
  writeFileSync(resolve(dir, `${TODAY}.json`), JSON.stringify({date: TODAY, counts, transitions, failing: failing.map((f) => ({id: f.id, status: f.status, note: f.note, ...sev(f)})), results: results.map((r) => ({id: r.id, module: r.module, status: r.status, ms: r.ms, note: r.note, ...sev(r)}))}, null, 1) + "\n");
}

// ── telegram ───────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ICON = {ok: "🟢", warn: "🟡", none: "⚪", fail: "🔴", timeout: "🔴", missing: "🔴", new: "·"};
if (SEND && (transitions.length || failing.length || flag("--quiet-ok"))) {
  const token = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_WATCH_CHAT || env.TELEGRAM_ALERTS_CHAT;
  if (!token || !chat) console.error("telegram: not configured, skipping");
  else {
    const h = [`${failing.length ? "🔴" : transitions.length ? "🟡" : "🟢"} <b>Canary · ${TODAY}</b> — ${results.length} checks: ${esc(summary)}`];
    const severity = (x) => (x.severity ? ` · <b>severity ${esc(x.severity)}</b>` : "");
    const summaryJob = new Set(results.filter((r) => r.summaryLines === true).map((r) => r.id));
    if (transitions.length) { h.push("", "<i>changed since last run:</i>"); for (const t of transitions.slice(0, 20)) h.push(`• ${ICON[t.from] ?? ""}→${ICON[t.to]} <b>${esc(t.id)}</b>${severity(t)}${t.note ? `: ${esc(shortNote(t.note, 160, summaryJob.has(t.id)))}` : ""}`); if (transitions.length > 20) h.push(`• …and ${transitions.length - 20} more`); }
    if (failing.length) { h.push("", "<i>still failing:</i>"); for (const f of failing.slice(0, 12)) h.push(`• ${esc(f.id)}${severity(f)}: ${esc(shortNote(f.note || f.status, 160, f.summaryLines))}`); }
    const body = {chat_id: chat, text: fitLines(h), parse_mode: "HTML", disable_web_page_preview: true};
    if (env.TELEGRAM_WATCH_TOPIC) body.message_thread_id = Number(env.TELEGRAM_WATCH_TOPIC);
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000)});
    const j = await r.json().catch(() => ({})); if (!j.ok) console.error(`telegram: send failed (${j.description ?? r.status})`);
  }
}
process.exit(failing.length ? 1 : 0);
