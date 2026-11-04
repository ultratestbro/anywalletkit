#!/usr/bin/env node
// Module watch: fetch every source in packages/*/watch.json (and watch/pending/*.watch.json),
// compare with watch/state, write the diff + digest, optionally post to Telegram.
// See scripts/watch/README.md. No secrets are ever printed.
import {readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync} from "node:fs";
import {resolve, dirname, basename, sep} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
import {esc, firstBlocks, fitLines, readCapped, safeLink, visibleText} from "./html-text.mjs";
import {RECORD_FORMATS, checkPins, decodeFacets, pinsFromModule, selectorsFromSource} from "./pins.mjs";

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
  14: "FLARE_RPC_URL", 5042: "ARC_RPC_URL", 2818: "MORPH_RPC_URL",
};
const PUBLIC_RPC = {
  1: "https://ethereum-rpc.publicnode.com", 8453: "https://base-rpc.publicnode.com", 42161: "https://arbitrum-one-rpc.publicnode.com", 10: "https://optimism-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com", 56: "https://bsc-rpc.publicnode.com", 43114: "https://avalanche-c-chain-rpc.publicnode.com", 4663: "https://rpc.mainnet.chain.robinhood.com",
  324: "https://mainnet.era.zksync.io", 42220: "https://forno.celo.org", 4326: "https://mainnet.megaeth.com/rpc", 9745: "https://rpc.plasma.to", 59144: "https://rpc.linea.build",
  146: "https://rpc.soniclabs.com", 100: "https://gnosis-rpc.publicnode.com", 130: "https://unichain-rpc.publicnode.com", 143: "https://rpc.monad.xyz", 999: "https://rpc.hyperliquid.xyz/evm",
  534352: "https://rpc.scroll.io", 80094: "https://rpc.berachain.com", 480: "https://worldchain-mainnet.g.alchemy.com/public", 1329: "https://evm-rpc.sei-apis.com",
  57073: "https://rpc-gel.inkonchain.com", 98866: "https://rpc.plume.org", 196: "https://rpc.xlayer.tech",
  1088: "https://andromeda.metis.io/?owner=1088", 1868: "https://rpc.soneium.org", 5000: "https://rpc.mantle.xyz", 747474: "https://rpc.katana.network",
  // The public RPCs packages/networks lists for these chains.
  14: "https://flare-api.flare.network/ext/C/rpc", 5042: "https://rpc.mainnet.arc.io", 2818: "https://rpc.morphl2.io",
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
  if (j.error) throw Object.assign(new Error(j.error.message || JSON.stringify(j.error)), {rpcError: true});
  return j.result;
}
const ghHeaders = () => ({accept: "application/vnd.github+json", "user-agent": "anywalletkit-watch", ...(env.GITHUB_TOKEN ? {authorization: `Bearer ${env.GITHUB_TOKEN}`} : {})});
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",")}}`;
  return JSON.stringify(v);
}
const dig = (o, path) => (path ? path.split(".").reduce((a, k) => (a == null ? a : a[k]), o) : o);
/** A file of the manifest's own package (`rel` from watch.json): anything that resolves outside that directory is refused. */
function ownFile(m, rel) {
  const name = String(rel), dir = dirname(m.file), f = resolve(dir, name);
  if (!f.startsWith(dir + sep)) throw new Error(`${name} is outside ${basename(dir)}`);
  if (!existsSync(f)) throw new Error(`${name} not found in ${basename(dir)}${name.startsWith("dist/") ? " (build the package first)" : ""}`);
  return f;
}

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
    // No EIP-1967 slot: an AragonProxy (stETH) or a FiatTokenProxy (USDC) names its implementation through
    // implementation() instead, and its own code never changes on an upgrade (triage 2026-11-04). Only a revert means
    // "none": any other failure fails the source (previous value kept), so a flaky RPC never reads as a lost implementation.
    // `implProbe` marks a stored reading that already asked implementation(): only a reading without it may take the
    // first answer as a quiet baseline (rebaseline below); on a probed proxy a first answer is an upgrade and is reported.
    // It is bookkeeping, not part of the compared value.
    if (!meta.impl && !meta.beacon) {
      let r = null;
      try { r = addrOfSlot(await rpc(url, "eth_call", [{to: s.address, data: "0x5c60da1b"}, "latest"])); }
      catch (e) { if (!(e.rpcError && /revert/i.test(e.message))) throw new Error(`implementation(): ${e.message}`); }
      meta.implProbe = true;
      if (r) { meta.impl = r; meta.implVia = "implementation()"; }
    }
    if (meta.impl) { try { const ic = await rpc(url, "eth_getCode", [meta.impl, "latest"]); meta.implCodeHash = sha(ic).slice(0, 16); } catch {} }
    const {implProbe: _probe, ...compared} = meta;
    return {value: canonical(compared), meta};
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
    const r = await fetch(s.url, {headers: {"user-agent": "Mozilla/5.0 anywalletkit-watch", ...(s.headers ?? {})}, signal: AbortSignal.timeout(25_000)});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = visibleText(await readCapped(r), s.between);
    if (text.length < 200) throw new Error(`page text too short (${text.length} chars) — selector or JS-rendered page`);
    return {value: sha(text), meta: {hash: sha(text).slice(0, 16), chars: text.length}, text};
  },
  async "json-pins"(s, m) {
    // Every address the module pins, from its built entry (so the pins never drift from what ships), checked against the
    // protocol's official list: listed, under the expected contract name, and `status` where the list carries one.
    const format = Object.prototype.hasOwnProperty.call(RECORD_FORMATS, s.format) ? RECORD_FORMATS[s.format] : null;
    if (!format) throw new Error(`unknown pins format ${s.format}`);
    const pins = pinsFromModule(await import(pathToFileURL(ownFile(m, s.pins?.from)).href), s.pins);
    const r = await fetch(s.url, {headers: {"user-agent": "Mozilla/5.0 anywalletkit-watch"}, signal: AbortSignal.timeout(25_000)});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const {records, info} = format(await readCapped(r));
    const {rows, problems} = checkPins(records, pins, s.status);
    return {value: sha(canonical(rows)), meta: {pins: rows.length, ok: rows.length - problems.length, ...info, rows, problems}, problems};
  },
  async "evm-selectors"(s, m) {
    // What each Diamond selector the module accepts resolves to (DiamondLoupe facets(), one call): a selector whose
    // facet is removed or replaced is a diff — a facet upgrade with new selectors leaves ours refused (EcoFacet v3,
    // triage 2026-11-04). The selector list is read from the module's source on every run.
    const url = rpcFor(s.chainId); if (!url) throw new Error(`no RPC for chain ${s.chainId}`);
    const names = selectorsFromSource(readFileSync(ownFile(m, s.selectors?.file), "utf8"), [].concat(s.selectors?.consts ?? []));
    const facets = decodeFacets(await rpc(url, "eth_call", [{to: s.address, data: "0x7a0ed627"}, "latest"]));
    const map = Object.fromEntries(Object.keys(names).map((sel) => [sel, facets.get(sel) ?? null]));
    const served = Object.values(map).filter(Boolean);
    return {value: sha(canonical(map)), meta: {selectors: served.length, of: Object.keys(map).length, facets: new Set(served).size, map, names}};
  },
  async "rss"(s) {
    const r = await fetch(s.url, {headers: {"user-agent": "anywalletkit-watch"}, signal: AbortSignal.timeout(20_000)});
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
  // State is keyed by module + source id: two sources sharing an id would overwrite each other's
  // target every run, be re-pointed forever and never compared.
  const ids = new Map();
  for (const m of out) {
    const seen = ids.get(m.module) ?? new Map(); ids.set(m.module, seen);
    for (const s of m.sources ?? []) {
      if (!s.id) throw new Error(`${m.file}: a source has no id`);
      if (seen.has(s.id)) throw new Error(`${m.module}: source id "${s.id}" appears twice (${seen.get(s.id)}, ${m.file})`);
      seen.set(s.id, m.file);
    }
  }
  return out.filter((m) => !ONLY || ONLY.some((o) => m.module.includes(o)));
}
const slug = (m) => m.replace(/^@anywalletkit\//, "");
const stateFile = (m) => resolve(ROOT, "watch/state", `${slug(m)}.json`);
const loadState = (m) => (existsSync(stateFile(m)) ? JSON.parse(readFileSync(stateFile(m), "utf8")) : {module: m, sources: {}});

// ── diff summaries ─────────────────────────────────────────────────────────
function describe(s, before, after) {
  const b = before?.meta ?? {}, a = after.meta ?? {};
  switch (s.type) {
    case "evm-proxy": {
      const parts = [];
      if (b.impl !== a.impl) parts.push(`implementation${a.implVia ? ` (${a.implVia})` : ""} ${b.impl ?? "—"} → ${a.impl ?? "—"}`);
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
    case "json-pins": {
      const key = (r) => `${r.group} ${r.role}`;
      const B = new Map((b.rows ?? []).map((r) => [key(r), r])), A = new Map((a.rows ?? []).map((r) => [key(r), r]));
      const show = (r) => (r ? `${r.address.slice(0, 10)}… ${r.contract ?? "not listed"}${r.status ? ` ${r.status}` : ""}` : "—");
      const parts = [];
      for (const [k, r] of A) { const p = B.get(k); if (!p || canonical(p) !== canonical(r)) parts.push(`${k}: ${show(p)} → ${show(r)}`); }
      for (const [k, p] of B) if (!A.has(k)) parts.push(`${k}: ${show(p)} → no longer pinned`);
      return parts.length ? `${parts.slice(0, 6).join("; ")}${parts.length > 6 ? `; …and ${parts.length - 6} more` : ""}` : "listing changed";
    }
    case "evm-selectors": {
      const B = b.map ?? {}, A = a.map ?? {}, name = (sel) => (a.names?.[sel] || b.names?.[sel] ? `${sel} ${a.names?.[sel] || b.names?.[sel]}` : sel);
      const moves = new Map(), parts = [];
      for (const sel of Object.keys(A)) {
        if (!(sel in B)) { parts.push(`now watched: ${name(sel)} → ${A[sel] ?? "none"}`); continue; }
        if (B[sel] === A[sel]) continue;
        const k = A[sel] == null ? `removed from ${B[sel]}` : B[sel] == null ? `added on ${A[sel]}` : `facet ${B[sel]} → ${A[sel]}`;
        moves.set(k, [...(moves.get(k) ?? []), sel]);
      }
      for (const [k, sels] of moves) parts.unshift(`${k}: ${sels.slice(0, 4).map(name).join(", ")}${sels.length > 4 ? ` +${sels.length - 4}` : ""}`);
      const dropped = Object.keys(B).filter((sel) => !(sel in A));
      if (dropped.length) parts.push(`no longer watched: ${dropped.slice(0, 4).map(name).join(", ")}${dropped.length > 4 ? ` +${dropped.length - 4}` : ""}`);
      return parts.join("; ") || "selectors changed";
    }
    case "rss": { const B = new Set(b.titles ?? []); const n = (a.titles ?? []).filter((t) => !B.has(t)); return n.length ? `new: ${n.map((t) => `“${t}”`).join(", ")}` : "items changed"; }
    default: return "changed";
  }
}
const linkOf = (s, after) => safeLink(after.meta?.url || (s.type === "http-json" || s.type === "http-text" || s.type === "rss" || s.type === "json-pins" ? s.url : s.type.startsWith("github") ? `https://github.com/${s.repo}` : null), s);
/**
 * A stored value that is not an upstream change: the manifest gave the source another type (the old value is from
 * another fetcher), or `evm-proxy` reads implementation() for the first time ever (the stored reading carries no
 * `implProbe` marker) where the old reading had no implementation at all. Both are a new baseline, written without a
 * diff. Once a reading is probed, an implementation() that starts answering is a diff like any upgrade.
 */
