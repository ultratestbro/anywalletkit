// node --test scripts/watch/watch-2026-11-26-severity.test.mjs — gap G5 of 0x's 2026-11-24 Settler release
// (UNISWAP-V4-RESEARCH §7.4): a new Settler in force on a pinned chain refuses native-coin sales from that day, yet the
// diff entry read like any evm-call change and triage filed it Medium. A watch.json source may now carry `severity`
// (high / medium / low): it goes into the diff entry, leads its module in the digest and Telegram, and is counted in
// the header. A value outside the three is a manifest error. Same sandbox as watch-2026-11-05-evm-call.test.mjs.
import {test} from "node:test";
import assert from "node:assert/strict";
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {SEVERITIES, severityError} from "./manifest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const TODAY = () => new Date().toISOString().slice(0, 10);
const word = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

function sandbox(manifests) {
  const root = mkdtempSync(join(tmpdir(), "watch-1126-"));
  mkdirSync(join(root, "scripts/watch"), {recursive: true});
  for (const f of ["watch.mjs", "html-text.mjs", "pins.mjs", "evm-call.mjs", "zcash-branch.mjs", "manifest.mjs"]) copyFileSync(join(here, f), join(root, "scripts/watch", f));
  for (const [dir, m] of Object.entries(manifests)) { mkdirSync(join(root, "packages", dir), {recursive: true}); writeFileSync(join(root, "packages", dir, "watch.json"), JSON.stringify(m)); }
  return root;
}
async function serve(answer) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { const {method, params} = JSON.parse(body); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({jsonrpc: "2.0", id: 1, ...answer(method, params)})); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {url: `http://127.0.0.1:${server.address().port}`, close: () => server.close()};
}
async function run(root, rpcUrl) {
  const child = spawn(process.execPath, [join(root, "scripts/watch/watch.mjs")], {env: {PATH: process.env.PATH, GITHUB_TOKEN: "x", EVM_RPC_URL: rpcUrl, MONAD_RPC_URL: rpcUrl}, stdio: ["ignore", "pipe", "pipe"]});
  let out = "", err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const code = await new Promise((r) => child.on("close", r));
  return {code, out, err};
}

const REGISTRY = "0x00000000000004533Fe15556B1E086BB1A72cEae";
const S12 = "0xf16d1df42e368e4dd873b1f92ed0670ff4c987eb", S11 = "0x031d28683ffc9936903a31670bc618b8bc9b65dd", S13 = "0x1c1f59967a6d41655a5e6c1a670597c678625a00";
const OWNER = "0xf36b9f50e59870a24f42f9ba43b2ad0a4b8f2f51";

