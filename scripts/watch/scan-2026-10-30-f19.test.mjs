// node --test scripts/watch/scan-2026-10-30-f19.test.mjs — regression for scan 2026-10-30 F19.
// An RPC whose JSON-RPC error.message is an Object.prototype key ("constructor", "__proto__", "toString") makes the
// error grouping `(g[e.error] ??= []).push(e)` hit the inherited value, so watch.mjs throws a TypeError before the
// digest is written / sent. watch.mjs is a top-level script: it is copied into a temp root with one synthetic
// manifest (one evm-proxy source on chain 1) and EVM_RPC_URL points at a local server. --dry: nothing is written.
// The three special names must reach the digest like any other message; "boom" is the control.
import {test} from "node:test";
import assert from "node:assert/strict";
import {copyFileSync, mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "watch-f19-"));
  mkdirSync(join(root, "scripts/watch"), {recursive: true});
  for (const f of ["watch.mjs", "html-text.mjs"]) copyFileSync(join(here, f), join(root, "scripts/watch", f));
  mkdirSync(join(root, "packages/fake-mod"), {recursive: true});
  writeFileSync(join(root, "packages/fake-mod/watch.json"), JSON.stringify({
    module: "@anywalletkit/fake-mod",
    sources: [{id: "p", type: "evm-proxy", chainId: 1, address: "0x6a37725ca7f4ce81c004c955f7280d5c704a249e", label: "Fake proxy"}],
  }));
  return root;
}

async function runWith(message) {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({jsonrpc: "2.0", id: 1, error: {code: -32000, message}})); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = sandbox();
  const child = spawn(process.execPath, [join(root, "scripts/watch/watch.mjs"), "--dry"], {
    env: {PATH: process.env.PATH, GITHUB_TOKEN: "x", EVM_RPC_URL: `http://127.0.0.1:${server.address().port}`},
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "", err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const code = await new Promise((r) => child.on("close", r));
  server.close();
  return {code, out, err};
}

for (const message of ["boom", "constructor", "__proto__", "toString"]) {
  test(`an RPC error "${message}" still yields the digest`, async () => {
    const r = await runWith(message);
    // Before the fix the special names exited 1 with "TypeError: … .push is not a function" and no digest.
    assert.equal(r.code, 0, r.err.slice(0, 400));
    assert.match(r.out, /## Unreachable/);
    assert.match(r.out, new RegExp(`Fake proxy: ${message.replace(/[_]/g, "_")}`));
  });
}
