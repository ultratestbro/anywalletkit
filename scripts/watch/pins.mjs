// Pins and ABI words for the watch sources that check what a module trusts, not only what changed upstream
// (watch triage 2026-11-04): `json-pins` (every address a module pins must be listed in the protocol's official feed or
// docs payload, under the expected contract name, and active where the feed carries a status), `evm-selectors` (what
// each Diamond selector a module accepts resolves to) and the AragonProxy branch of `evm-proxy`. Pure functions:
// watch.mjs does the fetching.
//
//   node --test scripts/watch/watch-2026-11-04-pins.test.mjs

/** The `{ … }` body of `const NAME … = {` (or `= Object.freeze({`) in a TypeScript source, up to the first `};` / `});` at line start, or null. */
function constBody(text, name) {
  const m = new RegExp(`\\bconst ${name}\\b[^=]*=\\s*(?:Object\\.freeze\\()?\\{`).exec(text);
  if (!m) return null;
  const from = m.index + m[0].length;
  const stop = ["\n};", "\n});"].map((c) => text.indexOf(c, from)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  return stop === undefined ? null : text.slice(from, stop);
}

/**
 * The 4-byte selectors listed as keys of the object literals `names` in a module's source (BRIDGE_CALLS and
 * GENERIC_SWAPS in protocol-swap2-lifi/src/calldata.ts) → {selector: function name from the line's `// comment`, or ""},
 * selectors lower-cased and sorted. A missing or empty constant throws: a refactor that moves them must fail the
 * source, not leave it watching nothing.
 */
export function selectorsFromSource(text, names) {
  const out = {};
  for (const name of names) {
    const body = constBody(text, name);
    if (body == null) throw new Error(`const ${name} not found`);
    const keys = [...body.matchAll(/^\s*"(0x[0-9a-fA-F]{8})"\s*:([^\n]*)$/gm)];
    if (!keys.length) throw new Error(`const ${name} lists no selectors`);
    for (const k of keys) out[k[1].toLowerCase()] ??= /\/\/\s*(\w+)/.exec(k[2])?.[1] ?? "";
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** `"key": "0x…address"` pairs of an object literal (LIFI_DIAMONDS), keys as written, addresses lower-cased. */
export function addressMapFromSource(text, name) {
  const body = constBody(text, name);
  if (body == null) throw new Error(`const ${name} not found`);
  return Object.fromEntries([...body.matchAll(/^\s*"([^"]+)"\s*:\s*"(0x[0-9a-fA-F]{40})"/gm)].map((e) => [e[1], e[2].toLowerCase()]));
}

/** The quoted keys of an object literal (the CAIP-2 ids of LIFI_CHAIN); computed keys (`[X]:`) are skipped. */
export function keysFromSource(text, name) {
  const body = constBody(text, name);
  if (body == null) throw new Error(`const ${name} not found`);
  return [...body.matchAll(/^\s*"([^"]+)"\s*:/gm)].map((k) => k[1]);
}

/**
 * DiamondLoupe `facets()` (0x7a0ed627) → Map(selector → facet address). Untrusted RPC data: every offset, length and
 * word is checked against the payload, and a malformed answer throws instead of yielding a partial map.
 */
export function decodeFacets(hex) {
  if (typeof hex !== "string" || !/^0x(?:[0-9a-fA-F]{64})+$/.test(hex)) throw new Error("facets(): not ABI words");
  const words = (hex.length - 2) / 64;
  const w = (i) => {
    if (!Number.isInteger(i) || i < 0 || i >= words) throw new Error("facets(): offset out of range");
    return BigInt("0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
  };
  const at = (byteOffset) => {
    if (byteOffset % 32n !== 0n || byteOffset >= BigInt(words) * 32n) throw new Error("facets(): bad offset");
    return Number(byteOffset / 32n);
  };
  const arr = at(w(0));
  const n = w(arr);
  if (n > 4096n) throw new Error("facets(): too many facets");
  const out = new Map();
  for (let i = 0; i < Number(n); i++) {
    const t = arr + 1 + at(w(arr + 1 + i));
    const facet = w(t);
    if (facet >> 160n) throw new Error("facets(): facet is not an address");
    const sel = t + at(w(t + 1));
    const m = w(sel);
    if (m > 4096n) throw new Error("facets(): too many selectors");
    for (let j = 0; j < Number(m); j++) {
      const v = w(sel + 1 + j);
      if (v & ((1n << 224n) - 1n)) throw new Error("facets(): selector is not bytes4");
      out.set("0x" + (v >> 224n).toString(16).padStart(8, "0"), "0x" + facet.toString(16).padStart(40, "0"));
    }
  }
  return out;
}

/** The balanced `{ … }` that starts at `from` (JSON string-aware), or null. */
function objectAt(text, from) {
  let depth = 0, inStr = false, esc = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(from, i + 1);
  }
  return null;
}

/**
 * Official lists the pins are checked against, as {group, contract, address, status?, id?} records. `group` is what a pin
 * is matched in besides its address (a chain id, a market name).
 */
export const RECORD_FORMATS = {
  /** developers.uniswap.org/deployments.json: {version, generatedAt, source: {commit}, records: [{id, contract, chainId, address, status}]}. */
  "uniswap-deployments"(body) {
    const j = JSON.parse(body);
    if (!Array.isArray(j?.records)) throw new Error("no records[] in the feed");
    const records = j.records.map((r) => ({group: String(r?.chainId), contract: r?.contract, address: r?.address, status: r?.status, id: r?.id}));
    return {records, info: {generatedAt: j.generatedAt ?? null, commit: typeof j.source?.commit === "string" ? j.source.commit.slice(0, 12) : null}};
  },
  /**
   * aave.com/docs/reference/addresses: the page renders the V4 tab; every market's tables sit in its embedded payload as
   * {"id":"AaveV3Ethereum","name":…,"version":"Aave V3","sections":[{"title":"Contracts","rows":[{"name":"Pool","cells":[{"address":…}]}]}]}.
   * A market object that does not parse (cut across payload chunks) is skipped: its pins then report "not listed".
   */
  "aave-docs-markets"(body) {
    const text = body.replace(/\\"/g, '"');
    const records = [];
    const markets = new Set();
    for (let i = text.indexOf('{"id":"AaveV'); i >= 0; i = text.indexOf('{"id":"AaveV', i + 1)) {
      const raw = objectAt(text, i);
      let o;
      try { o = raw && JSON.parse(raw); } catch { continue; }
      if (!o || typeof o.id !== "string" || !Array.isArray(o.sections) || markets.has(o.id)) continue;
      markets.add(o.id);
      for (const sec of o.sections) for (const row of Array.isArray(sec?.rows) ? sec.rows : []) {
        const address = row?.cells?.[0]?.address;
        if (typeof row?.name === "string" && typeof address === "string") records.push({group: o.id, contract: row.name, address, id: `${o.id}.${row.name}`});
      }
    }
    if (!markets.size) throw new Error("no market tables in the page payload");
    return {records, info: {markets: markets.size}};
  },
  /**
   * docs.curve.finance/deployments.json: {_instructions, _explorers, <chain>: {tokens, integrations, amm: {"router & zap",
   * stableswap, twocrypto, tricrypto, fxswap}, scrvusd?, …}}. Records, id `<chain>.<what>`: every Router NG (`router`, and on
   * Ethereum `router-v1` / `router-v2`, all named "router"), the AddressProvider and MetaRegistry, the pool factories
   * ("stableswap-factory", …), the tokens crvUSD / scrvUSD / CRV (`<chain>.tokens.<symbol>`) and the scrvUSD vault. The feed
   * has known slips (the crvUSD LayerZero bridges on Ethereum), so a module pins on-chain facts too: this is a signal.
   */
  "curve-deployments"(body) {
    const j = JSON.parse(body);
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not a deployments object");
    const chains = Object.keys(j).filter((k) => !k.startsWith("_") && j[k] && typeof j[k] === "object" && !Array.isArray(j[k]));
    const records = [];
    const add = (chain, contract, what, address) => {
      if (isAddress(address)) records.push({group: String(CURVE_CHAIN_IDS[chain] ?? chain), contract, address, id: `${chain}.${what}`});
    };
    for (const chain of chains) {
      const c = j[chain];
      for (const [k, a] of Object.entries(c.amm?.["router & zap"] ?? {})) if (/^router(-v\d+)?$/.test(k)) add(chain, "router", k, a);
      add(chain, "address-provider", "address-provider", c.integrations?.["address-provider"]);
      add(chain, "meta-registry", "meta-registry", c.integrations?.["meta-registry"]);
      for (const kind of CURVE_FACTORIES) add(chain, `${kind}-factory`, `${kind}.factory`, c.amm?.[kind]?.factory);
      for (const [k, a] of Object.entries(c.tokens ?? {})) {
        const symbol = Object.prototype.hasOwnProperty.call(CURVE_TOKENS, k.toLowerCase()) ? CURVE_TOKENS[k.toLowerCase()] : null;
        if (symbol) add(chain, symbol, `tokens.${symbol}`, a);
      }
      add(chain, "scrvUSD vault", "scrvusd.vault", c.scrvusd?.vault);
    }
    if (!records.some((r) => r.contract === "router")) throw new Error("no routers in the feed");
    return {records, info: {chains: chains.length}};
  },
};

/**
 * docs.curve.finance/deployments.json names chains by key; a record is grouped by the chain id where the chain is one the
 * SDK carries (so a module's pins keyed by chain id match), by the key otherwise.
 */
const CURVE_CHAIN_IDS = {
  ethereum: 1, optimism: 10, bsc: 56, gnosis: 100, unichain: 130, polygon: 137, monad: 143, sonic: 146, "x-layer": 196, hyperliquid: 999,
  robinhood: 4663, mantle: 5000, arc: 5042, base: 8453, plasma: 9745, celo: 42220, arbitrum: 42161, avalanche: 43114, ink: 57073, plume: 98866,
};
const CURVE_TOKENS = {crv: "CRV", crvusd: "crvUSD", scrvusd: "scrvUSD"};
const CURVE_FACTORIES = ["stableswap", "twocrypto", "tricrypto", "fxswap"];
const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** Groups compare without case or punctuation: "Aave V3 Ink (whitelabel)" is the docs' "AaveV3InkWhitelabel". */
export const normGroup = (g) => String(g).toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The pins a module exports, from its built entry: `desc.export` is an object (keyed by `$key`, e.g. chain id → deployment)
 * or, with `desc.call`, a function returning a list (e.g. listMarkets()). `desc.group` names the field (or `$key`) a pin
 * is grouped by, `desc.roles` maps a field holding an address to the contract name the official list must give it;
 * a role a deployment does not have (no gateway on Celo) is skipped.
 */
export function pinsFromModule(mod, desc) {
  let items = mod?.[desc.export];
  if (desc.call) items = typeof items === "function" ? items() : undefined;
  if (!items || typeof items !== "object") throw new Error(`${desc.export} is not exported`);
  const entries = Array.isArray(items) ? items.map((x) => [null, x]) : Object.entries(items);
  const pins = [];
  for (const [key, item] of entries) {
    const group = desc.group === "$key" ? key : item?.[desc.group];
    if (group == null) throw new Error(`a pin of ${desc.export} has no ${desc.group}`);
    for (const [field, contract] of Object.entries(desc.roles)) {
      const address = item?.[field];
      if (address === undefined) continue;
      if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`${desc.export} ${group}.${field} is not an address`);
      pins.push({group: String(group), role: field, contract, address});
    }
  }
  if (!pins.length) throw new Error(`${desc.export} yields no pins`);
  return pins;
}

/**
 * Each pin must be listed in its group (address compared lower-cased) under the expected contract name, and — when
 * `status` is given — carry that status. Returns the per-pin rows (what the watch compares: a status, name or listing
 * change is a diff) and the problems (reported on every run until they are gone).
 */
export function checkPins(records, pins, status) {
  const index = new Map();
  for (const r of records ?? []) {
    if (!r || typeof r.address !== "string" || r.group == null) continue;
    const k = `${normGroup(r.group)}:${r.address.toLowerCase()}`;
    const list = index.get(k);
    if (list) list.push(r); else index.set(k, [r]);
  }
  const rows = [], problems = [];
  for (const p of pins) {
    const found = index.get(`${normGroup(p.group)}:${p.address.toLowerCase()}`) ?? [];
    const named = found.filter((r) => r.contract === p.contract);
    const hit = (status ? named.find((r) => r.status === status) : undefined) ?? named[0] ?? found[0];
    rows.push({group: p.group, role: p.role, address: p.address.toLowerCase(), contract: hit?.contract ?? null, ...(status ? {status: hit?.status ?? null} : {}), id: hit?.id ?? null});
    const where = `${p.group} ${p.role} ${p.address}`;
    if (!found.length) problems.push(`${where}: not listed`);
    else if (!named.length) problems.push(`${where}: listed as ${[...new Set(found.map((r) => r.contract + (r.status ? ` (${r.status})` : "")))].join(" / ")}, not ${p.contract}`);
    else if (status && hit.status !== status) problems.push(`${where}: ${p.contract} is ${hit.status ?? "without a status"}, not ${status}`);
  }
  rows.sort((a, b) => a.group.localeCompare(b.group, "en", {numeric: true}) || a.role.localeCompare(b.role));
  return {rows, problems};
}
