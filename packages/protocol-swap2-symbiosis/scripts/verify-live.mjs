#!/usr/bin/env node
/**
 * Live, read-only check of the module against mainnet and Symbiosis' public API. Nothing is signed and
 * nothing is sent: quotes, `eth_getCode`, `eth_call`, and unsigned Tron builds only.
 *
 *   pnpm build && node scripts/verify-live.mjs [--skip-pins] [--skip-compare]
 *
 * 1. every pinned contract in watch.json has code and every pinned relation (gateway → MetaRouter,
 *    portal → bridge, Unwrapper → wrapped token, Synthesis → Fabric / MetaRouter) still reads as pinned;
 *    the pool tables and the synthetic-token map equal the host chain (`build-pins.mjs --check`);
 *    the Tron gateway / portal are contracts, the TON Portal is an active account;
 * 2. real quotes through the provider (so every one that prints OK passed the calldata checks), each
 *    checked once more through `symbiosisVerifyQuote` / `preflightDeposit` the way an app behind
 *    `remoteProvider` would;
 * 3. EVM sources: the exact transaction simulated with `eth_call` from a funded exchange wallet — native
 *    sources as they are, token sources with the gateway allowance set by a state override (the wallet has
 *    not approved the gateway, and this script approves nothing);
 * 4. Tron source: the node's unsigned build of the call checked byte for byte with wallet-tron's
 *    `assertNodeBuild`;
 * 5. the two pairs of the ticket priced by the sibling providers at the same moment.
 *
 * The API serves about one quote per second per client; scenarios are spaced out.
 */
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {encodeAbiParameters, getAddress, keccak256, toFunctionSelector} from "viem";
import {SYMBIOSIS_CHAINS, symbiosisPinsFor, symbiosisProvider, symbiosisTronCall} from "../dist/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../../..");
const dist = (pkg, file) => import(pathToFileURL(resolve(root, "packages", pkg, "dist", file)).href);
const {ccAsset} = await dist("swap2-assets", "index.js");
const {assertNodeBuild} = await dist("wallet-tron", "index.js");
const flags = new Set(process.argv.slice(2));
const env = process.env;

const RPC = {
  1: env.EVM_RPC_URL ?? "https://ethereum-rpc.publicnode.com", 56: env.BSC_RPC_URL ?? "https://bsc-rpc.publicnode.com", 43114: env.AVALANCHE_RPC_URL ?? "https://avalanche-c-chain-rpc.publicnode.com",
  137: env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com", 42161: env.ARBITRUM_RPC_URL ?? "https://arbitrum-one-rpc.publicnode.com", 10: env.OPTIMISM_RPC_URL ?? "https://optimism-rpc.publicnode.com",
  8453: env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com", 13863860: env.SYMBIOSIS_HOST_RPC_URL ?? "https://symbiosis.calderachain.xyz/http",
};
const TRON_API = env.TRON_API_URL ?? "https://api.trongrid.io";
const TON_API = (env.TON_RPC_URL ? env.TON_RPC_URL.replace(/\/$/, "") : "https://toncenter.com/api/v2") + "/jsonRPC";
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
let failures = 0;
const fail = (line) => { failures++; console.log(`FAIL    ${line}`); };

let rpcId = 0;
async function rpc(chainId, method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(RPC[chainId], {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: ++rpcId, method, params})});
      const j = await r.json();
      if (j.error) return {error: j.error};
      return {result: j.result};
    } catch (e) {
      if (attempt >= 3) return {error: {message: String(e?.message ?? e)}};
      await wait(700 * (attempt + 1));
    }
  }
}
async function post(url, body) {
  const r = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});
  return r.json();
}