test("a severity on a source reaches the diff entry, the digest line and the header; sources without one are unchanged", async () => {
  const chain = {current: S12, prev: S11, owner: OWNER};
  const srv = await serve((method, [call]) => {
    if (method !== "eth_call" || call.to.toLowerCase() !== REGISTRY.toLowerCase()) return {error: {code: -32601, message: "no"}};
    if (call.data.startsWith("0x6352211e")) return {result: "0x" + word(chain.current)};
    if (call.data.startsWith("0xe2603dc2")) return {result: "0x" + word(chain.prev)};
    if (call.data === "0x8da5cb5b") return {result: "0x" + word(chain.owner)};
    return {error: {code: 3, message: "execution reverted"}};
  });
  const sources = [
    {id: "registry-owner-monad", type: "evm-call", chainId: 143, to: REGISTRY, signature: "owner()", decode: "address", label: "0x Settler registry owner() · Monad"},
    {id: "settler-in-force-monad", type: "evm-call", chainId: 143, to: REGISTRY, signature: "ownerOf(uint256)", args: [2], decode: "address", severity: "high", label: "0x Settler in force (registry ownerOf(2)) · Monad"},
    {id: "settler-previous-monad", type: "evm-call", chainId: 143, to: REGISTRY, signature: "prev(uint128)", args: [2], decode: "address", label: "0x Settler previous (registry prev(2)) · Monad"},
  ];
  const root = sandbox({"protocol-swap2-0x": {module: "@anywalletkit/protocol-swap2-0x", sources}});
  try {
    let r = await run(root, srv.url);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /3 sources, 0 changed, 0 unreachable\./);
    const st = JSON.parse(readFileSync(join(root, "watch/state/protocol-swap2-0x.json"), "utf8")).sources;
    assert.equal(st["settler-previous-monad"].meta.call, "prev(uint128) [2]");
    assert.equal(st["settler-previous-monad"].value, JSON.stringify(S11));
    assert.equal(st["settler-in-force-monad"].target.severity, undefined, "severity is not part of the target: adding one is no re-point");

    // 0x deploys Settler 13 on Monad: ownerOf(2) and prev(2) move together; the owner changes too, without a severity.
    Object.assign(chain, {current: S13, prev: S12, owner: "0x000000000000000000000000000000000000dead"});
    r = await run(root, srv.url);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /3 changed \(1 severity high\), 0 unreachable\./);
    const digest = r.out.split("\n").filter((l) => l.startsWith("- **"));
    assert.equal(digest[0], `- **0x Settler in force (registry ownerOf(2)) · Monad** (evm-call, severity high): ownerOf(uint256) [2]: ${S12} → ${S13}`, "the high-severity change leads its module");
    assert.ok(digest.includes(`- **0x Settler previous (registry prev(2)) · Monad** (evm-call): prev(uint128) [2]: ${S11} → ${S12}`));
    assert.ok(digest.some((l) => l.startsWith("- **0x Settler registry owner() · Monad** (evm-call): owner(): ")));
    const diff = JSON.parse(readFileSync(join(root, "watch/diff", `${TODAY()}.json`), "utf8"));
    const byId = Object.fromEntries(diff.changes.map((c) => [c.id, c]));
    assert.equal(byId["settler-in-force-monad"].severity, "high");
    assert.equal("severity" in byId["settler-previous-monad"], false);
    assert.equal("severity" in byId["registry-owner-monad"], false);
    assert.equal(readFileSync(join(root, "watch/digest", `${TODAY()}.md`), "utf8").includes("(evm-call, severity high)"), true);

    // nothing moves: no change, no severity in the header
    r = await run(root, srv.url);
    assert.match(r.out, /3 sources, 0 changed, 0 unreachable\./);
  } finally { srv.close(); }
});

test("a severity outside high / medium / low is a manifest error, not a silent default", async () => {
  for (const bad of ["High", "critical", 3, ""]) {
    const root = sandbox({"x": {module: "@anywalletkit/x", sources: [{id: "a", type: "evm-code", chainId: 1, address: REGISTRY, severity: bad, label: "a"}]}});
    const r = await run(root, "http://127.0.0.1:9");
    assert.notEqual(r.code, 0, JSON.stringify(bad));
    assert.match(r.err, /source "a" has severity .* \(one of high, medium, low, or none\)/, JSON.stringify(bad));
  }
});

// Review 2026-11-26 round 2 (R2-1): a bad value in any real manifest stops the whole 06:15 watch in loadManifests, so
// every module goes unwatched that day. The same rule watch.mjs applies (manifest.mjs) is held here over every real
// manifest, at PR time.
test("every real manifest's severities are ones the watch accepts (packages/*/watch.json, watch/pending)", () => {
  const ROOT = join(here, "../..");
  const files = readdirSync(join(ROOT, "packages")).map((d) => join(ROOT, "packages", d, "watch.json")).filter(existsSync);
  const pending = join(ROOT, "watch/pending");
  if (existsSync(pending)) for (const f of readdirSync(pending)) if (f.endsWith(".watch.json")) files.push(join(pending, f));
  assert.ok(files.length > 20, `${files.length} manifests`);
  let withSeverity = 0;
  for (const f of files) {
    for (const s of JSON.parse(readFileSync(f, "utf8")).sources ?? []) {
      assert.equal(severityError(f, s), null);
      if (s.severity !== undefined) withSeverity++;
    }
  }
  assert.ok(withSeverity >= 8, "the 0x Settler in force is severity high on every chain of its table");
});

test("the manifest rule: none or one of high / medium / low; the rest are named in the error", () => {
  assert.deepEqual([...SEVERITIES], ["high", "medium", "low"]);
  for (const ok of [undefined, "high", "medium", "low"]) assert.equal(severityError("m.json", {id: "a", ...(ok ? {severity: ok} : {})}), null);
  for (const bad of ["High", "critical", 3, "", null, ["high"]]) assert.match(severityError("m.json", {id: "a", severity: bad}), /^m\.json: source "a" has severity .* \(one of high, medium, low, or none\)$/, JSON.stringify(bad));
});
