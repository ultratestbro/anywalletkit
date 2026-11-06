// node --test scripts/watch/watch-2026-11-05-evm-call.test.mjs — the `evm-call` watch source (Curve prep, 2026-11-05):
//   - evm-call.mjs: keccak256 / selectors, static-argument encoding, the bounds-checked answer decoder (uint, int, address,
//     bool, string, bytes32, tuples with a string inside, several values), refusals for what it does not encode or decode;
//   - end to end through watch.mjs: a decoded answer is the compared value and the digest names old → new; a revert is a
//     reading and is compared like any answer; any other RPC failure keeps the previous value; another call under the
//     same id (args, decode, `to`) is re-pointed, not reported as a change; a chain without an RPC is unreachable.
// Same sandbox as watch-2026-11-04-sources.test.mjs: watch.mjs copied into a temp root with synthetic manifests, a local RPC.
import {test} from "node:test";
import assert from "node:assert/strict";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {callData, decodeResult, keccak256, parseSignature, selectorOf} from "./evm-call.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, "0");
const addrWord = (a) => a.slice(2).toLowerCase().padStart(64, "0");
const strTail = (s) => { const h = Buffer.from(s, "utf8").toString("hex"); return word(h.length / 2) + h.padEnd(Math.ceil(h.length / 64) * 64 || 0, "0"); };

