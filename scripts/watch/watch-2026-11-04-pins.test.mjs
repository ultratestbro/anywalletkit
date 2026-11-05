// node --test scripts/watch/watch-2026-11-04-pins.test.mjs — watch triage 2026-11-04: the pure helpers behind the
// `json-pins` and `evm-selectors` sources (scripts/watch/pins.mjs), and the real pins they read from the built packages.
import {test} from "node:test";
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {RECORD_FORMATS, checkPins, decodeFacets, normGroup, pinsFromModule, selectorsFromSource} from "./pins.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../..");
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const sel = (s) => s.slice(2).padEnd(64, "0");

/** ABI encoding of DiamondLoupe facets() → (address facet, bytes4[] selectors)[]. */
function encodeFacets(facets) {
  const tuples = facets.map(([addr, sels]) => word(BigInt(addr)) + word(64) + word(sels.length) + sels.map(sel).join(""));
  let off = facets.length * 32;
  const heads = tuples.map((t) => { const h = word(off); off += t.length / 2; return h; });
  return "0x" + word(32) + word(facets.length) + heads.join("") + tuples.join("");
}

test("decodeFacets reads every facet's selectors", () => {
  const a = "0x1221db54f6faf9b26c23dbe54aa48f0b0a6a5600", b = "0x00000000000000000000000000000000000000b2";
  const m = decodeFacets(encodeFacets([[a, ["0x05c54990", "0x8352664c"]], [b, ["0x4666fc80"]]]));
  assert.deepEqual([...m], [["0x05c54990", a], ["0x8352664c", a], ["0x4666fc80", b]]);
  assert.equal(decodeFacets(encodeFacets([])).size, 0);
});

test("decodeFacets refuses malformed answers instead of returning a partial map", () => {
  const good = encodeFacets([["0x00000000000000000000000000000000000000a1", ["0x05c54990"]]]);
  assert.throws(() => decodeFacets("0x"), /not ABI words/);
  assert.throws(() => decodeFacets(good.slice(0, -64)), /out of range/);                       // truncated
  assert.throws(() => decodeFacets("0x" + word(33) + good.slice(66)), /bad offset/);           // misaligned head
  assert.throws(() => decodeFacets("0x" + word(32) + word(1) + word(1n << 40n)), /bad offset/); // offset past the end
  assert.throws(() => decodeFacets(good.replace(sel("0x05c54990"), "05c54990" + "1".padStart(56, "0"))), /not bytes4/);
  assert.throws(() => decodeFacets("0x" + word(32) + word(5000)), /too many facets/);
});

test("selectorsFromSource takes the keys of the named constants with the commented function name; a missing one throws", () => {
  const src = `const GENERIC_SWAPS: Readonly<Record<string, X>> = {\n  "0x4666FC80": {single: true}, // swapTokensSingleV3ERC20ToERC20\n};\n` +
    `const BRIDGE_CALLS: Readonly<Record<string, Y>> = {\n  "0x05c54990": {sourceSwaps: false, facet: "Eco"}, // startBridgeTokensViaEco (EcoFacet)\n  "0x8352664c": {sourceSwaps: true, facet: "Eco"},\n};\n` +
    `const UNBOUND_BRIDGES = {\n  "0x092e8fa4": "Relay",\n};\n`;
  assert.deepEqual(selectorsFromSource(src, ["BRIDGE_CALLS", "GENERIC_SWAPS"]), {"0x05c54990": "startBridgeTokensViaEco", "0x4666fc80": "swapTokensSingleV3ERC20ToERC20", "0x8352664c": ""});
  assert.throws(() => selectorsFromSource(src, ["BRIDGE_CALLS", "SAME_CHAIN"]), /const SAME_CHAIN not found/);
  assert.throws(() => selectorsFromSource("const BRIDGE_CALLS = {\n};\n", ["BRIDGE_CALLS"]), /lists no selectors/);
});

