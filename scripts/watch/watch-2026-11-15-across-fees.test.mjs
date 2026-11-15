// node --test scripts/watch/watch-2026-11-15-across-fees.test.mjs — review 2026-11-15: when Across's /suggested-fees
// stopped answering, the Across verify-live printed "warn …" lines the canary did not match and stayed "ok", though the
// provider then falls back to a frozen floor (and refuses 13 of 17 chains). Runs the real script offline (fetch
// stubbed, no chain reads, no key) and classifies it with the canary's own rule.
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {existsSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {runStatus} from "./canary-status.mjs";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/protocol-swap2-across");
const built = existsSync(resolve(pkg, "dist/index.js"));

/** verify-live for one corridor, keyless, with `fetch` replaced by `stub` (a function body's source). */
function runOffline(stub) {
  const env = {...process.env};
  delete env.ACROSS_API_KEY;
  const r = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(`globalThis.fetch = ${stub};`)}`, "scripts/verify-live.mjs", "--no-chain", "--only", "^USDC Base → Arbitrum$"], {cwd: pkg, env, encoding: "utf8", timeout: 60_000});
  return {...runStatus({code: r.status, signal: r.signal, out: `${r.stdout}${r.stderr}`}), out: `${r.stdout}${r.stderr}`};
}

test("Across's relayer fee quote not answering makes the canary warn", {skip: !built && "build the across package first"}, () => {
  const r = runOffline(`async () => { throw new TypeError("fetch failed"); }`);
  assert.equal(r.status, "warn", r.out);
  assert.match(r.soft.join("\n"), /\/suggested-fees FAILED: no answer/);
});

test("an answer of another shape (a 5xx) warns too", {skip: !built && "build the across package first"}, () => {
  const r = runOffline(`async () => new Response("{}", {status: 503, headers: {"content-type": "application/json"}})`);
  assert.equal(r.status, "warn", r.out);
  assert.match(r.soft.join("\n"), /\/suggested-fees FAILED: unavailable \(it answered HTTP 503\)/);
});

test("Across refusing a pinned token (400 INVALID_PARAM) fails the run: the module would refuse every quote on it", {skip: !built && "build the across package first"}, () => {
  const body = JSON.stringify({type: "AcrossApiError", code: "INVALID_PARAM", status: 400, message: "Unsupported token on given origin chain", param: "inputTokenAddress"});
  const r = runOffline(`async () => new Response(${JSON.stringify(body)}, {status: 400, headers: {"content-type": "application/json"}})`);
  assert.equal(r.status, "fail", r.out);
  assert.match(r.out, /BAD fees .*does not serve this token or chain .*\[unsupported_pair\]/);
});

test("a clean answer is ok", {skip: !built && "build the across package first"}, () => {
  const body = (q) => ({
    totalRelayFee: {pct: "0", total: "8804"}, outputAmount: String(BigInt(q.get("amount")) - 8804n), timestamp: String(Math.floor(Date.now() / 1000) - 200),
    isAmountTooLow: false, estimatedFillTimeSec: 2, spokePoolAddress: "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64", destinationSpokePoolAddress: "0xe35e9842fceaca96570b734083f4a58e8f7c5f2a",
    inputToken: {address: q.get("inputToken"), chainId: 8453}, outputToken: {address: q.get("outputToken"), chainId: 42161},
  });
  const r = runOffline(`async (url) => { const q = new URL(url).searchParams; return new Response(JSON.stringify((${body.toString()})(q)), {status: 200, headers: {"content-type": "application/json"}}); }`);
  assert.equal(r.status, "ok", r.out);
});