test("keccak256 matches the Ethereum vectors (empty, short, more than one 136-byte block) and selectors are canonical", () => {
  assert.equal(keccak256(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256("abc"), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.equal(keccak256("a".repeat(200)), "0x96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d"); // viem keccak256, 2026-11-05
  assert.equal(selectorOf("transfer(address,uint256)"), "0xa9059cbb");
  assert.equal(selectorOf("transfer(address, uint)"), "0xa9059cbb", "uint is uint256, spaces are ignored");
  assert.equal(selectorOf("get_id_info(uint256)"), "0x92668ecb");
  assert.equal(selectorOf("version()"), "0x54fd4d50");
  assert.deepEqual(parseSignature("balanceOf(address)"), {name: "balanceOf", types: ["address"]});
});

test("callData: data as given or signature + static args; anything ambiguous or out of range is refused", () => {
  assert.equal(callData({data: "0x54FD4D50"}), "0x54fd4d50");
  assert.equal(callData({signature: "get_id_info(uint256)", args: [2]}), "0x92668ecb" + word(2));
  assert.equal(callData({signature: "get_id_info(uint256)", args: ["0x10"]}), "0x92668ecb" + word(16));
  const who = "0x5ffe7FB82894076ECB99A30D6A32e969e6e35E98";
  assert.equal(callData({signature: "f(address,bool,int8,bytes4)", args: [who, true, "-1", "0xdeadbeef"]}),
    selectorOf("f(address,bool,int8,bytes4)") + addrWord(who) + word(1) + "f".repeat(64) + "deadbeef".padEnd(64, "0"));
  // A uint256 beyond 2^53 goes in as a string, exactly.
  assert.equal(callData({signature: "f(uint256)", args: ["115792089237316195423570985008687907853269984665640564039457584007913129639935"]}), selectorOf("f(uint256)") + "f".repeat(64));
  assert.throws(() => callData({}), /needs data or signature/);
  assert.throws(() => callData({data: "0x54fd4d50", signature: "version()"}), /not both/);
  assert.throws(() => callData({data: "0x54fd"}), /not 0x-hex calldata/);
  assert.throws(() => callData({data: "0x54fd4d5"}), /not 0x-hex calldata/);
  assert.throws(() => callData({signature: "f(uint256)", args: []}), /takes 1 argument/);
  assert.throws(() => callData({signature: "f(uint8)", args: [256]}), /out of range for uint8/);
  assert.throws(() => callData({signature: "f(uint256)", args: [-1]}), /out of range/);
  assert.throws(() => callData({signature: "f(uint256)", args: [2 ** 60]}), /not an integer/, "an unsafe JSON number is refused, not rounded");
  assert.throws(() => callData({signature: "f(uint256)", args: [1.5]}), /not an integer/);
  assert.throws(() => callData({signature: "f(address)", args: ["0x12"]}), /not an address/);
  assert.throws(() => callData({signature: "f(bool)", args: ["true"]}), /not a bool/);
  assert.throws(() => callData({signature: "f(bytes2)", args: ["0xdeadbeef"]}), /not bytes2/);
  assert.throws(() => callData({signature: "f(string)", args: ["x"]}), /string is not supported/);
  assert.throws(() => callData({signature: "f(uint256[])", args: [[1]]}), /bad signature/);
  assert.throws(() => callData({signature: "f((uint256,address))", args: [[1, who]]}), /bad signature/);
  assert.throws(() => callData({signature: "f(uint7)", args: [1]}), /uint7 is not supported/);
});

test("decodeResult: every type, tuples with a string inside (AddressProvider get_id_info), several values, raw", () => {
  const ADDR = "0x16c6521dff6bab339122a0fe25a9116693265353";
  assert.equal(decodeResult("0x" + word(604800), "uint256"), "604800");
  assert.equal(decodeResult("0x" + "f".repeat(64), "uint256"), (2n ** 256n - 1n).toString(), "bigint-exact, never a float");
  assert.equal(decodeResult("0x" + word(-5), "int256"), "-5");
  assert.equal(decodeResult("0x" + addrWord(ADDR), "address"), ADDR);
  assert.equal(decodeResult("0x" + word(0), "bool"), false);
  assert.equal(decodeResult("0x" + word(1), "bool"), true);
  assert.equal(decodeResult("0x" + "ab".repeat(32), "bytes32"), "0x" + "ab".repeat(32));
  assert.equal(decodeResult("0x" + word(32) + strTail("1.2.0"), "string"), "1.2.0");
  assert.equal(decodeResult("0x" + word(32) + strTail(""), "string"), "");
  // get_id_info(2) on the Ethereum AddressProvider, as answered 2026-11-05: one dynamic tuple (address, string, uint256, uint256).
  const idInfo = "0x" + word(32) + addrWord(ADDR) + word(128) + word(2) + word(1721210015) + strTail("Exchange Router");
  assert.deepEqual(decodeResult(idInfo, "(address,string,uint256,uint256)"), [ADDR, "Exchange Router", "2", "1721210015"]);
  // Several top-level values, a static tuple inline among them.
  assert.deepEqual(decodeResult("0x" + word(7) + addrWord(ADDR) + word(1) + word(128) + strTail("x"), ["uint8", "(address,bool)", "string"]), ["7", [ADDR, true], "x"]);
  assert.equal(decodeResult("0xDEAD"), "0xdead", "raw is the default");
  assert.equal(decodeResult("0x", "raw"), "0x");
});

test("decodeResult refuses malformed answers and unknown decode types instead of returning a wrong value", () => {
  assert.throws(() => decodeResult("0x", "uint256"), /empty answer/);
  assert.throws(() => decodeResult("0x1234", "uint256"), /not ABI words/);
  assert.throws(() => decodeResult("xyz", "uint256"), /not hex/);
  assert.throws(() => decodeResult("0x" + word(1), ["uint256", "uint256"]), /too short/);
  assert.throws(() => decodeResult("0x" + word(256), "uint8"), /not a uint8/);
  assert.throws(() => decodeResult("0x" + word(200), "int8"), /not a int8/);
  assert.throws(() => decodeResult("0x" + word(1n << 160n), "address"), /not an address/);
  assert.throws(() => decodeResult("0x" + word(2), "bool"), /not a bool/);
  assert.throws(() => decodeResult("0x" + word(33) + strTail("x"), "string"), /bad offset/);
  assert.throws(() => decodeResult("0x" + word(1n << 40n), "string"), /bad offset/);
  assert.throws(() => decodeResult("0x" + word(32) + word(1000), "string"), /bad string length/);
  assert.throws(() => decodeResult("0x" + word(32) + word(1) + "ff".padEnd(64, "0"), "string"), /not UTF-8/);
  for (const bad of ["uint7", "bytes", "bytes4", "address[]", "(uint256", "()", "(uint256,)", "tuple", ["raw"], []]) {
    assert.throws(() => decodeResult("0x" + word(1), bad), /decode/, JSON.stringify(bad));
  }
});

// ── end to end ─────────────────────────────────────────────────────────────
function sandbox(manifests) {
  const root = mkdtempSync(join(tmpdir(), "watch-1105-"));
  mkdirSync(join(root, "scripts/watch"), {recursive: true});
  for (const f of ["watch.mjs", "html-text.mjs", "pins.mjs", "evm-call.mjs", "zcash-branch.mjs"]) copyFileSync(join(here, f), join(root, "scripts/watch", f));
  for (const [dir, m] of Object.entries(manifests)) { mkdirSync(join(root, "packages", dir), {recursive: true}); writeFileSync(join(root, "packages", dir, "watch.json"), JSON.stringify(m)); }
  return root;
}
const readState = (root, slug) => JSON.parse(readFileSync(join(root, "watch/state", `${slug}.json`), "utf8")).sources;
async function serve(rpc) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const {method, params} = JSON.parse(body);
      calls.push({method, params});
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({jsonrpc: "2.0", id: 1, ...rpc(method, params)}));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close()};
}
async function run(root, rpcUrl) {
  const child = spawn(process.execPath, [join(root, "scripts/watch/watch.mjs")], {env: {PATH: process.env.PATH, GITHUB_TOKEN: "x", EVM_RPC_URL: rpcUrl}, stdio: ["ignore", "pipe", "pipe"]});
  let out = "", err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const code = await new Promise((r) => child.on("close", r));
  return {code, out, err};
}

