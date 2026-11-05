// node --test scripts/watch/watch-2026-11-04-sources.test.mjs — watch triage 2026-11-04, end to end through watch.mjs:
//   - evm-proxy reads implementation() when the EIP-1967 slot is empty (stETH is an AragonProxy: impl was null, an upgrade
//     never moved the hash); the first such reading is a silent new baseline only once (a probed reading is marked, and
//     a later first answer is reported), a revert means "none", any other RPC failure keeps the previous value; a
//     resolving EIP-1967 proxy is not asked at all;
//   - evm-selectors: what each selector of the module's own source resolves to on the Diamond; a removed facet is a diff;
//   - json-pins: pins from the package's dist checked against a feed; a failing pin is reported on every run;
//   - a source whose manifest type changed is re-baselined instead of reported;
//   - a source the manifest points at another address / chain is re-baselined and listed as re-pointed, not changed.
// Same sandbox as scan-2026-10-30-f19.test.mjs: watch.mjs copied into a temp root with synthetic manifests, local servers.
import {test} from "node:test";
import assert from "node:assert/strict";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {createServer} from "node:http";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const sha16 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",")}}` : JSON.stringify(v);
const ZERO = "0x" + "0".repeat(64);
const pad = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
/** ABI encoding of DiamondLoupe facets() → (address facet, bytes4[] selectors)[]. */
function encodeFacets(facets) {
  const tuples = facets.map(([addr, sels]) => word(BigInt(addr)) + word(64) + word(sels.length) + sels.map((x) => x.slice(2).padEnd(64, "0")).join(""));
  let off = facets.length * 32;
  const heads = tuples.map((t) => { const h = word(off); off += t.length / 2; return h; });
  return "0x" + word(32) + word(facets.length) + heads.join("") + tuples.join("");
}

function sandbox(manifests, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "watch-1104-"));
  mkdirSync(join(root, "scripts/watch"), {recursive: true});
  for (const f of ["watch.mjs", "html-text.mjs", "pins.mjs", "evm-call.mjs"]) copyFileSync(join(here, f), join(root, "scripts/watch", f));
  for (const [dir, m] of Object.entries(manifests)) { mkdirSync(join(root, "packages", dir), {recursive: true}); writeFileSync(join(root, "packages", dir, "watch.json"), JSON.stringify(m)); }
  for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(root, rel)), {recursive: true}); writeFileSync(join(root, rel), text); }
  return root;
}
const writeState = (root, slug, sources) => { mkdirSync(join(root, "watch/state"), {recursive: true}); writeFileSync(join(root, "watch/state", `${slug}.json`), JSON.stringify({module: `@anywalletkit/${slug}`, sources})); };
const readState = (root, slug) => JSON.parse(readFileSync(join(root, "watch/state", `${slug}.json`), "utf8")).sources;

/** One local server: POST = JSON-RPC through `rpc(method, params)` ({result} | {error}); GET = `pages[path]`. Calls are logged. */
async function serve(rpc, pages = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET") { const p = pages[req.url]; res.statusCode = p ? 200 : 404; res.end(typeof p === "function" ? p() : p ?? ""); return; }
      const {method, params} = JSON.parse(body);
      calls.push({method, params});
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({jsonrpc: "2.0", id: 1, ...rpc(method, params)}));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close()};
}

async function run(root, rpcUrl, extraEnv = {}) {
  const child = spawn(process.execPath, [join(root, "scripts/watch/watch.mjs")], {
    env: {PATH: process.env.PATH, GITHUB_TOKEN: "x", EVM_RPC_URL: rpcUrl, ...extraEnv},
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "", err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const code = await new Promise((r) => child.on("close", r));
  return {code, out, err};
}

const ARAGON = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84", PLAIN = "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", P1967 = "0x889edc2edab5f40e902b864ad4d7ade8e412f9b1";
const IMPL_A = "0x028271e30a695c0527a0c50ca30603fed004cdb0", IMPL_B = "0x00000000000000000000000000000000000000b2", IMPL_1967 = "0xe42c659dc09109566720ea8b2de186c2be7d94d9";
const CODE = {[ARAGON]: "0x6080aa", [PLAIN]: "0x6080bb", [P1967]: "0x6080cc", [IMPL_A]: "0x60aa", [IMPL_B]: "0x60bb", [IMPL_1967]: "0x60cc"};

test("evm-proxy: implementation() is read when the EIP-1967 slot is empty, a first reading is a new baseline, an upgrade is a diff", async () => {
  let impl = IMPL_A, implementationError = null, plainImpl = null;
  const srv = await serve((method, [a, b]) => {
    if (method === "eth_getCode") return {result: CODE[a.toLowerCase()] ?? "0x"};
    if (method === "eth_getStorageAt") return {result: a === P1967 && b.startsWith("0x3608") ? pad(IMPL_1967) : ZERO};
    if (method === "eth_call" && a.data === "0x5c60da1b") {
      if (a.to === ARAGON) return implementationError ? {error: {code: -32000, message: implementationError}} : {result: pad(impl)};
      if (a.to === PLAIN && plainImpl) return {result: pad(plainImpl)};
      return {error: {code: 3, message: "execution reverted"}};
    }
    return {error: {code: -32601, message: "method not found"}};
  });
  const sources = [
    {id: "steth", type: "evm-proxy", chainId: 1, address: ARAGON, label: "Lido stETH"},
    {id: "wsteth", type: "evm-proxy", chainId: 1, address: PLAIN, label: "Lido wstETH"},
    {id: "wq", type: "evm-proxy", chainId: 1, address: P1967, label: "Lido WQ"},
  ];
  const root = sandbox({lido: {module: "@anywalletkit/lido", sources}});
  // Yesterday's state, written before implementation() was read: impl null on both, the 1967 proxy resolved.
  const old = (addr) => ({codeHash: sha16(CODE[addr]), impl: null, admin: null, beacon: null});
  const wq = {codeHash: sha16(CODE[P1967]), impl: IMPL_1967, admin: null, beacon: null, implCodeHash: sha16(CODE[IMPL_1967])};
  writeState(root, "lido", {
    steth: {type: "evm-proxy", value: canonical(old(ARAGON)), meta: old(ARAGON)},
    wsteth: {type: "evm-proxy", value: canonical(old(PLAIN)), meta: old(PLAIN)},
    wq: {type: "evm-proxy", value: canonical(wq), meta: wq},
  });
  try {
    let r = await run(root, srv.url);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /0 changed, 0 unreachable/);
    assert.match(r.err, new RegExp(`baseline lido · steth: first implementation\\(\\) reading ${IMPL_A}`));
    let st = readState(root, "lido");
    assert.equal(st.steth.meta.impl, IMPL_A);
    assert.equal(st.steth.meta.implVia, "implementation()");
    assert.equal(st.steth.meta.implCodeHash, sha16(CODE[IMPL_A]));
    assert.equal(st.wsteth.value, canonical(old(PLAIN)), "a reverting implementation() leaves a plain contract's value as it was");
    assert.equal(st.wsteth.meta.implProbe, true, "the reverting implementation() is recorded as probed");
    assert.equal(st.steth.meta.implProbe, true);
    assert.equal(st.wq.meta.implProbe, undefined, "a resolving EIP-1967 proxy is not probed");
    assert.equal(st.wq.value, canonical(wq), "a resolving EIP-1967 proxy keeps its value");
    assert.ok(!srv.calls.some((c) => c.method === "eth_call" && c.params[0].to === P1967), "implementation() is not asked when the slot resolves");

    impl = IMPL_B;
    r = await run(root, srv.url);
    assert.match(r.out, new RegExp(`\\*\\*Lido stETH\\*\\* \\(evm-proxy\\): implementation \\(implementation\\(\\)\\) ${IMPL_A} → ${IMPL_B}`));
    assert.match(r.out, /1 changed, 0 unreachable/);

    // An RPC failure that is not a revert must not read as "the implementation is gone".
    implementationError = "header not found";
    r = await run(root, srv.url);
    assert.match(r.out, /Lido stETH: implementation\(\): header not found \(previous value kept\)/);
    st = readState(root, "lido");
    assert.equal(st.steth.meta.impl, IMPL_B);

    // The quiet first reading is one-time: wstETH was probed (implementation() reverted), so an implementation()
    // that starts answering behind unchanged own code is an upgrade, and it is reported.
    implementationError = null; plainImpl = IMPL_A;
    r = await run(root, srv.url);
    assert.doesNotMatch(r.err, /baseline lido · wsteth/);
    assert.match(r.out, new RegExp(`\\*\\*Lido wstETH\\*\\* \\(evm-proxy\\): implementation \\(implementation\\(\\)\\) — → ${IMPL_A}`));
    assert.match(r.out, /1 changed, 0 unreachable/);
  } finally { srv.close(); }
});

const CALLDATA = (bridge) => `const GENERIC_SWAPS: Readonly<Record<string, {single: boolean}>> = {
  "0x4666fc80": {single: true, from: "erc20", to: "erc20"}, // swapTokensSingleV3ERC20ToERC20
};
const BRIDGE_CALLS: Readonly<Record<string, {sourceSwaps: boolean; facet: string}>> = {
${bridge}
};
`;
const DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", ECO = "0x1221db54f6faf9b26c23dbe54aa48f0b0a6a5600", SWAP = "0x00000000000000000000000000000000000000a1";

test("evm-selectors: the source's own selectors are resolved on the Diamond; a removed or new selector is named in the diff", async () => {
  let facets = [[ECO, ["0xbff90b61", "0x762aea18"]], [SWAP, ["0x4666fc80"]]];
  const srv = await serve((method, [call]) => (method === "eth_call" && call.to === DIAMOND && call.data === "0x7a0ed627" ? {result: encodeFacets(facets)} : {error: {code: 3, message: "execution reverted"}}));
  const v2 = `  "0xbff90b61": {sourceSwaps: false, facet: "Eco"}, // startBridgeTokensViaEco (EcoFacet)\n  "0x762aea18": {sourceSwaps: true, facet: "Eco"}, // swapAndStartBridgeTokensViaEco (EcoFacet)`;
  const source = {id: "diamond-ethereum", type: "evm-selectors", chainId: 1, address: DIAMOND, selectors: {file: "src/calldata.ts", consts: ["BRIDGE_CALLS", "GENERIC_SWAPS"]}, label: "LI.FI Diamond selectors · Ethereum"};
  const root = sandbox({lifi: {module: "@anywalletkit/lifi", sources: [source, {...source, id: "outside", selectors: {file: "../other/src/calldata.ts", consts: ["BRIDGE_CALLS"]}, label: "Outside"}]}},
    {"packages/lifi/src/calldata.ts": CALLDATA(v2), "packages/other/src/calldata.ts": CALLDATA(v2)});
  try {
    let r = await run(root, srv.url);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Outside: \.\.\/other\/src\/calldata\.ts is outside lifi/);
    const st = readState(root, "lifi")["diamond-ethereum"];
    assert.deepEqual(st.meta.map, {"0x4666fc80": SWAP, "0x762aea18": ECO, "0xbff90b61": ECO});
    assert.equal(st.meta.selectors, 3);

    // EcoFacet v3: the facet's old selectors are cut, the new ones added (lifinance/contracts 9001792).
    facets = [[ECO, ["0x05c54990", "0x8352664c"]], [SWAP, ["0x4666fc80"]]];
    r = await run(root, srv.url);
    assert.match(r.out, new RegExp(`removed from ${ECO}: 0x762aea18 swapAndStartBridgeTokensViaEco, 0xbff90b61 startBridgeTokensViaEco`));

    // The module follows: its source now lists the v3 selectors, which the diff reports as newly watched.
    writeFileSync(join(root, "packages/lifi/src/calldata.ts"), CALLDATA(`  "0x05c54990": {sourceSwaps: false, facet: "Eco"}, // startBridgeTokensViaEco (EcoFacet)\n  "0x8352664c": {sourceSwaps: true, facet: "Eco"}, // swapAndStartBridgeTokensViaEco (EcoFacet)`));
    r = await run(root, srv.url);
    assert.match(r.out, new RegExp(`now watched: 0x05c54990 startBridgeTokensViaEco → ${ECO}`));
    assert.match(r.out, /no longer watched: 0x762aea18 swapAndStartBridgeTokensViaEco, 0xbff90b61 startBridgeTokensViaEco/);

    // A refactor that renames the constants fails the source instead of watching nothing.
    writeFileSync(join(root, "packages/lifi/src/calldata.ts"), "const BRIDGE_CALLS = {\n};\n");
    r = await run(root, srv.url);
    assert.match(r.out, /LI\.FI Diamond selectors · Ethereum: const BRIDGE_CALLS lists no selectors \(previous value kept\)/);
  } finally { srv.close(); }
});

