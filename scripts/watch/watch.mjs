#!/usr/bin/env node
// Module watch: fetch every source in packages/*/watch.json (and watch/pending/*.watch.json),
// compare with watch/state, write the diff + digest, optionally post to Telegram.
// See scripts/watch/README.md. No secrets are ever printed.
import {readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync} from "node:fs";
import {resolve, dirname, basename} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {esc, firstBlocks, readCapped, safeLink, visibleText} from "./html-text.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const BASELINE = flag("--baseline"), SEND = flag("--send"), DRY = flag("--dry");
const ONLY = opt("--only")?.split(",");
const TODAY = new Date().toISOString().slice(0, 10);

// ── env ────────────────────────────────────────────────────────────────────
if (opt("--env")) {
  for (const l of readFileSync(resolve(opt("--env")), "utf8").split("\n")) {
    const i = l.indexOf("="); if (i < 0 || l.startsWith("#")) continue;
    const k = l.slice(0, i).trim(); if (!(k in process.env)) process.env[k] = l.slice(i + 1).trim();
  }
}
const env = process.env;
if (!env.GITHUB_TOKEN) { try { const {execFileSync} = await import("node:child_process"); const t = execFileSync("gh", ["auth", "token"], {stdio: ["ignore", "pipe", "ignore"]}).toString().trim(); if (t) env.GITHUB_TOKEN = t; } catch {} }
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
const SOL_RPC = env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const TON_RPC = (env.TON_RPC_URL ? env.TON_RPC_URL.replace(/\/$/, "") : "https://toncenter.com/api/v2") + "/jsonRPC";

