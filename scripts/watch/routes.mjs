#!/usr/bin/env node
// Routes canary: one dry quote per corridor in watch/routes.json, straight from
// each provider package (the same code the backend runs), and report what
// CHANGED since the last run — a corridor that stopped quoting, one that is back
// (incl. corridors the APP has paused via NEAR_INTENTS_SUSPENDED_CHAINS: the
// canary builds the providers WITHOUT that pause, so it notices the venue
// recovering and says "lift it"), errors.
// Nothing is built, signed or sent; no keys are needed (LI.FI / 1Click keys are optional).
//
//   node scripts/watch/routes.mjs [--only near_intents,lifi] [--match REGEX] [--timeout 25] [--send] [--dry] [--env FILE]
// State: watch/routes/state.json; today's rows: watch/routes/<date>.json.
import {readFileSync, writeFileSync, mkdirSync, existsSync} from "node:fs";
import {resolve, dirname} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ONLY = opt("--only") ? new Set(opt("--only").split(",")) : null;
const MATCH = opt("--match") ? new RegExp(opt("--match")) : null;
const TIMEOUT_MS = Number(opt("--timeout", "25")) * 1000;
const SEND = flag("--send"), DRY = flag("--dry"), VERBOSE = flag("--verbose");
const TODAY = new Date().toISOString().slice(0, 10);
if (opt("--env")) for (const l of readFileSync(resolve(opt("--env")), "utf8").split("\n")) { const i = l.indexOf("="); if (i > 0 && !l.startsWith("#") && !(l.slice(0, i).trim() in process.env)) process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, "$2"); }
const env = process.env;
const ADDR = JSON.parse(readFileSync(resolve(ROOT, "watch/addresses.json"), "utf8"));
const ROUTES = JSON.parse(readFileSync(resolve(ROOT, "watch/routes.json"), "utf8"));
const CORRIDORS = ROUTES.corridors;
const ZERO = "0x0000000000000000000000000000000000000000";

// ── RPCs (own endpoint first, public fallback) — same map as canary.mjs ───────
const RPC_ENV = {
  1: "EVM_RPC_URL", 8453: "BASE_RPC_URL", 42161: "ARBITRUM_RPC_URL", 10: "OPTIMISM_RPC_URL", 137: "POLYGON_RPC_URL", 43114: "AVALANCHE_RPC_URL", 56: "BSC_RPC_URL",
  130: "UNICHAIN_RPC_URL", 59144: "LINEA_RPC_URL", 146: "SONIC_RPC_URL", 324: "ZKSYNC_RPC_URL", 999: "HYPEREVM_RPC_URL", 42220: "CELO_RPC_URL", 100: "GNOSIS_RPC_URL",
  9745: "PLASMA_RPC_URL", 4326: "MEGAETH_RPC_URL", 4663: "ROBINHOOD_RPC_URL", 143: "MONAD_RPC_URL", 534352: "SCROLL_RPC_URL", 80094: "BERACHAIN_RPC_URL",
  480: "WORLDCHAIN_RPC_URL", 1329: "SEI_RPC_URL", 57073: "INK_RPC_URL", 98866: "PLUME_RPC_URL", 196: "XLAYER_RPC_URL",
};
const PUBLIC_RPC = {
  1: "https://ethereum-rpc.publicnode.com", 8453: "https://base-rpc.publicnode.com", 42161: "https://arbitrum-one-rpc.publicnode.com", 10: "https://optimism-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com", 56: "https://bsc-rpc.publicnode.com", 43114: "https://avalanche-c-chain-rpc.publicnode.com", 4663: "https://rpc.mainnet.chain.robinhood.com",
  324: "https://mainnet.era.zksync.io", 42220: "https://forno.celo.org", 4326: "https://mainnet.megaeth.com/rpc", 9745: "https://rpc.plasma.to", 59144: "https://rpc.linea.build",
  146: "https://rpc.soniclabs.com", 100: "https://gnosis-rpc.publicnode.com", 130: "https://unichain-rpc.publicnode.com", 143: "https://rpc.monad.xyz", 999: "https://rpc.hyperliquid.xyz/evm",
  534352: "https://rpc.scroll.io", 80094: "https://rpc.berachain.com", 480: "https://worldchain-mainnet.g.alchemy.com/public", 1329: "https://evm-rpc.sei-apis.com",
  57073: "https://rpc-gel.inkonchain.com", 98866: "https://rpc.plume.org", 196: "https://rpc.xlayer.tech",
};
const ownRpc = Object.fromEntries(Object.entries(RPC_ENV).map(([id, name]) => [`eip155:${id}`, env[name]]).filter(([, v]) => v));
const venueRpc = Object.fromEntries(Object.entries(PUBLIC_RPC).map(([id, pub]) => [Number(id), [ownRpc[`eip155:${id}`], pub].filter(Boolean)]));