function rebaseline(s, prev, r) {
  if (prev.type !== s.type) return "the source type changed";
  if (s.type === "evm-proxy" && r.meta?.implVia && !prev.meta?.implProbe && !prev.meta?.impl && !prev.meta?.implVia) {
    const {impl, implVia: _via, implCodeHash: _code, implProbe: _probe, ...rest} = r.meta, {impl: _was, implCodeHash: _wasCode, implProbe: _wasProbe, ...was} = prev.meta ?? {};
    if (canonical(rest) === canonical(was)) return `first implementation() reading ${impl}`;
  }
  return null;
}
/**
 * Where a source reads from (chain, contract, program, page, file). Stored with each value: when the manifest points
 * an existing id somewhere else (Uniswap QuoterV2 moved to the active deployments, triage 2026-11-04), the old value
 * belongs to the old target, so the source is re-baselined and listed as re-pointed instead of reported as changed.
 * EVM addresses compare case-insensitively (checksummed vs lowercase is the same contract).
 */
const TARGET_KEYS = ["chainId", "address", "programId", "url", "repo", "path", "ref"];
function targetOf(s) {
  const t = {};
  for (const k of TARGET_KEYS) if (s[k] != null) t[k] = typeof s[k] === "string" && /^0x[0-9a-f]{40}$/i.test(s[k]) ? s[k].toLowerCase() : s[k];
  return t;
}
const showTarget = (t) => [t.chainId != null ? `chain ${t.chainId}` : "", t.address ?? t.programId ?? t.url ?? "", t.repo ? `${t.repo}${t.path ? `/${t.path}` : ""}${t.ref ? `@${t.ref}` : ""}` : ""].filter(Boolean).join(" ") || "—";

