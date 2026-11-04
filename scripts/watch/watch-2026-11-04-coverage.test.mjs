// node --test scripts/watch/watch-2026-11-04-coverage.test.mjs — watch triage 2026-11-04: the manifests cover what the
// modules pin, read from the modules' own sources, so a new chain or Diamond in the code without a watch entry fails here.
//   - protocol-swap2-lifi: one evm-selectors source per EVM chain in LIFI_CHAIN, at the Diamond diamondFor() trusts there
//     (LIFI_DIAMONDS, else LIFI_DIAMOND), reading BRIDGE_CALLS + GENERIC_SWAPS from src/calldata.ts;
//   - protocol-lending-morpho-evm: every Morpho / Vault V1 / Vault V2 factory address in src/chains.ts.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {addressMapFromSource, keysFromSource, selectorsFromSource} from "./pins.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const manifest = (pkg) => JSON.parse(read(`packages/${pkg}/watch.json`));

test("LI.FI: an evm-selectors source for every EVM chain the provider routes, at the Diamond it trusts there", () => {
  const provider = read("packages/protocol-swap2-lifi/src/provider.ts");
  const canonical = /const LIFI_DIAMOND = "(0x[0-9a-fA-F]{40})"/.exec(provider)?.[1]?.toLowerCase();
  assert.ok(canonical, "LIFI_DIAMOND is a literal address");
  const diamonds = addressMapFromSource(provider, "LIFI_DIAMONDS");
  const expected = keysFromSource(provider, "LIFI_CHAIN").filter((c) => c.startsWith("eip155:"))
    .map((c) => `${c.slice(7)} ${diamonds[c] ?? canonical}`).sort();
  assert.ok(expected.length >= 30, `${expected.length} EVM chains`);
  const sources = manifest("protocol-swap2-lifi").sources.filter((s) => s.type === "evm-selectors");
  assert.deepEqual(sources.map((s) => `${s.chainId} ${s.address.toLowerCase()}`).sort(), expected);
  for (const s of sources) assert.deepEqual(s.selectors, {file: "src/calldata.ts", consts: ["BRIDGE_CALLS", "GENERIC_SWAPS"]}, s.id);
});

test("LI.FI: the selector list read at runtime is every BRIDGE_CALLS and GENERIC_SWAPS entry", () => {
  const calldata = read("packages/protocol-swap2-lifi/src/calldata.ts");
  const got = selectorsFromSource(calldata, ["BRIDGE_CALLS", "GENERIC_SWAPS"]);
  // Counted another way: the entry shapes of the two tables ({sourceSwaps, facet} and {single, from?, to?}).
  const bridge = new Set([...calldata.matchAll(/"(0x[0-9a-f]{8})": \{sourceSwaps: (?:true|false), facet: "/g)].map((m) => m[1]));
  const generic = new Set([...calldata.matchAll(/"(0x[0-9a-f]{8})": \{single: (?:true|false)/g)].map((m) => m[1]));
  assert.ok(bridge.size > 40 && generic.size > 5, `${bridge.size} bridge, ${generic.size} generic`);
  assert.deepEqual(Object.keys(got), [...new Set([...bridge, ...generic])].sort());
  assert.ok(Object.values(got).every((name) => /^(start|swapAndStart)BridgeTokensVia|^swapTokens/.test(name)), "every entry carries its function name");
  // The refused bridges are not watched as accepted calls.
  const refused = keysFromSource(calldata, "UNBOUND_BRIDGES");
  assert.ok(refused.length > 0);
  for (const k of refused) assert.ok(!(k in got), `${k} is refused, not watched as accepted`);
});

test("Morpho: every address src/chains.ts pins has an on-chain source on its chain", () => {
  const chains = read("packages/protocol-lending-morpho-evm/src/chains.ts");
  const body = chains.slice(chains.indexOf("MORPHO_CHAINS"), chains.indexOf("MORPHO_CHAIN_IDS"));
  const pinned = [];
  for (const m of body.matchAll(/^\s*(\d+): chain\(\d+, '[^']+', ('0x[0-9a-fA-F]{40}'),\s*\[([^\]]*)\], \[([^\]]*)\]\)/gm)) {
    for (const a of [m[2], m[3], m[4]].join(",").match(/0x[0-9a-fA-F]{40}/g) ?? []) pinned.push(`${m[1]} ${a.toLowerCase()}`);
  }
  assert.ok(pinned.length >= 34, `${pinned.length} pins parsed`);
  const watched = new Set(manifest("protocol-lending-morpho-evm").sources.filter((s) => s.type === "evm-proxy" || s.type === "evm-code").map((s) => `${s.chainId} ${s.address.toLowerCase()}`));
  assert.deepEqual(pinned.filter((p) => !watched.has(p)), []);
  assert.ok(watched.has("130 0xc9b34c108014b44e5a189a830e7e04c56704a0c9"), "Unichain VaultV2Factory (docs.morpho.org, 2026-11-04)");
});