test("json-pins: pins come from the package's dist; a deprecated pin is a diff and stays reported until fixed; a type change re-baselines", async () => {
  let status = "active";
  const feed = () => JSON.stringify({version: "1.0.0", generatedAt: "2026-10-16T21:00:00.000Z", source: {commit: "cd2e8a869498e9cd"}, records: [
    {id: "v3-uniswapv3factory-unichain", contract: "UniswapV3Factory", chainId: 130, address: "0x1F98400000000000000000000000000000000003", status: "active"},
    {id: "v3-quoterv2-unichain", contract: "QuoterV2", chainId: 130, address: "0x385A5cf5F83e99f7BB2852b6A19C3538b9FA7658", status},
  ]});
  const srv = await serve(() => ({error: {code: -32601, message: "unused"}}), {"/deployments.json": feed});
  const pins = {from: "dist/index.js", export: "UNISWAP_V3", group: "$key", roles: {factory: "UniswapV3Factory", quoter: "QuoterV2"}};
  const root = sandbox({uni: {module: "@anywalletkit/uni", sources: [
    {id: "deployments-status", type: "json-pins", url: `${srv.url}/deployments.json`, format: "uniswap-deployments", pins, status: "active", label: "Uniswap deployments.json"},
    {id: "escape", type: "json-pins", url: `${srv.url}/deployments.json`, format: "uniswap-deployments", pins: {...pins, from: "../../scripts/watch/pins.mjs"}, label: "Escape"},
    {id: "no-format", type: "json-pins", url: `${srv.url}/deployments.json`, format: "constructor", pins, label: "Bad format"},
  ]}}, {"packages/uni/dist/index.js": `export const UNISWAP_V3 = {130: {factory: "0x1F98400000000000000000000000000000000003", quoter: "0x385A5cf5F83e99f7BB2852b6A19C3538b9FA7658", weth: "0x4200000000000000000000000000000000000006"}};\n`});
  // The source used to be an http-text hash: a different fetcher's value, not an upstream change.
  writeState(root, "uni", {"deployments-status": {type: "http-text", value: "ab".repeat(32), meta: {hash: "abababababababab", chars: 3286}}});
  try {
    let r = await run(root, srv.url);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /baseline uni · deployments-status: the source type changed/);
    assert.match(r.out, /Escape: \.\.\/\.\.\/scripts\/watch\/pins\.mjs is outside uni/);
    assert.match(r.out, /Bad format: unknown pins format constructor/);
    assert.match(r.out, /0 changed, 2 unreachable/);
    assert.deepEqual(readState(root, "uni")["deployments-status"].meta.problems, []);

    status = "deprecated";
    r = await run(root, srv.url);
    assert.match(r.out, /\*\*Uniswap deployments\.json\*\* \(json-pins\): 130 quoter: 0x385a5cf5… QuoterV2 active → 0x385a5cf5… QuoterV2 deprecated; 1 pin check failing: 130 quoter 0x385A5cf5F83e99f7BB2852b6A19C3538b9FA7658: QuoterV2 is deprecated, not active/);

    r = await run(root, srv.url);
    assert.match(r.out, /\*\*Uniswap deployments\.json\*\* \(json-pins\): 1 pin check failing: 130 quoter/, "an unchanged failing pin is reported again");

    status = "active";
    r = await run(root, srv.url);
    assert.match(r.out, /130 quoter: 0x385a5cf5… QuoterV2 deprecated → 0x385a5cf5… QuoterV2 active/);
    assert.doesNotMatch(r.out, /pin check failing/);
  } finally { srv.close(); }
});