// ── 1. pins ──────────────────────────────────────────────────────────────────
if (!flags.has("--skip-pins")) {
  console.log("== pinned contracts ==");
  const watch = JSON.parse(readFileSync(resolve(here, "../watch.json"), "utf8"));
  let code = 0, relations = 0;
  for (const s of watch.sources) {
    if (s.type === "evm-code" || s.type === "evm-proxy") {
      const r = await rpc(s.chainId, "eth_getCode", [s.address, "latest"]);
      if (r.result && r.result.length > 2) code++;
      else fail(`${s.id}: no code at ${s.address} on chain ${s.chainId} (${JSON.stringify(r.error ?? r.result)})`);
    } else if (s.type === "evm-call") {
      const r = await rpc(s.chainId, "eth_call", [{to: s.to, data: toFunctionSelector(s.signature)}, "latest"]);
      const pinned = /pinned (0x[0-9a-fA-F]{40})/.exec(s.label)?.[1];
      if (!r.result || r.result.length < 66) { fail(`${s.id}: ${s.signature} did not answer (${JSON.stringify(r.error)})`); continue; }
      if (pinned) {
        const got = getAddress(`0x${r.result.slice(26, 66)}`);
        if (got === getAddress(pinned)) relations++;
        else fail(`${s.id}: ${s.signature} → ${got}, pinned ${pinned}`);
      }
    }
  }
  console.log(`OK      ${code} contracts have code; ${relations} on-chain relations equal the pins`);
  try {
    const out = execFileSync(process.execPath, [resolve(here, "build-pins.mjs"), "--check"], {encoding: "utf8"});
    console.log(`OK      build-pins --check: ${out.trim().split("\n").at(-1)}`);
  } catch (e) { fail(`build-pins --check: ${(e.stdout ?? e.message).trim().split("\n").at(-1)}`); }
  const tron = SYMBIOSIS_CHAINS["tron:728126428"];
  for (const [role, hex] of [["gateway", tron.gateway], ["MetaRouter", tron.executor], ["portal", tron.portal], ["bridge", tron.bridge]]) {
    // `getcontractinfo` carries the runtime code also for a contract another contract created (the MetaRouter is created by its gateway).
    const j = await post(`${TRON_API}/wallet/getcontractinfo`, {value: `41${hex.slice(2)}`});
    const c = j.smart_contract ?? {};
    if (typeof j.runtimecode === "string" && j.runtimecode.length > 0) console.log(`OK      Tron ${role} 41${hex.slice(2)} is a contract (${j.runtimecode.length / 2} bytes${c.name ? `, ${c.name}` : ""}${c.origin_address ? `, created by ${c.origin_address}` : ""})`);
    else fail(`Tron ${role} 41${hex.slice(2)}: no contract`);
    await wait(400);
  }
  const portal = watch.sources.find((s) => s.type === "ton-code");
  const acc = await post(TON_API, {jsonrpc: "2.0", id: 1, method: "getAddressInformation", params: {address: portal.address}});
  if (acc.result?.state === "active" && acc.result.code) console.log(`OK      TON Portal ${portal.address} is active`);
  else fail(`TON Portal ${portal.address}: ${JSON.stringify(acc.result?.state ?? acc.error)}`);
}