test("checkPins: listed + right name + status passes; deprecated, renamed, missing and other-chain pins are problems", () => {
  const records = RECORD_FORMATS["uniswap-deployments"](JSON.stringify({generatedAt: "2026-10-16T21:00:00.000Z", source: {commit: "cd2e8a869498e9cd"}, records: [
    {id: "v3-quoterv2-unichain", contract: "QuoterV2", chainId: 130, address: "0x385A5cf5F83e99f7BB2852b6A19C3538b9FA7658", status: "active"},
    {id: "v3-quoter-unichain", contract: "Quoter", chainId: 130, address: "0x565AC8C7863D9bb16d07E809ff49Fe5cD467634C", status: "deprecated"},
    {id: "v3-swaprouter02-unichain", contract: "SwapRouter02", chainId: 130, address: "0x73855d06DE49d0fe4A9c42636Ba96c62da12FF9C", status: "deprecated"},
    {id: "v3-uniswapv3factory-ethereum", contract: "UniswapV3Factory", chainId: 1, address: "0x1F98431c8aD98523631AE4a59f267346ea31F984", status: "active"},
  ]}));
  assert.deepEqual(records.info, {generatedAt: "2026-10-16T21:00:00.000Z", commit: "cd2e8a869498"});
  const pins = pinsFromModule({PINS: {
    130: {quoter: "0x385a5cf5f83e99f7bb2852b6a19c3538b9fa7658", router: "0x73855d06DE49d0fe4A9c42636Ba96c62da12FF9C", factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984"},
    143: {quoter: "0x565AC8C7863D9bb16d07E809ff49Fe5cD467634C"},
  }}, {export: "PINS", group: "$key", roles: {factory: "UniswapV3Factory", quoter: "QuoterV2", router: "SwapRouter02"}});
  const {rows, problems} = checkPins(records.records, pins, "active");
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.find((r) => r.group === "130" && r.role === "quoter"), {group: "130", role: "quoter", address: "0x385a5cf5f83e99f7bb2852b6a19c3538b9fa7658", contract: "QuoterV2", status: "active", id: "v3-quoterv2-unichain"});
  assert.deepEqual(problems, [
    "130 factory 0x1F98431c8aD98523631AE4a59f267346ea31F984: not listed", // the address is listed on chain 1 only
    "130 router 0x73855d06DE49d0fe4A9c42636Ba96c62da12FF9C: SwapRouter02 is deprecated, not active",
    "143 quoter 0x565AC8C7863D9bb16d07E809ff49Fe5cD467634C: not listed",
  ]);
  const renamed = checkPins(records.records, [{group: "130", role: "quoter", contract: "QuoterV2", address: "0x565AC8C7863D9bb16d07E809ff49Fe5cD467634C"}], "active");
  assert.deepEqual(renamed.problems, ["130 quoter 0x565AC8C7863D9bb16d07E809ff49Fe5cD467634C: listed as Quoter (deprecated), not QuoterV2"]);
});

test("pinsFromModule refuses a missing export, a non-address pin and an empty pin set", () => {
  const desc = {export: "PINS", group: "$key", roles: {quoter: "QuoterV2"}};
  assert.throws(() => pinsFromModule({}, desc), /PINS is not exported/);
  assert.throws(() => pinsFromModule({PINS: {1: {quoter: "0x12"}}}, desc), /1\.quoter is not an address/);
  assert.throws(() => pinsFromModule({PINS: {1: {}}}, desc), /yields no pins/);
  assert.throws(() => pinsFromModule({list: () => [{quoter: "0x385a5cf5f83e99f7bb2852b6a19c3538b9fa7658"}]}, {...desc, export: "list", call: true, group: "name"}), /has no name/);
});

test("aave-docs-markets reads the market tables out of the escaped page payload, matched by market name", () => {
  const market = (id, rows) => JSON.stringify({id, name: id, chainIcon: "x", version: id.startsWith("AaveV3") ? "Aave V3" : "Aave V4",
    sections: [{title: "Contracts", columnTitles: ["Address"], rows: rows.map(([name, address]) => ({name, cells: [{address, explorerUrl: `https://x/${address}`}]}))}]});
  const payload = `[${market("AaveV4Ethereum", [["Hub", "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9"]])},${market("AaveV3InkWhitelabel", [["Pool", "0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA"]])}]`;
  const html = `<main>V4 tab</main><script>self.__next_f.push([1,"${payload.replace(/"/g, '\\"')}"])</script>`;
  const {records, info} = RECORD_FORMATS["aave-docs-markets"](html);
  assert.equal(info.markets, 2);
  const {problems} = checkPins(records, [
    {group: "Aave V3 Ink (whitelabel)", role: "pool", contract: "Pool", address: "0x2816CF15F6D2A220E789AA011D5EE4EB6C47FEBA"},
    {group: "Aave V3 Ink (whitelabel)", role: "dataProvider", contract: "AaveProtocolDataProvider", address: "0x96086C25d13943C80Ff9a19791a40Df6aFC08328"},
  ]);
  assert.deepEqual(problems, ["Aave V3 Ink (whitelabel) dataProvider 0x96086C25d13943C80Ff9a19791a40Df6aFC08328: not listed"]);
  assert.equal(normGroup("Aave V3 Ink (whitelabel)"), normGroup("AaveV3InkWhitelabel"));
  assert.throws(() => RECORD_FORMATS["aave-docs-markets"]("<main>nothing here</main>"), /no market tables/);
});

