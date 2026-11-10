#!/usr/bin/env node
/**
 * Records the test fixtures: real answers of Symbiosis' public API, captured through the provider
 * itself (`fetchImpl`), one file per scenario in tests/fixtures/. Read-only: quotes only, nothing is
 * signed or sent. Run after `pnpm build`:
 *
 *   node scripts/record-fixtures.mjs [name …]
 *
 * The API serves about one quote per second per client, so scenarios are spaced out.
 */
import {mkdirSync, writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {symbiosisProvider} from "../dist/index.js";
import {ccAsset} from "@anywalletkit/swap2-assets";

const out = fileURLToPath(new URL("../tests/fixtures/", import.meta.url));
mkdirSync(out, {recursive: true});

// Well-known funded accounts (an exchange wallet per family) — only ever named as sender / recipient of a quote.
const EVM = "0x28C6c06298d514Db089934071355E5743bf21d60";
const TON = "UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI";
const TRON = "TNPdqto8HiuMzoG7Vv9wyyYhWzCojLeHAF";
const BTC = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
const C = {eth: "eip155:1", bsc: "eip155:56", base: "eip155:8453", arb: "eip155:42161", pol: "eip155:137", avax: "eip155:43114", ton: "ton:-239", tron: "tron:728126428", btc: "bitcoin:mainnet"};
const account = (chain) => (chain === C.ton ? TON : chain === C.tron ? TRON : chain === C.btc ? BTC : EVM);

/** name, source chain, sell symbol, destination chain, buy symbol, amount in units, venues to switch off on top of the provider's own list. */
const SCENARIOS = [
  ["bsc-usdc-ton-usdt", C.bsc, "USDC", C.ton, "USDT", "1500"],
  ["eth-usdc-arb-usdc", C.eth, "USDC", C.arb, "USDC", "100"],
  ["tron-usdt-base-usdc", C.tron, "USDT", C.base, "USDC", "50"],
  ["bsc-usdt-ton-usdt", C.bsc, "USDT", C.ton, "USDT", "1500"],
  ["eth-eth-base-eth", C.eth, "ETH", C.base, "ETH", "0.05"],
  ["bsc-bnb-eth-eth", C.bsc, "BNB", C.eth, "ETH", "0.2"],
  ["ton-usdt-tron-usdt", C.ton, "USDT", C.tron, "USDT", "50"],
  ["tron-usdt-ton-usdt", C.tron, "USDT", C.ton, "USDT", "50"],
  ["ton-usdt-base-usdc", C.ton, "USDT", C.base, "USDC", "50"],
  ["base-usdt-ton-usdt", C.base, "USDT", C.ton, "USDT", "50"],
  ["btc-btc-base-usdc", C.btc, "BTC", C.base, "USDC", "0.002"],
  // The first answer is steered onto 1inch (the list is added to the FIRST quote request only): its call
  // carries a tracking tag, the provider asks again without 1inch, and the rest is recorded as it comes.
  // 1inch quotes only for a sender that holds the tokens, hence the exchange wallet on BNB Chain.
  ["bsc-usdt-ton-usdt-tagged", C.bsc, "USDT", C.ton, "USDT", "1500", ["uni-v2", "0x", "bitget", "open-ocean", "kyber-swap"], "first", "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3"],
];

const units = (text, decimals) => {
  const [whole, frac = ""] = text.split(".");
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals))).toString();
};
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const only = process.argv.slice(2);
let limitsSaved = false;

for (const [name, from, sell, to, buy, amount, force = [], scope = "all", sender] of SCENARIOS) {
  if (only.length && !only.includes(name)) continue;
  const a = ccAsset(from, sell);
  const b = ccAsset(to, buy);
  if (!a || !b) { console.log(name, "— not in the catalog"); continue; }
  const exchanges = [];
  const fetchImpl = async (url, init = {}) => {
    let body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    if (body && force.length && typeof body.disabledProviders === "string" && (scope === "all" || !exchanges.some((e) => e.body))) {
      body = {...body, disabledProviders: [...new Set([...body.disabledProviders.split(","), ...force])].join(",")};
    }
    const res = await fetch(url, {...init, ...(body ? {body: JSON.stringify(body)} : {})});
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    const path = new URL(String(url)).pathname.replace(/^\/crosschain/, "");
    if (path === "/v1/swap-limits" && res.ok) {
      if (!limitsSaved) { writeFileSync(`${out}limits.json`, `${JSON.stringify(json, null, 1)}\n`); limitsSaved = true; }
      exchanges.push({method: "GET", path, status: res.status, response: "@limits"});
    } else {
      exchanges.push({method: init.method ?? "GET", path, ...(body ? {body} : {}), status: res.status, response: json});
    }
    return new Response(text, {status: res.status, headers: {"content-type": "application/json"}});
  };
  const config = {tronSource: true, btcSource: true, fallbackReceiver: EVM};
  const params = {
    sourceChain: from, sourceToken: sell, destChain: to,
    destToken: b.contract ?? (to.startsWith("eip155") ? "0x0000000000000000000000000000000000000000" : buy),
    amountIn: units(amount, a.decimals), destAddress: account(to), refundAddress: sender ?? account(from), slippageBps: 100, dry: from !== C.btc ? false : true,
  };
  let refusal = null;
  const quote = await symbiosisProvider({...config, fetchImpl}).getQuote({...params, onRefusal: (why) => { refusal = why; }});
  writeFileSync(`${out}${name}.json`, `${JSON.stringify({recordedAt: new Date().toISOString().slice(0, 10), params, config, force, exchanges, result: quote ? {destAmount: quote.destAmount, minDestAmount: quote.minDestAmount, providerData: quote.providerData} : {refusal}}, null, 1)}\n`);
  console.log(name, quote ? `out ${quote.destAmount} min ${quote.minDestAmount} src ${quote.providerData.sourceRouter ?? "-"} dst ${quote.providerData.destRouter ?? "-"}` : `REFUSED: ${refusal}`);
  await wait(6000);
}