// ── 2–4. quotes ──────────────────────────────────────────────────────────────
// Funded exchange wallets, only ever named as sender / recipient of a quote or as `from` of an eth_call.
const EVM = "0x28C6c06298d514Db089934071355E5743bf21d60";
const EVM_BSC = "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3";
const TON = "UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI";
const TRON = "TNPdqto8HiuMzoG7Vv9wyyYhWzCojLeHAF";
const BTC = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
const C = {eth: "eip155:1", bsc: "eip155:56", base: "eip155:8453", arb: "eip155:42161", pol: "eip155:137", avax: "eip155:43114", ton: "ton:-239", tron: "tron:728126428", btc: "bitcoin:mainnet"};
const account = (chain) => (chain === C.ton ? TON : chain === C.tron ? TRON : chain === C.btc ? BTC : chain === C.bsc ? EVM_BSC : EVM);
// ERC-20 storage slot of `allowance[owner][spender]` (the mapping's slot index), for the state override.
const ALLOWANCE_SLOT = {
  "1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 10n, // USDC (FiatToken)
  "56:0x55d398326f99059ff775485246999027b3197955": 2n, // BSC-USD
  "56:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": 2n, // Binance-Peg USDC
  "42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831": 10n, // USDC (FiatToken)
  "8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 10n, // USDC (FiatToken)
};
const SCENARIOS = [
  ["ticket pair 1", C.tron, "USDT", C.base, "USDC", "50"],
  ["ticket pair 2", C.base, "USDT", C.ton, "USDT", "50"],
  ["BSC → TON above $1000", C.bsc, "USDT", C.ton, "USDT", "1500"],
  ["BSC → TON above $1000", C.bsc, "USDC", C.ton, "USDT", "1500"],
  ["EVM → EVM", C.eth, "USDC", C.arb, "USDC", "100"],
  ["EVM → EVM, native", C.eth, "ETH", C.base, "ETH", "0.05"],
  ["EVM → TON", C.base, "USDC", C.ton, "USDT", "50"],
  ["EVM → TON, native", C.base, "ETH", C.ton, "USDT", "0.02"],
  ["TON source", C.ton, "USDT", C.tron, "USDT", "50"],
  ["TON source", C.ton, "USDT", C.base, "USDC", "50"],
  ["Tron source", C.tron, "USDT", C.ton, "USDT", "50"],
  ["Bitcoin source (display)", C.btc, "BTC", C.base, "USDC", "0.002"],
];
const units = (text, decimals) => {
  const [whole, frac = ""] = text.split(".");
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals))).toString();
};
const show = (amount, decimals) => {
  const s = BigInt(amount).toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals) || "0"}.${s.slice(-decimals).slice(0, 6)}`;
};
const config = {tronSource: true, btcSource: true, fallbackReceiver: EVM};
const provider = symbiosisProvider(config);
const pins = symbiosisPinsFor(config);
const paramsOf = (from, sell, to, buy, amount, dry = false) => {
  const a = ccAsset(from, sell);
  const b = ccAsset(to, buy);
  return {a, b, params: {
    sourceChain: from, sourceToken: sell, destChain: to, destToken: b.contract ?? (to.startsWith("eip155:") ? "0x0000000000000000000000000000000000000000" : buy),
    amountIn: units(amount, a.decimals), destAddress: account(to), refundAddress: account(from), slippageBps: 100, dry,
  }};
};

const TRANSFER = "0xddf252ad1be2abb23de4b8c692d2ad0c1b68fc378daa952ba7f163c4a11628ef";
/** Wallets that hold at least `amount` of `token` now: the scenario's own account first, then recipients of the latest transfers. */
async function holders(chainId, token, amount, first) {
  const out = [];
  const holds = async (who) => {
    const r = await rpc(chainId, "eth_call", [{to: token, data: `0x70a08231${who.slice(2).toLowerCase().padStart(64, "0")}`}, "latest"]);
    return !r.error && r.result && r.result !== "0x" && BigInt(r.result) >= amount;
  };
  if (await holds(first)) out.push(first);
  const head = BigInt((await rpc(chainId, "eth_blockNumber", [])).result);
  for (const span of [200n, 40n]) {
    const logs = await rpc(chainId, "eth_getLogs", [{address: token, fromBlock: `0x${(head - span).toString(16)}`, toBlock: `0x${head.toString(16)}`, topics: [TRANSFER]}]);
    if (logs.error || !Array.isArray(logs.result)) continue;
    const seen = new Set(out.map((x) => x.toLowerCase()));
    for (const l of logs.result.reverse()) {
      if (out.length >= 6) break;
      const who = getAddress(`0x${l.topics[2].slice(26)}`);
      if (seen.has(who.toLowerCase()) || BigInt(l.data === "0x" ? 0 : l.data) < amount) continue;
      seen.add(who.toLowerCase());
      if (await holds(who)) out.push(who);
    }
    break;
  }
  return out;
}

async function simulate(quote, tx, a) {
  const chainId = tx.chainId;
  const own = account(tx.chain);
  const call = (from) => ({from, to: tx.to, data: tx.data, value: `0x${BigInt(tx.value).toString(16)}`});
  if (a.contract == null) {
    const r = await rpc(chainId, "eth_call", [call(own), "latest"]);
    if (!r.error) return "eth_call from a funded wallet: success (native source, no allowance needed)";
    // The wallet may not hold the coin on this chain: give it the sold amount plus gas by state override and say so.
    const funded = await rpc(chainId, "eth_call", [call(own), "latest", {[own]: {balance: `0x${(BigInt(tx.value) + 10n ** 18n).toString(16)}`}}]);
    return funded.error ? `REVERT ${r.error.message}; with the balance set by state override: REVERT ${funded.error.message}` : `eth_call: the wallet lacks the coin (${String(r.error.message).slice(0, 40)}); with its balance set by state override: success (native source, no allowance needed)`;
  }
  const plain = await rpc(chainId, "eth_call", [call(own), "latest"]);
  const before = `eth_call without an approval: ${plain.error ? `reverts (${String(plain.error.message).slice(0, 80)})` : "SUCCESS (unexpected)"}`;
  const slot = ALLOWANCE_SLOT[`${chainId}:${a.contract.toLowerCase()}`];
  if (slot === undefined) return `${before}; no allowance slot known for a state override`;
  // The call pulls the tokens from whoever sends it, so any wallet that holds them can stand in for the sender.
  const tried = [];
  for (const from of await holders(chainId, a.contract, BigInt(quote.sourceAmount), own)) {
    const inner = keccak256(encodeAbiParameters([{type: "address"}, {type: "uint256"}], [from, slot]));
    const key = keccak256(encodeAbiParameters([{type: "address"}, {type: "bytes32"}], [tx.approvalAddress, inner]));
    const override = {[a.contract]: {stateDiff: {[key]: `0x${BigInt(quote.sourceAmount).toString(16).padStart(64, "0")}`}}};
    const r = await rpc(chainId, "eth_call", [call(from), "latest", override]);
    if (!r.error) return `${before}; from holder ${from} with allowance[holder][gateway] = the sold amount (state override, nothing else changed): success`;
    tried.push(`${from}: ${String(r.error.message).slice(0, 90)}`);
  }
  // No current holder could stand in (public nodes rarely serve recent logs): give a neutral address the sold amount and the
  // allowance, both by state override. The balance slot is found by probing and read back through balanceOf before it is used.
  const stand = "0x00000000000000000000000000000000005ca1ab";
  const amount = `0x${BigInt(quote.sourceAmount).toString(16).padStart(64, "0")}`;
  const pad = stand.slice(2).padStart(64, "0");
  for (let n = 0n; n < 16n; n++) {
    const bal = keccak256(encodeAbiParameters([{type: "address"}, {type: "uint256"}], [stand, n]));
    const read = await rpc(chainId, "eth_call", [{to: a.contract, data: `0x70a08231${pad}`}, "latest", {[a.contract]: {stateDiff: {[bal]: amount}}}]);
    if (read.error || !read.result || read.result === "0x" || BigInt(read.result) !== BigInt(amount)) continue;
    const inner = keccak256(encodeAbiParameters([{type: "address"}, {type: "uint256"}], [stand, slot]));
    const key = keccak256(encodeAbiParameters([{type: "address"}, {type: "bytes32"}], [tx.approvalAddress, inner]));
    const r = await rpc(chainId, "eth_call", [call(stand), "latest", {[a.contract]: {stateDiff: {[bal]: amount, [key]: amount}}}]);
    if (!r.error) return `${before}; from a neutral address given the sold amount (balance slot ${n}) and allowance[sender][gateway] by state override, nothing else changed: success`;
    tried.push(`neutral address with balance + allowance overrides: ${String(r.error.message).slice(0, 90)}`);
    break;
  }
  return `${before}; with the allowance set by state override: ${tried.length ? `REVERT for every holder tried — ${tried.join(" | ")}` : "no holder of the amount found in the latest transfers"}`;
}

console.log("\n== quotes (each OK passed the calldata checks inside the provider) ==");
const served = {};
for (const [label, from, sell, to, buy, amount] of SCENARIOS) {
  const btc = from === C.btc;
  const {a, b, params} = paramsOf(from, sell, to, buy, amount, btc);
  await wait(6000);
  let why = "";
  let quote = null;
  try { quote = await provider.getQuote({...params, onRefusal: (r) => { why = String(r); }}); } catch (e) { why = `threw: ${e.message}`; }
  const name = `${label}: ${amount} ${sell} ${from} → ${buy} ${to}`;
  if (!quote) { console.log(`REFUSED ${name}: ${why}`); continue; }
  served[`${from}:${sell}>${to}:${buy}`] = quote;
  const d = quote.providerData;
  console.log(`OK      ${name}: out ${show(quote.destAmount, b.decimals)} (min ${show(quote.minDestAmount, b.decimals)}), fees $${quote.feeUsd.toFixed(4)} [${quote.fees.map((f) => `${f.amount} ${f.token}`).join(" + ")}], eta ${quote.etaSeconds}s, source swap ${d.sourceRouter ?? "none"}, destination ${d.destRouter ?? "pool release"}, reverts by ${d.serviceReverts === "1" ? "Symbiosis' service" : "the user"}`);
  if (btc) { console.log("        display quote only: a live Bitcoin quote opens a deposit address through /v2/swap, which this script does not call"); continue; }
  const again = pins.verifyQuote(params, quote);
  if (again !== null) fail(`${name}: verifyQuote → ${again}`);
  try {
    const tx = await provider.buildDeposit(quote);
    await provider.preflightDeposit(quote, tx);
    const built = await pins.verifyBuild(quote, tx, params);
    if (built !== null) fail(`${name}: verifyBuild → ${built}`);
    else console.log(`        verifyQuote / verifyBuild / preflightDeposit: pass (to ${tx.to}${tx.approvalAddress ? `, spender ${tx.approvalAddress}` : ""}, value ${tx.value})`);
    if (from.startsWith("eip155:")) console.log(`        ${await simulate(quote, tx, a)}`);
    if (from === C.tron) {
      const call = symbiosisTronCall(quote, config);
      const node = await post(`${TRON_API}/wallet/triggersmartcontract`, {owner_address: call.call.owner, contract_address: call.call.contract, function_selector: call.call.functionSelector, parameter: call.call.parameter, fee_limit: call.call.feeLimit, call_value: Number(call.call.callValue), visible: true});
      if (!node.transaction) fail(`${name}: the Tron node built nothing (${JSON.stringify(node.result ?? node).slice(0, 200)})`);
      else {
        assertNodeBuild(node.transaction, call.expected);
        console.log(`        Tron node build ${node.transaction.txID.slice(0, 16)}… (unsigned, not broadcast): assertNodeBuild pass — txID = sha256(raw_data), owner, contract, calldata, call value, fee limit ${call.call.feeLimit} sun`);
        const sim = await post(`${TRON_API}/wallet/triggerconstantcontract`, {owner_address: call.call.owner, contract_address: call.call.contract, function_selector: call.call.functionSelector, parameter: call.call.parameter, visible: true});
        const msg = sim.result?.message ? Buffer.from(sim.result.message, "hex").toString() : (sim.constant_result?.[0] ?? "").slice(0, 80);
        console.log(`        Tron constant call without an approval: ${sim.result?.result === true && !sim.transaction?.ret?.[0]?.ret ? "success" : `reverts (${msg || sim.transaction?.ret?.[0]?.ret || "no reason"})`}, energy ${sim.energy_used ?? "?"}`);
      }
    }
    if (from === C.ton) console.log(`        TON message: ${tx.value} nanoton to the sender's jetton wallet ${tx.to} (the wallet engine derives and checks that address); not simulated`);
  } catch (e) { fail(`${name}: ${e.message}`); }
}

