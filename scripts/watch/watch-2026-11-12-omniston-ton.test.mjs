// node --test scripts/watch/watch-2026-11-12-omniston-ton.test.mjs — SDK-306: Omniston moved TON <-> EVM orders to a new TON
// Escrow Minter on 2026-11-10 and only the routes canary noticed (every corridor stopped quoting). Each TON minter the
// module trusts is now watched on its own, read from the module's source so a new minter without a watch entry fails here:
//   - `ton-code`: its code (an executed upgrade);
//   - `http-json` on its data (tonapi, path `data`): admin, pending admin, pending code, upgrade time and the position code
//     it deploys. The data has not changed since deploy, so any change is news — a pending upgrade shows up when it is
//     scheduled, 7 days before it can run.
// The watch follows the trust table both ways: a minter that leaves the table (rev1 EQAbWJ3Y… on 2026-11-12) leaves the
// watch too. The routes canary's mirror of the TON table (watch/routes.json) must list the same minters.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const TON_ACCOUNT_DATA = /^https:\/\/tonapi\.io\/v2\/blockchain\/accounts\/([EU]Q[A-Za-z0-9_-]{46})$/;

function trustedTonMinters() {
  const source = read("packages/protocol-swap2-omniston/src/validators/settlement.ts");
  const entry = /^\s*"ton:-239": \[([^\]]*)\],$/m.exec(source)?.[1];
  assert.ok(entry, "settlement.ts has a one-line ton:-239 entry");
  const addresses = [...entry.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(addresses.length >= 1, `${addresses.length} TON minters`);
  for (const a of addresses) assert.match(a, /^[EU]Q[A-Za-z0-9_-]{46}$/, a);
  return addresses;
}

test("Omniston: every trusted TON Escrow Minter is watched by code and by data", () => {
  const sources = JSON.parse(read("packages/protocol-swap2-omniston/watch.json")).sources;
  for (const address of trustedTonMinters()) {
    assert.equal(sources.filter((s) => s.type === "ton-code" && s.address === address).length, 1, `ton-code ${address}`);
    const data = sources.filter((s) => s.type === "http-json" && s.url === `https://tonapi.io/v2/blockchain/accounts/${address}`);
    assert.equal(data.length, 1, `http-json data ${address}`);
    assert.equal(data[0].path, "data", `${address}: the data cell only, not the whole account (balance and last tx change every block)`);
  }
});

test("Omniston: the watch reads no TON minter the module does not trust", () => {
  const sources = JSON.parse(read("packages/protocol-swap2-omniston/watch.json")).sources;
  const watched = new Set([
    ...sources.filter((s) => s.type === "ton-code").map((s) => s.address),
    ...sources.filter((s) => s.type === "http-json").map((s) => TON_ACCOUNT_DATA.exec(s.url)?.[1]).filter(Boolean),
  ]);
  assert.deepEqual([...watched].sort(), [...trustedTonMinters()].sort());
});

test("Omniston: the routes canary trusts the same TON minters as the module", () => {
  const routes = JSON.parse(read("watch/routes.json"));
  assert.deepEqual(routes.omniston.trustedSettlementContracts["ton:-239"], trustedTonMinters());
});