test("a source pointed at another address or chain is re-baselined and listed as re-pointed, not reported as changed", async () => {
  const OLD = "0x565AC8C7863D9bb16d07E809ff49Fe5cD467634C", NEW = "0x385A5cf5F83e99f7BB2852b6A19C3538b9FA7658", OTHER = "0x00000000000000000000000000000000000000c3";
  const code = {[OLD.toLowerCase()]: "0x6080aa", [NEW.toLowerCase()]: "0x6080bbbb", [OTHER]: "0x60cc"};
  const srv = await serve((method, [a]) => (method === "eth_getCode" ? {result: code[a.toLowerCase()] ?? "0x"} : {error: {code: -32601, message: "method not found"}}));
  const quoter = {id: "quoter", type: "evm-code", chainId: 1, address: NEW, label: "QuoterV2"};
  const legacy = {id: "legacy", type: "evm-code", chainId: 1, address: OTHER, label: "Legacy entry"};
  const same = {id: "same", type: "evm-code", chainId: 1, address: OLD, label: "Same contract"};
  const root = sandbox({uni: {module: "@anywalletkit/uni", sources: [quoter, legacy, same]}});
  const meta = (c) => ({codeHash: sha16(c), bytes: (c.length - 2) / 2});
  writeState(root, "uni", {
    // Read from the old quoter: the stored target says so.
    quoter: {type: "evm-code", target: {chainId: 1, address: OLD.toLowerCase()}, value: sha16(code[OLD.toLowerCase()]), meta: meta(code[OLD.toLowerCase()])},
    // Written before targets were stored: compared as before, so a code change is still a change.
    legacy: {type: "evm-code", value: sha16("0x60ff"), meta: meta("0x60ff")},
    // Checksummed in the manifest, lowercase in the state: the same contract, not a re-point.
    same: {type: "evm-code", target: {chainId: 1, address: OLD.toLowerCase()}, value: sha16(code[OLD.toLowerCase()]), meta: meta(code[OLD.toLowerCase()])},
  });
  try {
    let r = await run(root, srv.url);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /1 changed, 0 unreachable, 1 re-pointed\./);
    assert.match(r.out, /## Re-pointed \(new baseline, not a change\)\n- uni · QuoterV2: chain 1 0x565ac8c7863d9bb16d07e809ff49fe5cd467634c → chain 1 0x385a5cf5f83e99f7bb2852b6a19c3538b9fa7658/);
    assert.doesNotMatch(r.out, /\*\*QuoterV2\*\*/, "the new contract's code is not reported as a code change");
    assert.match(r.out, /\*\*Legacy entry\*\* \(evm-code\)/);
    assert.doesNotMatch(r.out, /Same contract/);
    assert.match(r.err, /baseline uni · quoter: source re-pointed chain 1 0x565ac8c7/);
    const st = readState(root, "uni");
    assert.deepEqual(st.quoter.target, {chainId: 1, address: NEW.toLowerCase()});
    assert.equal(st.quoter.value, sha16(code[NEW.toLowerCase()]));
    assert.deepEqual(st.legacy.target, {chainId: 1, address: OTHER}, "a legacy entry gets its target stored");
    const diff = JSON.parse(readFileSync(join(root, "watch/diff", `${new Date().toISOString().slice(0, 10)}.json`), "utf8"));
    assert.deepEqual(diff.repointed.map((p) => p.id), ["quoter"]);
    assert.deepEqual(diff.changes.map((c) => c.id), ["legacy"]);

    // From the new baseline on, a code change at the new address is reported as usual.
    code[NEW.toLowerCase()] = "0x6080dd";
    r = await run(root, srv.url);
    assert.match(r.out, /\*\*QuoterV2\*\* \(evm-code\): code /);
    assert.match(r.out, /1 changed, 0 unreachable\./);

    // Another chain for the same address is a re-point too.
    writeFileSync(join(root, "packages/uni/watch.json"), JSON.stringify({module: "@anywalletkit/uni", sources: [{...quoter, chainId: 130}, legacy, same]}));
    code[NEW.toLowerCase()] = "0x6080ee";
    r = await run(root, srv.url, {UNICHAIN_RPC_URL: srv.url});
    assert.match(r.out, /0 changed, 0 unreachable, 1 re-pointed\./);
    assert.match(r.out, /- uni · QuoterV2: chain 1 0x385a5cf5f83e99f7bb2852b6a19c3538b9fa7658 → chain 130 0x385a5cf5f83e99f7bb2852b6a19c3538b9fa7658/);
    assert.deepEqual(readState(root, "uni").quoter.target, {chainId: 130, address: NEW.toLowerCase()});
  } finally { srv.close(); }
});