// ── providers, from the built packages (pnpm build first) ────────────────────
const dist = (pkgName, file) => import(pathToFileURL(resolve(ROOT, "packages", pkgName, "dist", file)).href);
const {ccAsset} = await dist("swap2-assets", "index.js");
const providers = {};
const want = (name) => !ONLY || ONLY.has(name);
if (want("near_intents")) providers.near_intents = (await dist("protocol-swap2-near-intents", "provider.js")).nearIntentsProvider({
  enabled: true, // no suspendedChains here on purpose: the canary must see the venue recover
  ...(env.NEAR_INTENTS_API_URL ? {apiUrl: env.NEAR_INTENTS_API_URL} : {}), ...(env.NEAR_INTENTS_JWT ? {jwt: env.NEAR_INTENTS_JWT} : {}),
});
if (want("lifi")) providers.lifi = (await dist("protocol-swap2-lifi", "provider.js")).lifiProvider({enabled: true, ...(env.LIFI_API_KEY ? {apiKey: env.LIFI_API_KEY} : {}), ...(env.LIFI_INTEGRATOR ? {integrator: env.LIFI_INTEGRATOR} : {})});
if (want("thorchain")) providers.thorchain = (await dist("protocol-swap2-thorchain", "provider.js")).thorchainProvider({enabled: true, tronSource: true, ...(env.THORCHAIN_NODE_URL ? {nodeUrl: env.THORCHAIN_NODE_URL} : {})});
if (want("omniston")) providers.omniston = (await dist("protocol-swap2-omniston", "provider.js")).omnistonProvider({
  enabled: true, maxHtlcExecutions: 1, ...(env.OMNISTON_API_URL ? {apiUrl: env.OMNISTON_API_URL} : {}),
  trustedSettlementContracts: ROUTES.omniston.trustedSettlementContracts, trustedEvmOrderProtocols: ROUTES.omniston.trustedEvmOrderProtocols,
  // The provider refuses cross-chain quotes unless the position validators are wired (fail-closed by design).
  // They only run at disclosure / build time, which this canary never reaches; the stubs below refuse everything.
  validateEvmInputPosition: async () => false, validateTonOutputPosition: async () => false, validateEvmOutputPosition: async () => false,
  validateTonJettonWallet: async () => false, validateTonEscrowPayload: async () => false, validateTonSwapTarget: async () => false,
});
if (want("cctp")) providers.cctp = (await dist("protocol-swap2-cctp", "provider.js")).cctpProvider({enabled: true, rpcUrls: ownRpc});
if (want("uniswap")) providers.uniswap = (await dist("protocol-swap2-uniswap", "provider.js")).uniswapProvider({enabled: true, rpcUrls: venueRpc});
if (want("wrap")) providers.wrap = (await dist("protocol-swap2-wrap", "provider.js")).wrapProvider({enabled: true, rpcUrls: venueRpc});
if (want("balancer")) providers.balancer = (await dist("protocol-swap2-balancer", "provider.js")).balancerProvider({enabled: true, rpcUrls: venueRpc});
if (want("fynd") && env.FYND_API_KEY) providers.fynd = (await dist("protocol-swap2-fynd", "provider.js")).fyndProvider({enabled: true, apiKey: env.FYND_API_KEY});

// ── one dry quote per corridor ───────────────────────────────────────────────
const parse = (s) => { const i = s.lastIndexOf(":"); return {chain: s.slice(0, i), symbol: s.slice(i + 1)}; };
const units = (amount, decimals) => { const [a, b = ""] = String(amount).split("."); return BigInt(a + b.padEnd(decimals, "0").slice(0, decimals)).toString(); };
const addressFor = (caip2) => ADDR[caip2.split(":")[0]];
// Providers narrate refusals on console.warn / console.error; our own lines go straight to stderr (--verbose keeps theirs).
if (!VERBOSE) { console.warn = () => {}; console.error = () => {}; }
const log = (s) => process.stderr.write(s + "\n");

async function probe(c) {
  const provider = providers[c.provider];
  if (!provider) return null;
  const src = parse(c.src), dst = parse(c.dst);
  const a = ccAsset(src.chain, src.symbol), b = ccAsset(dst.chain, dst.symbol);
  if (!a || !b) return {...c, status: "missing-asset", ms: 0, note: `catalog lacks ${!a ? c.src : c.dst}`};
  const params = {
    sourceChain: src.chain, sourceToken: src.symbol, destChain: dst.chain, destToken: b.contract ?? ZERO,
    amountIn: units(c.amount, a.decimals), destAddress: addressFor(dst.chain), refundAddress: addressFor(src.chain), slippageBps: 100, dry: true,
  };
  let refusal = null; params.onRefusal = (r) => { refusal = String(r); };
  const t0 = Date.now();
  try {
    const quote = await Promise.race([provider.getQuote(params), new Promise((_, rej) => setTimeout(() => rej(new Error("__timeout")), TIMEOUT_MS))]);
    const ms = Date.now() - t0;
    if (quote && BigInt(quote.amountOut ?? quote.destAmount ?? 0) > 0n) {
      const out = BigInt(quote.amountOut ?? quote.destAmount); const dec = b.decimals;
      return {...c, status: "quoting", ms, note: `out ${(Number(out) / 10 ** dec).toPrecision(6)} ${dst.symbol}${quote.estimatedTime ? ` · ~${quote.estimatedTime}s` : ""}`};
    }
    return {...c, status: "no-route", ms, note: (refusal ?? "null quote").replace(/\s+/g, " ").slice(0, 220)};
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {...c, status: msg === "__timeout" ? "timeout" : "error", ms: Date.now() - t0, note: msg.replace(/\s+/g, " ").slice(0, 220)};
  }
}

