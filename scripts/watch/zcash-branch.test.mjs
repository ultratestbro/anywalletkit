// node --test scripts/watch/zcash-branch.test.mjs — NU7 (2026-11-06): the watch must flag a branch id the module does not sign under.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {checkBranch, headerBranchId} from "./zcash-branch.mjs";

const fixtures = new URL("../../packages/wallet-zcash/test/fixtures/", import.meta.url);
const raw = (h) => JSON.parse(readFileSync(new URL(`raw-${h}.json`, fixtures), "utf8")).data[h].raw_transaction;
const NU7_TX = "c8a04d6c76b0f4a29e2887ea8eb0988f8209571376fe9371f59a791e00227a17"; // block 3 545 600
const UPGRADES = [{name: "NU6.3", height: 3_428_143, branchId: 0x37a5165b}, {name: "NU7", height: 3_543_405, branchId: 0x77190ad9}];
const table = (upgrades) => ({MAINNET_UPGRADES: upgrades, branchIdForHeight: (h) => upgrades.filter((u) => h >= u.height).at(-1).branchId});

test("headerBranchId reads v5 headers and skips v4", () => {
  assert.deepEqual(headerBranchId(raw(NU7_TX)), {version: 5, branchId: 0x77190ad9});
  assert.equal(headerBranchId("0400008085202f89" + "00".repeat(16)), null);
  assert.throws(() => headerBranchId("zz"), /not a raw transaction/);
});

test("a table that knows NU7 passes; the pre-NU7 table is flagged", () => {
  assert.deepEqual(checkBranch({height: 3_545_600, txid: NU7_TX, raw: raw(NU7_TX)}, table(UPGRADES)).problems, []);
  const stale = checkBranch({height: 3_545_600, txid: NU7_TX, raw: raw(NU7_TX)}, table(UPGRADES.slice(0, 1)));
  assert.equal(stale.problems.length, 1);
  assert.match(stale.problems[0], /0x77190ad9 \(not in the table\).*0x37a5165b \(NU6\.3\)/);
});

test("the built wallet-zcash table matches the mined NU7 transaction", async () => {
  const mod = await import(new URL("../../packages/wallet-zcash/dist/index.js", import.meta.url));
  assert.deepEqual(checkBranch({height: 3_545_600, txid: NU7_TX, raw: raw(NU7_TX)}, mod).problems, []);
});