// Curve prep 2026-11-05: docs.curve.finance/deployments.json, trimmed to the shape it had that day (Ethereum carries two
// routers and the scrvUSD vault, the lite chains carry one router, chains outside the SDK keep their key as the group).
const CURVE_FEED = {
  _instructions: "This is the source of truth for deployment data in this checkout.",
  _explorers: {ethereum: "https://etherscan.io/address/"},
  ethereum: {
    tokens: {crv: "0xD533a949740bb3306d119CC777fa900bA034cd52", vecrv: "0x5f3b5dfeb7b28cdbd7faba78963ee202a494e2a2", crvUSD: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E", scrvUSD: "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367"},
    integrations: {"address-provider": "0x5ffe7FB82894076ECB99A30D6A32e969e6e35E98", "meta-registry": "0xF98B45FA17DE75FB1aD0e7aFD971b0ca00e379fC", "rate-provider": "0xA834f3d23749233c9B61ba723588570A1cCA0Ed7"},
    amm: {
      stableswap: {factory: "0x6A8cbed756804B16E05E741eDaBd5cB544AE21bf", "plain-amm-implementation": "0xDCc91f930b42619377C200BA05b7513f2958b202"},
      twocrypto: {factory: "0x98EE851a00abeE0d95D08cF4CA2BdCE32aeaAF7F"},
      tricrypto: {factory: "0x0c0e5f2ff0ff18a3be9b835635039256dc4b4963"},
      "router & zap": {"router-v1": "0x16C6521Dff6baB339122a0FE25a9116693265353", "router-v2": "0x45312ea0eFf7E09C83CBE249fa1d7598c4C8cd4e", "stable-calc-zap": "0xCA8d0747B5573D69653C3aC22242e6341C36e4b4"},
    },
    scrvusd: {vault: "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367", "rewards-handler": "0xe8d1e2531761406af1615a6764b0d5ff52736f56"},
  },
  monad: {tokens: {}, integrations: {"address-provider": "0x4574921eb950d3Fd5B01562162EC566Cb8bc3648"}, amm: {"router & zap": {router: "0xFF5Cb29241F002fFeD2eAa224e3e996D24A6E8d1", "meta-zap-ng": "0x2AF43209B366A4491CCe0A97C5a7B6059fd21295"}}},
  arc: {tokens: {}, amm: {"router & zap": {router: "0xFF5Cb29241F002fFeD2eAa224e3e996D24A6E8d1", "stable-calc-zap": ""}}},
  fraxtal: {tokens: {crvUSD: "0xB102f7Efa0d5dE071A8D37B3548e1C7CB148Caf3"}, amm: {"router & zap": {router: "0x56C526b0159a258887e0d79ec3a80dfb940d0cD7"}}},
  _addressOrigins: {"x-gov.l1-broadcaster": "ethereum"},
};

test("curve-deployments: routers, registries, factories, crvUSD / scrvUSD / CRV and the scrvUSD vault, grouped by chain id", () => {
  const {records, info} = RECORD_FORMATS["curve-deployments"](JSON.stringify(CURVE_FEED));
  assert.deepEqual(info, {chains: 4});
  assert.deepEqual(records.filter((r) => r.group === "1").map((r) => `${r.id} ${r.contract}`), [
    "ethereum.router-v1 router", "ethereum.router-v2 router", "ethereum.address-provider address-provider", "ethereum.meta-registry meta-registry",
    "ethereum.stableswap.factory stableswap-factory", "ethereum.twocrypto.factory twocrypto-factory", "ethereum.tricrypto.factory tricrypto-factory",
    "ethereum.tokens.CRV CRV", "ethereum.tokens.crvUSD crvUSD", "ethereum.tokens.scrvUSD scrvUSD", "ethereum.scrvusd.vault scrvUSD vault",
  ]);
  assert.ok(!records.some((r) => /vecrv|rate-provider|calc-zap|meta-zap|rewards|implementation/.test(r.id)), "only what a Curve module pins");
  assert.deepEqual(records.filter((r) => r.contract === "router").map((r) => `${r.group} ${r.id}`), ["1 ethereum.router-v1", "1 ethereum.router-v2", "143 monad.router", "5042 arc.router", "fraxtal fraxtal.router"]);

  // A module's pins keyed by chain id: Router NG v1.2 on Ethereum is listed (as router-v2), the scrvUSD vault and token too;
  // the same router address pinned on a chain the feed does not list it for, or under another role, is a problem.
  const pins = pinsFromModule({CURVE_DEPLOYMENTS: {
    1: {router: "0x45312ea0eFf7E09C83CBE249fa1d7598c4C8cd4e", addressProvider: "0x5ffe7FB82894076ECB99A30D6A32e969e6e35E98", scrvUsd: "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367", crvUsd: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E"},
    143: {router: "0xFF5Cb29241F002fFeD2eAa224e3e996D24A6E8d1", addressProvider: "0x4574921eb950d3Fd5B01562162EC566Cb8bc3648"},
    9745: {router: "0xFF5Cb29241F002fFeD2eAa224e3e996D24A6E8d1"},
    5042: {router: "0xFF5Cb29241F002fFeD2eAa224e3e996D24A6E8d1", addressProvider: "0x2AF43209B366A4491CCe0A97C5a7B6059fd21295"},
  }}, {export: "CURVE_DEPLOYMENTS", group: "$key", roles: {router: "router", addressProvider: "address-provider", scrvUsd: "scrvUSD vault", crvUsd: "crvUSD"}});
  const {rows, problems} = checkPins(records, pins);
  assert.deepEqual(rows.find((r) => r.group === "1" && r.role === "router"), {group: "1", role: "router", address: "0x45312ea0eff7e09c83cbe249fa1d7598c4c8cd4e", contract: "router", id: "ethereum.router-v2"});
  assert.equal(rows.find((r) => r.group === "1" && r.role === "scrvUsd").id, "ethereum.scrvusd.vault");
  assert.deepEqual(problems, [
    "5042 addressProvider 0x2AF43209B366A4491CCe0A97C5a7B6059fd21295: not listed",
    "9745 router 0xFF5Cb29241F002fFeD2eAa224e3e996D24A6E8d1: not listed", // Plasma is not in this trimmed feed
  ]);

  assert.throws(() => RECORD_FORMATS["curve-deployments"]("[]"), /not a deployments object/);
  assert.throws(() => RECORD_FORMATS["curve-deployments"](JSON.stringify({_instructions: "x", ethereum: {tokens: {}}})), /no routers/);
  assert.throws(() => RECORD_FORMATS["curve-deployments"]("<html>"), SyntaxError);
});

// The real pins the two json-pins sources read (needs `pnpm build`, as the watch job runs it first). Skipped on a
// local checkout that was never built; in CI (ci.yml runs this after `pnpm build`) a missing dist fails the test.
const uniDist = join(ROOT, "packages/protocol-swap2-uniswap/dist/index.js");
const aaveDist = join(ROOT, "packages/protocol-lending-aave-evm/dist/index.js");
const missingDist = [uniDist, aaveDist].filter((f) => !existsSync(f));
test("the Uniswap and Aave manifests yield every pinned address from the built packages", {skip: missingDist.length && !process.env.CI ? "run pnpm build first" : false}, async () => {
  assert.deepEqual(missingDist, [], "pnpm build must run before the watch tests");
  const {createRequire} = await import("node:module");
  const req = createRequire(import.meta.url);
  const uni = req(join(ROOT, "packages/protocol-swap2-uniswap/watch.json")).sources.find((s) => s.type === "json-pins");
  const aave = req(join(ROOT, "packages/protocol-lending-aave-evm/watch.json")).sources.find((s) => s.type === "json-pins");
  const uniMod = await import(pathToFileURL(uniDist).href), aaveMod = await import(pathToFileURL(aaveDist).href);
  const uniPins = pinsFromModule(uniMod, uni.pins);
  assert.equal(uniPins.length, Object.keys(uniMod.UNISWAP_V3).length * 3);
  const aavePins = pinsFromModule(aaveMod, aave.pins);
  const markets = aaveMod.listMarkets();
  assert.equal(aavePins.length, markets.length * 3 + markets.filter((m) => m.wethGateway).length);
  assert.equal(new Set(markets.map((m) => normGroup(m.name))).size, markets.length, "market names stay distinct after normalising");
});