// ── helpers ────────────────────────────────────────────────────────────────
const sha = (s) => createHash("sha256").update(s).digest("hex");
const short = (h) => (h ? h.slice(0, 10) : "—");
async function fetchJson(url, init = {}, timeoutMs = 20_000) {
  const r = await fetch(url, {...init, signal: AbortSignal.timeout(timeoutMs)});
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function rpc(url, method, params) {
  const j = await fetchJson(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params})});
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}
const ghHeaders = () => ({accept: "application/vnd.github+json", "user-agent": "forgewallet-watch", ...(env.GITHUB_TOKEN ? {authorization: `Bearer ${env.GITHUB_TOKEN}`} : {})});
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",")}}`;
  return JSON.stringify(v);
}
const dig = (o, path) => (path ? path.split(".").reduce((a, k) => (a == null ? a : a[k]), o) : o);

// ── fetchers: each returns {value: string (what is compared), meta: object (what is shown)} ──
const SLOT_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SLOT_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const SLOT_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const addrOfSlot = (w) => (w && /^0x0*[0-9a-f]{1,40}$/i.test(w) && BigInt(w) !== 0n ? "0x" + w.slice(-40).toLowerCase() : null);
const F = {
  async "evm-proxy"(s) {
    const url = rpcFor(s.chainId); if (!url) throw new Error(`no RPC for chain ${s.chainId}`);
    const [code, impl, admin, beacon] = await Promise.all([
      rpc(url, "eth_getCode", [s.address, "latest"]), rpc(url, "eth_getStorageAt", [s.address, SLOT_IMPL, "latest"]),
      rpc(url, "eth_getStorageAt", [s.address, SLOT_ADMIN, "latest"]), rpc(url, "eth_getStorageAt", [s.address, SLOT_BEACON, "latest"]),
    ]);
    if (!code || code === "0x") throw new Error("no code at address");
    const meta = {codeHash: sha(code).slice(0, 16), impl: addrOfSlot(impl), admin: addrOfSlot(admin), beacon: addrOfSlot(beacon)};
    if (meta.beacon) { try { const r = await rpc(url, "eth_call", [{to: meta.beacon, data: "0x5c60da1b"}, "latest"]); meta.beaconImpl = addrOfSlot(r); } catch {} }
    if (meta.impl) { try { const ic = await rpc(url, "eth_getCode", [meta.impl, "latest"]); meta.implCodeHash = sha(ic).slice(0, 16); } catch {} }
    return {value: canonical(meta), meta};
  },
  async "evm-code"(s) {
    const url = rpcFor(s.chainId); if (!url) throw new Error(`no RPC for chain ${s.chainId}`);
    const code = await rpc(url, "eth_getCode", [s.address, "latest"]);
    if (!code || code === "0x") throw new Error("no code at address");
    const meta = {codeHash: sha(code).slice(0, 16), bytes: (code.length - 2) / 2};
    return {value: meta.codeHash, meta};
  },
  async "solana-program"(s) {
    const acc = await rpc(SOL_RPC, "getAccountInfo", [s.programId, {encoding: "jsonParsed"}]);
    const info = acc?.value?.data?.parsed?.info;
    if (!acc?.value) throw new Error("program account not found");
    if (!info?.programData) return {value: `owner:${acc.value.owner}`, meta: {owner: acc.value.owner, note: "not BPF-upgradeable"}};
    const pd = await rpc(SOL_RPC, "getAccountInfo", [info.programData, {encoding: "jsonParsed"}]);
    const pi = pd?.value?.data?.parsed?.info ?? {};
    const meta = {programData: info.programData, slot: pi.slot, authority: pi.authority ?? null};
    return {value: canonical(meta), meta};
  },
  async "ton-code"(s) {
    const r = await rpc(TON_RPC, "getAddressInformation", {address: s.address});
    if (!r?.code) throw new Error("no code (uninitialized?)");
    const meta = {codeHash: sha(r.code).slice(0, 16), state: r.state};
    return {value: meta.codeHash, meta};
  },
  async "github-releases"(s) {
    // Monorepos release many packages: `tagPrefix` keeps only the tags the module cares about.
    const prefixes = s.tagPrefix == null ? null : [].concat(s.tagPrefix);
    let rel = await fetchJson(`https://api.github.com/repos/${s.repo}/releases?per_page=${prefixes ? 50 : 3}`, {headers: ghHeaders()});
    if (prefixes && Array.isArray(rel)) {
      rel = rel.filter((r) => prefixes.some((p) => r.tag_name.startsWith(p)));
      if (!rel.length) throw new Error(`no recent release tag starts with ${prefixes.join(" | ")}`);
    }
    if (Array.isArray(rel) && rel.length) {
      const r = rel[0];
      const meta = {tag: r.tag_name, name: r.name || r.tag_name, at: (r.published_at || "").slice(0, 10), url: r.html_url, prerelease: !!r.prerelease};
      return {value: r.tag_name, meta};
    }
    const tags = await fetchJson(`https://api.github.com/repos/${s.repo}/tags?per_page=3`, {headers: ghHeaders()});
    if (tags.length) return {value: tags[0].name, meta: {tag: tags[0].name, url: `https://github.com/${s.repo}/releases/tag/${encodeURIComponent(tags[0].name)}`, note: "tags only"}};
    // No releases, no tags: watch the default branch head instead (every push counts).
    const commits = await fetchJson(`https://api.github.com/repos/${s.repo}/commits?per_page=1`, {headers: ghHeaders()});
    if (!commits.length) throw new Error("no releases, tags or commits");
    const c = commits[0];
    return {value: c.sha, meta: {tag: `commit ${c.sha.slice(0, 7)}`, at: (c.commit?.committer?.date || "").slice(0, 10), url: c.html_url, note: `default branch: ${(c.commit?.message || "").split("\n")[0].slice(0, 80)}`}};
  },
  async "github-file"(s) {
    const j = await fetchJson(`https://api.github.com/repos/${s.repo}/contents/${s.path}${s.ref ? `?ref=${s.ref}` : ""}`, {headers: ghHeaders()});
    return {value: j.sha, meta: {sha: j.sha.slice(0, 10), url: j.html_url}};
  },
  async "http-json"(s) {
    const j = await fetchJson(s.url, {headers: s.headers ?? {}});
    const arr = dig(j, s.path);
    if (s.itemKey && Array.isArray(arr)) {
      const keys = arr.map((x) => String(dig(x, s.itemKey))).sort();
      return {value: canonical(keys), meta: {count: keys.length, keys}};
    }
    const c = canonical(arr ?? j);
    return {value: sha(c), meta: {hash: sha(c).slice(0, 16), count: Array.isArray(arr) ? arr.length : undefined}};
  },
  async "http-text"(s) {
    const r = await fetch(s.url, {headers: {"user-agent": "Mozilla/5.0 forgewallet-watch", ...(s.headers ?? {})}, signal: AbortSignal.timeout(25_000)});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = visibleText(await readCapped(r), s.between);
    if (text.length < 200) throw new Error(`page text too short (${text.length} chars) — selector or JS-rendered page`);
    return {value: sha(text), meta: {hash: sha(text).slice(0, 16), chars: text.length}, text};
  },
  async "rss"(s) {
    const r = await fetch(s.url, {headers: {"user-agent": "forgewallet-watch"}, signal: AbortSignal.timeout(20_000)});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const xml = await readCapped(r);
    const items = firstBlocks(xml, ["item", "entry"], 5).map((block) => {
      const m = [block];
      const t = m[0].match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]?.trim() ?? "";
      const l = m[0].match(/<link[^>]*href="([^"]+)"/)?.[1] ?? m[0].match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? "";
      return {title: t, link: l};
    });
    if (!items.length) throw new Error("no items");
    return {value: canonical(items.map((i) => i.title)), meta: {latest: items[0], titles: items.map((i) => i.title)}};
  },
};

