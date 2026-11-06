// node --test scripts/watch/watch-2026-11-07-zcash-branch.test.mjs — NU7 (block 3 543 405, 2026-11-06) moved the Zcash
// consensus branch id and wallet-zcash kept signing under NU6.3's, so every send was refused. End to end through watch.mjs:
// a `zcash-branch` source reads a mined transaction's header two to five blocks below the tip; a module table that does not know
// the id is reported on every run until fixed; v4 transactions are skipped. Same sandbox as watch-2026-11-04-sources.
import {test} from "node:test";
import assert from "node:assert/strict";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const NU7_TX = "c8a04d6c76b0f4a29e2887ea8eb0988f8209571376fe9371f59a791e00227a17";
const RAW = JSON.parse(readFileSync(join(here, "../../packages/wallet-zcash/test/fixtures", `raw-${NU7_TX}.json`), "utf8")).data[NU7_TX].raw_transaction;
const V4 = "0400008085202f89" + "00".repeat(40);
const table = (rows) => `export const MAINNET_UPGRADES = ${JSON.stringify(rows)};\nexport function branchIdForHeight(h) { let id = MAINNET_UPGRADES[0].branchId; for (const u of MAINNET_UPGRADES) if (h >= u.height) id = u.branchId; return id; }\n`;
const NU63 = {name: "NU6.3", height: 3_428_143, branchId: 0x37a5165b}, NU7 = {name: "NU7", height: 3_543_405, branchId: 0x77190ad9};

async function blockchair() {
  const tip = 3_545_602; // the source reads tip - 2 = 3 545 600: a v4 transaction first, then the NU7 one
  const pages = {
    "/zcash/stats": {data: {best_block_height: tip}},
    "/zcash/dashboards/block/3545600": {data: {3545600: {transactions: ["44".repeat(32), NU7_TX]}}},
    [`/zcash/raw/transaction/${"44".repeat(32)}`]: {data: {["44".repeat(32)]: {raw_transaction: V4}}},
    [`/zcash/raw/transaction/${NU7_TX}`]: {data: {[NU7_TX]: {raw_transaction: RAW}}},
  };
  const server = createServer((req, res) => { const p = pages[req.url]; res.statusCode = p ? 200 : 404; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(p ?? {})); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {url: `http://127.0.0.1:${server.address().port}/zcash`, close: () => server.close()};
}

async function run(root) {
  const child = spawn(process.execPath, [join(root, "scripts/watch/watch.mjs")], {env: {PATH: process.env.PATH, GITHUB_TOKEN: "x"}, stdio: ["ignore", "pipe", "pipe"]});
  let out = "", err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const code = await new Promise((r) => child.on("close", r));
  return {code, out, err};
}

test("zcash-branch: a table without NU7 is reported on every run until fixed; a fixed table clears it", async () => {
  const srv = await blockchair();
  const root = mkdtempSync(join(tmpdir(), "watch-1107-"));
  mkdirSync(join(root, "scripts/watch"), {recursive: true});
  for (const f of ["watch.mjs", "html-text.mjs", "pins.mjs", "zcash-branch.mjs"]) copyFileSync(join(here, f), join(root, "scripts/watch", f));
  mkdirSync(join(root, "packages/zec/dist"), {recursive: true});
  writeFileSync(join(root, "packages/zec/watch.json"), JSON.stringify({module: "@anywalletkit/zec", sources: [{id: "branch-id", type: "zcash-branch", from: "dist/index.js", url: srv.url, label: "Zcash branch id"}]}));
  const dist = join(root, "packages/zec/dist/index.js");
  try {
    writeFileSync(dist, table([NU63]));
    let r = await run(root);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\*\*Zcash branch id\*\* \(zcash-branch\): 1 branch check failing: block 3545600 signs under 0x77190ad9 \(not in the table\), the module under 0x37a5165b \(NU6\.3\)/);
    r = await run(root);
    assert.match(r.out, /1 branch check failing/, "an unchanged mismatch is reported again");

    writeFileSync(dist, table([NU63, NU7]));
    r = await run(root);
    assert.match(r.out, /branch id 0x77190ad9 \(not in the table\) → 0x77190ad9 \(NU7\) at block 3545600; the module signs under 0x77190ad9 \(NU7\)/);
    assert.doesNotMatch(r.out, /branch check failing/);
    r = await run(root);
    assert.match(r.out, /0 changed, 0 unreachable/);
  } finally { srv.close(); }
});
