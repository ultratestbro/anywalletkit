#!/usr/bin/env node
// Canary: run every Earn / safety module's own read-only `verify:live` across all its
// markets with the public test addresses (watch/addresses.json) and our RPCs, then
// report only what changed since the last run (ok → fail, warn → ok, …) plus
// anything still failing. Nothing is signed or sent on-chain.
//
//   node scripts/watch/canary.mjs [--only aave,morpho] [--timeout 240] [--send] [--dry] [--env FILE]
// State: watch/canary/state.json; today's rows: watch/canary/<date>.json.
import {spawn} from "node:child_process";
import {readFileSync, writeFileSync, mkdirSync, existsSync} from "node:fs";
import {resolve, dirname} from "node:path";
import {fileURLToPath} from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ONLY = opt("--only") ? new Set(opt("--only").split(",")) : null;
const TIMEOUT_MS = Number(opt("--timeout", "240")) * 1000;
const SEND = flag("--send"), DRY = flag("--dry");
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
const pkg = (name) => resolve(ROOT, "packages", name, "scripts/verify-live.mjs");

// Same job list as Vaulty's app/scripts/earn-check (kept in sync by hand).
const AAVE = {1: ["core", "lido", "etherfi"], 10: ["core"], 56: ["core"], 100: ["core"], 137: ["core"], 146: ["core"], 324: ["core"], 1088: ["core"], 1868: ["core"], 5000: ["core"], 8453: ["core"], 9745: ["core"], 42161: ["core"], 42220: ["core"], 43114: ["core"], 57073: ["core"], 59144: ["core"], 534352: ["core"]};
const MORPHO = [1, 8453, 42161, 10, 137, 130, 999, 747474, 143, 4663];
const jobs = [];
jobs.push({id: "lido", module: "lido", script: pkg("protocol-staking-lido-evm"), args: [ADDR.eip155, rpcFor(1)]});
jobs.push({id: "ssv", module: "ssv", script: pkg("protocol-staking-ssv-evm"), args: [ADDR.eip155, rpcFor(1)]});
jobs.push({id: "tonstakers", module: "tonstakers", script: pkg("protocol-staking-tonstakers-ton"), args: [ADDR.ton, tonRpc]});
jobs.push({id: "jito", module: "spl-stake-pool", script: pkg("protocol-staking-spl-stake-pool-solana"), args: [ADDR.solana, solRpc]});
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

const selected = jobs.filter((j) => !ONLY || ONLY.has(j.module) || ONLY.has(j.id));
const SOFT_FAIL = /(^|\s)(→|->)\s*\w*Error\b|\bFAILED\b|\bError:|not found|revert/i;
function run(job) {
  return new Promise((done) => {
    if (!existsSync(job.script)) return done({...job, status: "missing", ms: 0, note: "no verify-live script"});
    const t0 = Date.now(); let out = "";
    const child = spawn("node", [job.script, ...job.args], {cwd: dirname(job.script), env: {...process.env, ...(job.env ?? {})}, stdio: ["ignore", "pipe", "pipe"]});
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const lines = out.split("\n").filter(Boolean);
      const soft = lines.filter((l) => SOFT_FAIL.test(l) && !/no position|0 approval|none in the last|position \{ shares: 0n/.test(l));
      const expected = code !== 0 && /no listed Morpho (vault|market)/.test(out);
      const status = signal ? "timeout" : expected ? "none" : code !== 0 ? "fail" : soft.length ? "warn" : "ok";
      const note = (status === "fail" ? lines.slice(-4).join(" | ") : soft.slice(0, 3).join(" | ")).replace(/\s+/g, " ").slice(0, 300);
      done({...job, status, ms: Date.now() - t0, note});
    });
  });
}
const results = [];
const queue = [...selected];
await Promise.all(Array.from({length: 4}, async () => { for (;;) { const j = queue.shift(); if (!j) return; const r = await run(j); results.push(r); console.error(`${r.status.padEnd(7)} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.id}${r.note ? "  — " + r.note.slice(0, 140) : ""}`); } }));

// ── compare with the last run ──────────────────────────────────────────────
const dir = resolve(ROOT, "watch/canary"); mkdirSync(dir, {recursive: true});
const stateFile = resolve(dir, "state.json");
const prev = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
// A warn note that only differs in numbers (caps, rates) is the same warning.
const norm = (n) => (n || "").replace(/\d[\d.,]*/g, "#");
const transitions = [], failing = [];
for (const r of results) {
  const p = prev[r.id];
  if (p && (p.status !== r.status || (r.status === "warn" && norm(p.note) !== norm(r.note)))) transitions.push({id: r.id, module: r.module, from: p.status, to: r.status, note: r.note});
  if (!p && r.status !== "ok") transitions.push({id: r.id, module: r.module, from: "new", to: r.status, note: r.note});
  if (r.status === "fail" || r.status === "timeout" || r.status === "missing") failing.push(r);
}
const next = {...prev}; for (const r of results) next[r.id] = {status: r.status, note: r.note, at: new Date().toISOString()};
const counts = results.reduce((c, r) => ((c[r.status] = (c[r.status] ?? 0) + 1), c), {});
const summary = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ");
console.error(`\n${results.length} jobs: ${summary}; ${transitions.length} transitions`);
if (!DRY) {
  writeFileSync(stateFile, JSON.stringify(next, null, 1) + "\n");
  writeFileSync(resolve(dir, `${TODAY}.json`), JSON.stringify({date: TODAY, counts, transitions, failing: failing.map((f) => ({id: f.id, status: f.status, note: f.note})), results: results.map((r) => ({id: r.id, module: r.module, status: r.status, ms: r.ms, note: r.note}))}, null, 1) + "\n");
}

// ── telegram ───────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ICON = {ok: "🟢", warn: "🟡", none: "⚪", fail: "🔴", timeout: "🔴", missing: "🔴", new: "·"};
if (SEND && (transitions.length || failing.length || flag("--quiet-ok"))) {
  const token = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_WATCH_CHAT || env.TELEGRAM_ALERTS_CHAT;
  if (!token || !chat) console.error("telegram: not configured, skipping");
  else {
    const h = [`${failing.length ? "🔴" : transitions.length ? "🟡" : "🟢"} <b>Canary · ${TODAY}</b> — ${results.length} checks: ${esc(summary)}`];
    if (transitions.length) { h.push("", "<i>changed since last run:</i>"); for (const t of transitions.slice(0, 20)) h.push(`• ${ICON[t.from] ?? ""}→${ICON[t.to]} <b>${esc(t.id)}</b>${t.note ? `: ${esc(t.note.slice(0, 160))}` : ""}`); if (transitions.length > 20) h.push(`• …and ${transitions.length - 20} more`); }
    if (failing.length) { h.push("", "<i>still failing:</i>"); for (const f of failing.slice(0, 12)) h.push(`• ${esc(f.id)}: ${esc((f.note || f.status).slice(0, 160))}`); }
    const body = {chat_id: chat, text: h.join("\n").slice(0, 3900), parse_mode: "HTML", disable_web_page_preview: true};
    if (env.TELEGRAM_WATCH_TOPIC) body.message_thread_id = Number(env.TELEGRAM_WATCH_TOPIC);
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000)});
    const j = await r.json().catch(() => ({})); if (!j.ok) console.error(`telegram: send failed (${j.description ?? r.status})`);
  }
}
process.exit(failing.length ? 1 : 0);