const selected = CORRIDORS.filter((c) => providers[c.provider] && (!MATCH || MATCH.test(c.id)));
const results = [];
// Per-provider serial (their own rate limits), providers in parallel.
await Promise.all(Object.keys(providers).map(async (name) => {
  for (const c of selected.filter((x) => x.provider === name)) {
    const r = await probe(c); if (!r) continue; results.push(r);
    log(`${r.status.padEnd(13)} ${(r.ms / 1000).toFixed(1).padStart(5)}s  ${r.id}${r.note ? "  — " + r.note.slice(0, 120) : ""}`);
  }
}));
for (const p of Object.values(providers)) { try { p.close?.(); } catch {} }

// ── compare with the last run ────────────────────────────────────────────────
const dir = resolve(ROOT, "watch/routes"); mkdirSync(dir, {recursive: true});
const stateFile = resolve(dir, "state.json");
const prev = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const UP = (s) => s === "quoting";
const transitions = [], down = [];
for (const r of results) {
  const p = prev[r.id];
  if (p && UP(p.status) !== UP(r.status)) transitions.push({id: r.id, provider: r.provider, from: p.status, to: r.status, note: r.note, suspended: !!r.suspended, hint: r.note});
  if (!p && !UP(r.status) && !r.suspended) transitions.push({id: r.id, provider: r.provider, from: "new", to: r.status, note: r.note});
  if (!UP(r.status)) down.push(r);
}
const next = {...prev}; for (const r of results) next[r.id] = {status: r.status, note: r.note, at: new Date().toISOString()};
const counts = results.reduce((c, r) => ((c[r.status] = (c[r.status] ?? 0) + 1), c), {});
const summary = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ");
log(`\n${results.length} corridors: ${summary}; ${transitions.length} transitions`);
if (!DRY) {
  writeFileSync(stateFile, JSON.stringify(next, null, 1) + "\n");
  writeFileSync(resolve(dir, `${TODAY}.json`), JSON.stringify({date: TODAY, counts, transitions, down: down.map((d) => ({id: d.id, status: d.status, note: d.note, suspended: !!d.suspended})), results: results.map((r) => ({id: r.id, provider: r.provider, status: r.status, ms: r.ms, note: r.note}))}, null, 1) + "\n");
}

// ── telegram: transitions only (plus a one-line count of what is still down) ─
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
if (SEND && transitions.length) {
  const token = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_WATCH_CHAT || env.TELEGRAM_ALERTS_CHAT;
  if (!token || !chat) log("telegram: not configured, skipping");
  else {
    const stopped = transitions.filter((t) => !UP(t.to)), back = transitions.filter((t) => UP(t.to));
    const h = [`${stopped.length ? "🔴" : "🟢"} <b>Routes · ${TODAY}</b> — ${results.length} corridors: ${esc(summary)}`];
    if (stopped.length) { h.push("", "<i>stopped quoting:</i>"); for (const t of stopped.slice(0, 15)) h.push(`• <b>${esc(t.id)}</b> ${esc(t.from)}→${esc(t.to)}${t.note ? `: ${esc(t.note.slice(0, 140))}` : ""}`); }
    if (back.length) { h.push("", "<i>quoting again:</i>"); for (const t of back.slice(0, 15)) h.push(`• <b>${esc(t.id)}</b> ${esc(t.from)}→quoting${t.suspended ? ` — <b>paused in the app (NEAR_INTENTS_SUSPENDED_CHAINS), lift it</b>${CORRIDORS.find((c) => c.id === t.id)?.note ? ` (${esc(CORRIDORS.find((c) => c.id === t.id).note)})` : ""}` : ""}`); }
    if (down.length) h.push("", `<i>still down: ${down.length}</i> — ${esc(down.map((d) => d.id).slice(0, 12).join(", "))}${down.length > 12 ? ", …" : ""}`);
    const body = {chat_id: chat, text: h.join("\n"), parse_mode: "HTML", disable_web_page_preview: true, ...(env.TELEGRAM_WATCH_TOPIC ? {message_thread_id: Number(env.TELEGRAM_WATCH_TOPIC)} : {})};
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000)});
    const j = await r.json().catch(() => ({})); if (!j.ok) log(`telegram: send failed (${j.description ?? r.status})`);
  }
}
process.exit(0);