// ── run ────────────────────────────────────────────────────────────────────
const manifests = loadManifests();
if (!manifests.length) { console.error("no watch.json manifests found"); process.exit(1); }
const changes = [], errors = [], repointed = [];
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
      const r = await F[s.type](s, m);
      let prev = state.sources[s.id];
      const target = targetOf(s);
      // A stored entry written before targets were recorded has none: it is compared as before and gets one now.
      if (prev?.target && canonical(prev.target) !== canonical(target)) {
        repointed.push({module: m.module, id: s.id, label: s.label ?? s.id, from: prev.target, to: target});
        console.error(`baseline ${slug(m.module)} · ${s.id}: source re-pointed ${showTarget(prev.target)} → ${showTarget(target)}`);
        prev = undefined;
      }
      const why = prev && prev.value !== r.value ? rebaseline(s, prev, r) : null;
      if (why) { console.error(`baseline ${slug(m.module)} · ${s.id}: ${why}`); prev = undefined; }
      const now = new Date().toISOString();
      const changed = !!prev && prev.value !== r.value;
      // A failed pin check is reported on every run until it is fixed, not only on the day it appears.
      const failed = r.problems?.length ? `${r.problems.length} pin check${r.problems.length > 1 ? "s" : ""} failing: ${r.problems.slice(0, 4).join("; ")}${r.problems.length > 4 ? `; …and ${r.problems.length - 4} more` : ""}` : null;
      if (changed || failed) changes.push({module: m.module, id: s.id, label: s.label ?? s.id, type: s.type, what: [changed ? describe(s, prev, r) : null, failed].filter(Boolean).join("; "), link: linkOf(s, r), before: prev?.meta, after: r.meta});
      state.sources[s.id] = {type: s.type, target, value: r.value, meta: r.meta, seenAt: now, changedAt: changed ? now : prev?.changedAt ?? now, ...(prev?.error ? {} : {})};
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
// Grouping keys come from upstream answers (an RPC error message can be "constructor" or "__proto__"), so the groups
// live in a Map: a plain object would hand back the inherited Object.prototype value and the digest would throw (scan 2026-10-30 F19).
const groupBy = (list, key) => { const g = new Map(); for (const x of list) { const k = String(key(x)); const a = g.get(k); if (a) a.push(x); else g.set(k, [x]); } return g; };
const byModule = (list) => groupBy(list, (c) => c.module);
const lines = [`# Module watch · ${TODAY}`, "", `${manifests.length} modules, ${total} sources, ${changes.length} changed, ${errors.length} unreachable${repointed.length ? `, ${repointed.length} re-pointed` : ""}.`, ""];
for (const [mod, cs] of byModule(changes)) {
  lines.push(`## ${mod}`);
  for (const c of cs) lines.push(`- **${c.label}** (${c.type}): ${c.what}${c.link ? ` — ${c.link}` : ""}`);
  lines.push("");
}
// Our own manifest edits, not upstream changes: shown so a re-pointed source never looks silently reset.
const repointLine = (p) => `${slug(p.module)} · ${p.label}: ${showTarget(p.from)} → ${showTarget(p.to)}`;
if (repointed.length) {
  lines.push("## Re-pointed (new baseline, not a change)");
  for (const p of repointed) lines.push(`- ${repointLine(p)}`);
  lines.push("");
}
const errorGroups = [...groupBy(errors, (e) => e.error)].sort((a, b) => b[1].length - a[1].length);
if (errors.length) {
  lines.push("## Unreachable");
  for (const [err, es] of errorGroups) lines.push(es.length > 3 ? `- ${err} — ${es.length} sources: ${es.slice(0, 6).map((e) => `${slug(e.module)} · ${e.label}`).join("; ")}${es.length > 6 ? "; …" : ""}` : es.map((e) => `- ${slug(e.module)} · ${e.label}: ${err}${e.stale ? " (previous value kept)" : ""}`).join("\n"));
  lines.push("");
}
const digest = lines.join("\n");
console.log(digest);
if (!DRY && !BASELINE) {
  mkdirSync(resolve(ROOT, "watch/diff"), {recursive: true}); mkdirSync(resolve(ROOT, "watch/digest"), {recursive: true});
  writeFileSync(resolve(ROOT, "watch/diff", `${TODAY}.json`), JSON.stringify({date: TODAY, modules: manifests.length, sources: total, changes, errors, repointed}, null, 1) + "\n");
  writeFileSync(resolve(ROOT, "watch/digest", `${TODAY}.md`), digest);
}
if (BASELINE) console.error(`baseline written for ${manifests.length} modules (${total} sources, ${errors.length} unreachable)`);