// ── 5. the ticket's pairs at the sibling providers, same moment ──────────────
if (!flags.has("--skip-compare")) {
  console.log("\n== the ticket's pairs at the sibling providers (dry quotes, same moment) ==");
  const siblings = {};
  try { siblings["near-intents"] = (await dist("protocol-swap2-near-intents", "provider.js")).nearIntentsProvider({enabled: true, ...(env.NEAR_INTENTS_JWT ? {jwt: env.NEAR_INTENTS_JWT} : {})}); } catch (e) { console.log(`        near-intents not loaded: ${e.message}`); }
  try { siblings.lifi = (await dist("protocol-swap2-lifi", "provider.js")).lifiProvider({enabled: true, ...(env.LIFI_API_KEY ? {apiKey: env.LIFI_API_KEY} : {})}); } catch (e) { console.log(`        lifi not loaded: ${e.message}`); }
  try { siblings.thorchain = (await dist("protocol-swap2-thorchain", "provider.js")).thorchainProvider({enabled: true, tronSource: true}); } catch (e) { console.log(`        thorchain not loaded: ${e.message}`); }
  for (const [label, from, sell, to, buy, amount] of [SCENARIOS[0], SCENARIOS[1], SCENARIOS[2]]) {
    const {b, params} = paramsOf(from, sell, to, buy, amount, true);
    const ours = served[`${from}:${sell}>${to}:${buy}`];
    console.log(`${label}: ${amount} ${sell} ${from} → ${buy} ${to}`);
    console.log(`        symbiosis: ${ours ? `${show(ours.destAmount, b.decimals)} (min ${show(ours.minDestAmount, b.decimals)}), eta ${ours.etaSeconds}s` : "refused (above)"}`);
    for (const [name, p] of Object.entries(siblings)) {
      let why = "";
      try {
        const q = await Promise.race([p.getQuote({...params, onRefusal: (r) => { why = String(r); }}), wait(30_000).then(() => { why = "timeout"; return null; })]);
        console.log(`        ${name}: ${q ? `${show(q.destAmount, b.decimals)}${q.minDestAmount ? ` (min ${show(q.minDestAmount, b.decimals)})` : ""}, eta ${q.etaSeconds ?? "?"}s` : `no quote — ${why.replace(/\s+/g, " ").slice(0, 160) || "null"}`}`);
      } catch (e) { console.log(`        ${name}: threw — ${String(e.message).slice(0, 160)}`); }
    }
  }
}

console.log(failures === 0 ? "\nverify-live: no failures" : `\nverify-live: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