const AP = "0x5ffe7FB82894076ECB99A30D6A32e969e6e35E98", VAULT = "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367";
const V11 = "0x16c6521dff6bab339122a0fe25a9116693265353", V12 = "0x45312ea0eff7e09c83cbe249fa1d7598c4c8cd4e";

test("evm-call end to end: decoded value compared, revert is a reading, other failures keep the value, a new call re-points", async () => {
  const chain = {router: V11, routerVersion: 2n, modified: 1721210015n, shutdown: 0n, unlock: 604800n, versionError: null, shutdownRevert: false};
  const SEL = {info: selectorOf("get_id_info(uint256)"), shutdown: selectorOf("isShutdown()"), unlock: selectorOf("profitMaxUnlockTime()"), version: selectorOf("version()")};
  const srv = await serve((method, [call]) => {
    if (method !== "eth_call") return {error: {code: -32601, message: "method not found"}};
    const to = call.to.toLowerCase(), data = call.data;
    if (to === AP.toLowerCase() && data === SEL.info + word(2)) return {result: "0x" + word(32) + addrWord(chain.router) + word(128) + word(chain.routerVersion) + word(chain.modified) + strTail("Exchange Router")};
    if (to === AP.toLowerCase() && data === SEL.info + word(7)) return {result: "0x" + word(32) + addrWord("0xF98B45FA17DE75FB1aD0e7aFD971b0ca00e379fC") + word(128) + word(1) + word(1) + strTail("Metaregistry")};
    if (to === VAULT.toLowerCase() && data === SEL.shutdown) return chain.shutdownRevert ? {error: {code: 3, message: "execution reverted"}} : {result: "0x" + word(chain.shutdown)};
    if (to === VAULT.toLowerCase() && data === SEL.unlock) return {result: "0x" + word(chain.unlock)};
    if (to === V12 && data === SEL.version) return chain.versionError ? {error: {code: -32000, message: chain.versionError}} : {result: "0x" + word(32) + strTail("1.2.0")};
    return {error: {code: 3, message: "execution reverted"}};
  });
  const sources = [
    {id: "ap-router", type: "evm-call", chainId: 1, to: AP, signature: "get_id_info(uint256)", args: [2], decode: "(address,string,uint256,uint256)", label: "AddressProvider id 2 (router) · Ethereum"},
    {id: "vault-shutdown", type: "evm-call", chainId: 1, to: VAULT, signature: "isShutdown()", decode: "bool", label: "scrvUSD isShutdown · Ethereum"},
    {id: "vault-unlock", type: "evm-call", chainId: 1, to: VAULT, data: SEL.unlock, decode: "uint256", label: "scrvUSD profitMaxUnlockTime · Ethereum"},
    {id: "router-version", type: "evm-call", chainId: 1, to: V12, signature: "version()", decode: "string", label: "Router NG v1.2 version · Ethereum"},
    {id: "no-rpc", type: "evm-call", chainId: 424242, to: V12, signature: "version()", decode: "string", label: "Unknown chain"},
    {id: "bad-to", type: "evm-call", chainId: 1, to: "0x12", signature: "version()", label: "Bad target"},
  ];
  const root = sandbox({curve: {module: "@anywalletkit/curve", sources}});
  try {
    let r = await run(root, srv.url);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /0 changed, 2 unreachable/);
    assert.match(r.out, /Unknown chain: no RPC for chain 424242/);
    assert.match(r.out, /Bad target: evm-call: `to` is not an address/);
    let st = readState(root, "curve");
    assert.deepEqual(st["ap-router"].meta, {call: "get_id_info(uint256) [2]", result: [V11, "Exchange Router", "2", "1721210015"]});
    assert.equal(st["ap-router"].value, JSON.stringify([V11, "Exchange Router", "2", "1721210015"]));
    assert.deepEqual(st["ap-router"].target, {chainId: 1, to: AP.toLowerCase(), signature: "get_id_info(uint256)", args: [2], decode: "(address,string,uint256,uint256)"});
    assert.equal(st["vault-shutdown"].value, "false");
    assert.equal(st["vault-unlock"].meta.call, SEL.unlock, "a data-only call is named by its selector");
    assert.equal(st["vault-unlock"].value, '"604800"');
    assert.equal(st["router-version"].value, '"1.2.0"');

    // Curve re-registers the router (AddressProvider id 2 → v1.2, version bump, new timestamp): one diff naming both answers.
    Object.assign(chain, {router: V12, routerVersion: 3n, modified: 1790000000n});
    r = await run(root, srv.url);
    assert.match(r.out, /1 changed, 2 unreachable/);
    assert.match(r.out, new RegExp(`\\*\\*AddressProvider id 2 \\(router\\) · Ethereum\\*\\* \\(evm-call\\): get_id_info\\(uint256\\) \\[2\\]: \\(${V11}, Exchange Router, 2, 1721210015\\) → \\(${V12}, Exchange Router, 3, 1790000000\\)`));

    // isShutdown() flips, then starts reverting (the vault was replaced by something without it): both are changes.
    chain.shutdown = 1n;
    r = await run(root, srv.url);
    assert.match(r.out, /\*\*scrvUSD isShutdown · Ethereum\*\* \(evm-call\): isShutdown\(\): false → true/);
    chain.shutdownRevert = true;
    r = await run(root, srv.url);
    assert.match(r.out, /\*\*scrvUSD isShutdown · Ethereum\*\* \(evm-call\): isShutdown\(\): true → reverted/);
    assert.equal(readState(root, "curve")["vault-shutdown"].value, "reverted");
    r = await run(root, srv.url);
    assert.doesNotMatch(r.out, /scrvUSD isShutdown/, "a revert that stays a revert is not a change");

    // An RPC failure that is not a revert must not read as a new answer.
    chain.versionError = "header not found";
    r = await run(root, srv.url);
    assert.match(r.out, /Router NG v1\.2 version · Ethereum: header not found \(previous value kept\)/);
    assert.equal(readState(root, "curve")["router-version"].value, '"1.2.0"');
    chain.versionError = null;

    // The manifest now asks another id under the same source id: a new baseline, listed as re-pointed, not a change.
    writeFileSync(join(root, "packages/curve/watch.json"), JSON.stringify({module: "@anywalletkit/curve", sources: [{...sources[0], args: [7]}, ...sources.slice(1, 4)]}));
    r = await run(root, srv.url);
    assert.match(r.out, /0 changed, 0 unreachable, 1 re-pointed\./);
    assert.match(r.out, /- curve · AddressProvider id 2 \(router\) · Ethereum: chain 1 0x5ffe7fb82894076ecb99a30d6a32e969e6e35e98 get_id_info\(uint256\) \[2\] as \(address,string,uint256,uint256\) → chain 1 0x5ffe7fb82894076ecb99a30d6a32e969e6e35e98 get_id_info\(uint256\) \[7\] as \(address,string,uint256,uint256\)/);
    st = readState(root, "curve");
    assert.equal(st["ap-router"].meta.result[1], "Metaregistry");
    assert.ok(srv.calls.every((c) => c.method === "eth_call"), "evm-call only ever sends eth_call");
  } finally { srv.close(); }
});