// ── telegram ───────────────────────────────────────────────────────────────
async function postTelegram(lines) {
  const token = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_WATCH_CHAT || env.TELEGRAM_ALERTS_CHAT;
  if (!token || !chat) { console.error("telegram: TELEGRAM_BOT_TOKEN / TELEGRAM_WATCH_CHAT not set, skipping"); return false; }
  const body = {chat_id: chat, text: Array.isArray(lines) ? fitLines(lines, (n) => `…and ${n} more lines — full digest: watch/digest/${TODAY}.md`) : lines, parse_mode: "HTML", disable_web_page_preview: true};
  if (env.TELEGRAM_WATCH_TOPIC) body.message_thread_id = Number(env.TELEGRAM_WATCH_TOPIC);
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000)});
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { console.error(`telegram: send failed (${j.description ?? r.status})`); return false; }
  return true;
}
if (SEND && !BASELINE) {
  if (!changes.length && !errors.length && !repointed.length) {
    if (flag("--quiet-ok")) await postTelegram(`🟢 <b>Module watch · ${TODAY}</b> — ${manifests.length} modules, ${total} sources, no changes.`);
  } else {
    const h = [`${changes.length ? "🟠" : "🟡"} <b>Module watch · ${TODAY}</b> — ${changes.length} changed, ${errors.length} unreachable of ${total} sources${repointed.length ? `, ${repointed.length} re-pointed` : ""}`];
    for (const [mod, cs] of byModule(changes)) {
      h.push("", `<b>${esc(slug(mod))}</b>`);
      for (const c of cs) h.push(`• ${c.link ? `<a href="${esc(c.link)}">${esc(c.label)}</a>` : esc(c.label)}: ${esc(c.what)}`);
    }
    if (errors.length) {
      h.push("", "<i>unreachable:</i>");
      for (const [err, es] of errorGroups.slice(0, 8)) h.push(es.length > 3 ? `• ${esc(err)} — ${es.length} sources (${esc(es.slice(0, 3).map((e) => e.label).join(", "))}…)` : es.map((e) => `• ${esc(slug(e.module))} · ${esc(e.label)}: ${esc(err)}`).join("\n"));
      if (errorGroups.length > 8) h.push(`• …and ${errorGroups.length - 8} more kinds`);
    }
    if (repointed.length) {
      h.push("", "<i>re-pointed (new baseline, not a change):</i>");
      for (const p of repointed.slice(0, 8)) h.push(`• ${esc(repointLine(p))}`);
      if (repointed.length > 8) h.push(`• …and ${repointed.length - 8} more`);
    }
    // A digest Telegram refused must fail the job: the state commit is skipped, so the changes alert again tomorrow (scan F13).
    if (!(await postTelegram(h.flatMap((l) => l.split("\n"))))) process.exitCode = 1;
  }
}
process.exit(process.exitCode ?? 0);