// ── manifests ──────────────────────────────────────────────────────────────
function loadManifests() {
  const out = [];
  for (const d of readdirSync(resolve(ROOT, "packages"))) {
    const f = resolve(ROOT, "packages", d, "watch.json"); if (existsSync(f)) out.push({file: f, ...JSON.parse(readFileSync(f, "utf8"))});
  }
  const pend = resolve(ROOT, "watch/pending");
  if (existsSync(pend)) for (const f of readdirSync(pend)) if (f.endsWith(".watch.json")) out.push({file: resolve(pend, f), ...JSON.parse(readFileSync(resolve(pend, f), "utf8"))});
  return out.filter((m) => !ONLY || ONLY.some((o) => m.module.includes(o)));
}
const slug = (m) => m.replace(/^@forgewallet\//, "");
const stateFile = (m) => resolve(ROOT, "watch/state", `${slug(m)}.json`);
const loadState = (m) => (existsSync(stateFile(m)) ? JSON.parse(readFileSync(stateFile(m), "utf8")) : {module: m, sources: {}});

// ── diff summaries ─────────────────────────────────────────────────────────
function describe(s, before, after) {
  const b = before?.meta ?? {}, a = after.meta ?? {};
  switch (s.type) {
    case "evm-proxy": {
      const parts = [];
      if (b.impl !== a.impl) parts.push(`implementation ${b.impl ?? "—"} → ${a.impl ?? "—"}`);
      else if (b.implCodeHash !== a.implCodeHash) parts.push(`implementation code changed (${short(b.implCodeHash)} → ${short(a.implCodeHash)})`);
      if (b.admin !== a.admin) parts.push(`admin ${b.admin ?? "—"} → ${a.admin ?? "—"}`);
      if (b.beacon !== a.beacon || b.beaconImpl !== a.beaconImpl) parts.push(`beacon ${b.beaconImpl ?? b.beacon ?? "—"} → ${a.beaconImpl ?? a.beacon ?? "—"}`);
      if (b.codeHash !== a.codeHash) parts.push(`own code ${short(b.codeHash)} → ${short(a.codeHash)}`);
      return parts.join("; ") || "storage changed";
    }
    case "evm-code": return `code ${short(b.codeHash)} → ${short(a.codeHash)} (${b.bytes ?? "?"} → ${a.bytes} bytes)`;
    case "solana-program": return `last deploy slot ${b.slot ?? "—"} → ${a.slot}${b.authority !== a.authority ? `; authority ${b.authority ?? "—"} → ${a.authority ?? "—"}` : ""}`;
    case "ton-code": return `code ${short(b.codeHash)} → ${short(a.codeHash)}`;
    case "github-releases": return `${b.tag ?? "—"} → ${a.tag}${a.at ? ` (${a.at})` : ""}${a.prerelease ? " pre-release" : ""}${a.note?.startsWith("default branch") ? ` — ${a.note.slice(16)}` : ""}`;
    case "github-file": return `file changed ${short(b.sha)} → ${short(a.sha)}`;
    case "http-json": {
      if (a.keys && b.keys) {
        const B = new Set(b.keys), A = new Set(a.keys);
        const added = a.keys.filter((k) => !B.has(k)), removed = b.keys.filter((k) => !A.has(k));
        return [added.length ? `+${added.length}: ${added.slice(0, 8).join(", ")}${added.length > 8 ? "…" : ""}` : "", removed.length ? `−${removed.length}: ${removed.slice(0, 8).join(", ")}${removed.length > 8 ? "…" : ""}` : ""].filter(Boolean).join(" ");
      }
      return `payload changed (${short(b.hash)} → ${short(a.hash)}${a.count !== undefined ? `, ${b.count ?? "?"} → ${a.count} items` : ""})`;
    }
    case "http-text": return `page text changed (${b.chars ?? "?"} → ${a.chars} chars)`;
    case "rss": { const B = new Set(b.titles ?? []); const n = (a.titles ?? []).filter((t) => !B.has(t)); return n.length ? `new: ${n.map((t) => `“${t}”`).join(", ")}` : "items changed"; }
    default: return "changed";
  }
}
const linkOf = (s, after) => safeLink(after.meta?.url || (s.type === "http-json" || s.type === "http-text" || s.type === "rss" ? s.url : s.type.startsWith("github") ? `https://github.com/${s.repo}` : null), s);

// ── run ────────────────────────────────────────────────────────────────────
const manifests = loadManifests();
if (!manifests.length) { console.error("no watch.json manifests found"); process.exit(1); }
const changes = [], errors = [];
let total = 0;
const limit = 6; let active = 0; const queue = [];
const gate = () => new Promise((ok) => { const t = () => { if (active < limit) { active++; ok(); } else queue.push(t); }; t(); });
const release = () => { active--; queue.shift()?.(); };

for (const m of manifests) {
  const state = loadState(m.module);
  const tasks = (m.sources ?? []).map(async (s) => {
    await gate();
    total++;
    try {
      if (!F[s.type]) throw new Error(`unknown source type ${s.type}`);
      const r = await F[s.type](s);
      const prev = state.sources[s.id];
      const now = new Date().toISOString();
      if (prev && prev.value !== r.value) changes.push({module: m.module, id: s.id, label: s.label ?? s.id, type: s.type, what: describe(s, prev, r), link: linkOf(s, r), before: prev.meta, after: r.meta});
      state.sources[s.id] = {type: s.type, value: r.value, meta: r.meta, seenAt: now, changedAt: prev && prev.value !== r.value ? now : prev?.changedAt ?? now, ...(prev?.error ? {} : {})};
      if (r.text && s.keepText) state.sources[s.id].text = r.text;
    } catch (e) {
      const prev = state.sources[s.id];
      errors.push({module: m.module, id: s.id, label: s.label ?? s.id, error: String(e.message || e).slice(0, 160), stale: !!prev});
      if (prev) state.sources[s.id] = {...prev, error: String(e.message || e).slice(0, 160), errorAt: new Date().toISOString()};
    } finally { release(); }
  });
  await Promise.all(tasks);
  if (!DRY) { mkdirSync(dirname(stateFile(m.module)), {recursive: true}); writeFileSync(stateFile(m.module), JSON.stringify(state, null, 1) + "\n"); }
}

// ── output ─────────────────────────────────────────────────────────────────
const byModule = (list) => { const g = {}; for (const c of list) (g[c.module] ??= []).push(c); return g; };
const lines = [`# Module watch · ${TODAY}`, "", `${manifests.length} modules, ${total} sources, ${changes.length} changed, ${errors.length} unreachable.`, ""];
for (const [mod, cs] of Object.entries(byModule(changes))) {
  lines.push(`## ${mod}`);
  for (const c of cs) lines.push(`- **${c.label}** (${c.type}): ${c.what}${c.link ? ` — ${c.link}` : ""}`);
  lines.push("");
}
const errorGroups = Object.entries(errors.reduce((g, e) => { (g[e.error] ??= []).push(e); return g; }, {})).sort((a, b) => b[1].length - a[1].length);
if (errors.length) {
  lines.push("## Unreachable");
  for (const [err, es] of errorGroups) lines.push(es.length > 3 ? `- ${err} — ${es.length} sources: ${es.slice(0, 6).map((e) => `${slug(e.module)} · ${e.label}`).join("; ")}${es.length > 6 ? "; …" : ""}` : es.map((e) => `- ${slug(e.module)} · ${e.label}: ${err}${e.stale ? " (previous value kept)" : ""}`).join("\n"));
  lines.push("");
}
const digest = lines.join("\n");
console.log(digest);
if (!DRY && !BASELINE) {
  mkdirSync(resolve(ROOT, "watch/diff"), {recursive: true}); mkdirSync(resolve(ROOT, "watch/digest"), {recursive: true});
  writeFileSync(resolve(ROOT, "watch/diff", `${TODAY}.json`), JSON.stringify({date: TODAY, modules: manifests.length, sources: total, changes, errors}, null, 1) + "\n");
  writeFileSync(resolve(ROOT, "watch/digest", `${TODAY}.md`), digest);
}
if (BASELINE) console.error(`baseline written for ${manifests.length} modules (${total} sources, ${errors.length} unreachable)`);

// ── telegram ───────────────────────────────────────────────────────────────
async function postTelegram(html) {
  const token = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_WATCH_CHAT || env.TELEGRAM_ALERTS_CHAT;
  if (!token || !chat) { console.error("telegram: TELEGRAM_BOT_TOKEN / TELEGRAM_WATCH_CHAT not set, skipping"); return false; }
  const body = {chat_id: chat, text: html.length > 3900 ? html.slice(0, 3880) + "\n…" : html, parse_mode: "HTML", disable_web_page_preview: true};
  if (env.TELEGRAM_WATCH_TOPIC) body.message_thread_id = Number(env.TELEGRAM_WATCH_TOPIC);
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000)});
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { console.error(`telegram: send failed (${j.description ?? r.status})`); return false; }
  return true;
}
if (SEND && !BASELINE) {
  if (!changes.length && !errors.length) {
    if (flag("--quiet-ok")) await postTelegram(`🟢 <b>Module watch · ${TODAY}</b> — ${manifests.length} modules, ${total} sources, no changes.`);
  } else {
    const h = [`${changes.length ? "🟠" : "🟡"} <b>Module watch · ${TODAY}</b> — ${changes.length} changed, ${errors.length} unreachable of ${total} sources`];
    for (const [mod, cs] of Object.entries(byModule(changes))) {
      h.push("", `<b>${esc(slug(mod))}</b>`);
      for (const c of cs) h.push(`• ${c.link ? `<a href="${esc(c.link)}">${esc(c.label)}</a>` : esc(c.label)}: ${esc(c.what)}`);
    }
    if (errors.length) {
      h.push("", "<i>unreachable:</i>");
      for (const [err, es] of errorGroups.slice(0, 8)) h.push(es.length > 3 ? `• ${esc(err)} — ${es.length} sources (${esc(es.slice(0, 3).map((e) => e.label).join(", "))}…)` : es.map((e) => `• ${esc(slug(e.module))} · ${esc(e.label)}: ${esc(err)}`).join("\n"));
      if (errorGroups.length > 8) h.push(`• …and ${errorGroups.length - 8} more kinds`);
    }
    // A digest Telegram refused must fail the job: the state commit is skipped, so the changes alert again tomorrow (scan F13).
    if (!(await postTelegram(h.join("\n")))) process.exitCode = 1;
  }
}
process.exit(process.exitCode ?? 0);
