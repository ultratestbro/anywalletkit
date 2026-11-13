// node --test scripts/watch/watch-2026-11-12-usdt0-mesh.test.mjs — CS-11: protocol-swap2-usdt0 sends USDT into Tron and TON
// through the USDT0 Legacy Mesh. What the module pins is read from its own source (src/mesh.ts), so a new mesh source or
// destination without a watch entry fails here:
//   - every EVM mesh OFT: `evm-code` (it is not a proxy, a new deployment is a new address), `peers(eid)` for each
//     destination eid (an `evm-call` decoded as bytes32: a migrated Tron / TON OFT is re-peered there first) and `feeBps()`;
//   - the TON OFT: `ton-code`;
//   - the official list (docs.usdt0.to/api/deployments, `usdt0.legacyMesh`) hashed whole, not by item names (an address
//     change inside an item must be a diff);
//   - the two APIs the provider calls at runtime: LayerZero Scan `GET /v1/messages/tx/{tx}` and tonapi `GET /v2/events/{id}`.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const manifest = JSON.parse(read("packages/protocol-swap2-usdt0/watch.json"));
const mesh = read("packages/protocol-swap2-usdt0/src/mesh.ts");

/** The table literal `name` in mesh.ts (from its declaration to the closing `});`). */
const table = (name) => {
  const at = mesh.indexOf(`export const ${name}`);
  assert.ok(at >= 0, `${name} in mesh.ts`);
  return mesh.slice(at, mesh.indexOf("\n});", at));
};
const sources = [...table("USDT0_MESH_SOURCES").matchAll(/chainId: (\d+), eid: (\d+),[^\n]*?oft: "(0x[0-9a-fA-F]{40})"/g)]
  .map((m) => ({chainId: Number(m[1]), eid: Number(m[2]), oft: m[3]}));
const destinations = [...table("USDT0_MESH_DESTINATIONS").matchAll(/family: "(tron|ton)" as const, eid: (\d+), name: "[^"]+", oft: "([^"]+)"/g)]
  .map((m) => ({family: m[1], eid: Number(m[2]), oft: m[3]}));

test("usdt0 mesh: the pins parse (3 EVM sources, Tron + TON)", () => {
  assert.deepEqual(sources.map((s) => s.chainId), [1, 42161, 42220]);
  assert.deepEqual(destinations.map((d) => [d.family, d.eid]), [["tron", 30420], ["ton", 30343]]);
});

test("usdt0 mesh: every EVM mesh OFT is watched by code, by its peer for each destination and by its fee", () => {
  for (const s of sources) {
    const at = (type) => manifest.sources.filter((x) => x.type === type && x.chainId === s.chainId && (x.address ?? x.to)?.toLowerCase() === s.oft.toLowerCase());
    assert.equal(at("evm-code").length, 1, `evm-code ${s.chainId} ${s.oft}`);
    const calls = at("evm-call");
    for (const d of destinations) {
      const peer = calls.filter((x) => x.signature === "peers(uint32)" && x.args?.length === 1 && x.args[0] === d.eid);
      assert.equal(peer.length, 1, `peers(${d.eid}) on ${s.chainId}`);
      assert.equal(peer[0].decode, "bytes32");
    }
    assert.equal(calls.filter((x) => x.signature === "feeBps()").length, 1, `feeBps() on ${s.chainId}`);
  }
  // Nothing watched that the module does not pin.
  const pinned = new Set(sources.map((s) => `${s.chainId} ${s.oft.toLowerCase()}`));
  for (const x of manifest.sources.filter((x) => x.type === "evm-code" || x.type === "evm-call")) {
    assert.ok(pinned.has(`${x.chainId} ${(x.address ?? x.to).toLowerCase()}`), `${x.id} reads a contract the module does not pin`);
  }
});

test("usdt0 mesh: the TON OFT's code, the official list and the runtime APIs are watched", () => {
  const ton = destinations.find((d) => d.family === "ton");
  assert.equal(manifest.sources.filter((x) => x.type === "ton-code" && x.address === ton.oft).length, 1);
  const list = manifest.sources.find((x) => x.type === "http-json" && x.url === "https://docs.usdt0.to/api/deployments" && x.path === "usdt0.legacyMesh");
  assert.ok(list, "docs deployments API, Legacy Mesh list");
  assert.equal(list.itemKey, undefined, "hashed whole: an address change inside an item is a diff");
  const provider = read("packages/protocol-swap2-usdt0/src/provider.ts");
  const config = read("packages/protocol-swap2-usdt0/src/config.ts");
  assert.match(config, /LZ_SCAN_API = "https:\/\/scan\.layerzero-api\.com"/);
  assert.match(provider, /TON_API = "https:\/\/tonapi\.io"/);
  assert.ok(manifest.sources.some((x) => x.type === "http-json" && x.url.startsWith("https://scan.layerzero-api.com/") && x.path === "paths./messages/tx/{tx}"));
  assert.ok(manifest.sources.some((x) => x.type === "http-json" && x.url.startsWith("https://tonapi.io/") && x.path === "paths./v2/events/{event_id}"));
  assert.equal(new Set(manifest.sources.map((x) => x.id)).size, manifest.sources.length, "unique ids");
});
