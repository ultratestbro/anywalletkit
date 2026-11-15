#!/usr/bin/env node
// Records fixtures/api/quotes/*.json: real Across answers to the requests the provider itself sends, through the real
// provider (dist/), with a recording fetch in front of it. Read-only — nothing is signed or sent on chain.
//
//   pnpm build && ACROSS_API_KEY=… node scripts/record-quotes.mjs [--only REGEX]
//
// What is kept per cell: the request each call made (the V5 body exactly as sent, the /suggested-fees query, the RPC
// method and params — never a header, so never the key), Across's answer (V5 bodies trimmed of the display-only
// `chain` / `refundTo` objects; nothing the provider reads is removed), the clock of the quote, and what the provider
// made of it (the deposit's numbers, or the refusal). The key is read from the environment only and never written:
// the script refuses to write a fixture that contains it. RPC_<chainId>=url overrides a public endpoint.
import {mkdirSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {acrossProvider} from "../dist/provider.js";

const KEY = process.env.ACROSS_API_KEY;
if (!KEY) throw new Error("ACROSS_API_KEY is not set");
const ONLY = process.argv.includes("--only") ? new RegExp(process.argv[process.argv.indexOf("--only") + 1]) : null;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "api", "quotes");
mkdirSync(OUT, {recursive: true});
// A public address, used only as the subject of the quote (nothing is signed or sent).
const SUBJECT = "0xF977814e90dA44bFA03b6295A0616a897441aceC";
const ZERO = "0x0000000000000000000000000000000000000000";
const RPC = {
  "eip155:1": process.env.RPC_1 ?? "https://ethereum-rpc.publicnode.com",
  "eip155:8453": process.env.RPC_8453 ?? "https://base-rpc.publicnode.com",
  "eip155:42161": process.env.RPC_42161 ?? "https://arbitrum-one-rpc.publicnode.com",
  "eip155:10": process.env.RPC_10 ?? "https://optimism-rpc.publicnode.com",
};
const rpcLabel = Object.fromEntries(Object.entries(RPC).map(([k, v]) => [v, `rpc:${k}`]));
const T = {
  baseUsdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", arbUsdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", opUsdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  ethUsdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7", arbUsdt0: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  ethWbtc: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", arbWbtc: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
};
// [name, note, from chain, source token (catalog symbol or contract), to chain, dest token, amount, options]
const CELLS = [
  ["usdc-base-arb-25", "USDC Base → Arbitrum, 25 USDC (V5 fee over the relayer fee: F5 prices it)", "eip155:8453", "USDC", "eip155:42161", T.arbUsdc, "25000000"],
  ["usdc-arb-base-2000", "USDC Arbitrum → Base, 2 000 USDC", "eip155:42161", "USDC", "eip155:8453", T.baseUsdc, "2000000000"],
  ["usdc-base-op-5", "USDC Base → Optimism, 5 USDC", "eip155:8453", "USDC", "eip155:10", T.opUsdc, "5000000"],
  ["eth-base-arb-5", "ETH Base → Arbitrum, ~$5", "eip155:8453", "ETH", "eip155:42161", ZERO, "2840000000000000"],
  ["eth-base-arb-100", "ETH Base → Arbitrum, ~$100", "eip155:8453", "ETH", "eip155:42161", ZERO, "56700000000000000"],
  ["eth-arb-base-2000", "ETH Arbitrum → Base, ~$2 000 (V5's auction price is under what plain deposits are filled at: the relayer fee prices it)", "eip155:42161", "ETH", "eip155:8453", ZERO, "1134000000000000000"],
  ["eth-op-base-100", "ETH Optimism → Base, ~$100", "eip155:10", "ETH", "eip155:8453", ZERO, "56700000000000000"],
  ["eth-eth-base-5", "ETH Ethereum → Base, ~$5 (V5 adds its own origin gas; refused at maxFee 1000, quoted at 5000)", "eip155:1", "ETH", "eip155:8453", ZERO, "2840000000000000"],
  ["eth-eth-base-100", "ETH Ethereum → Base, ~$100", "eip155:1", "ETH", "eip155:8453", ZERO, "56700000000000000"],
  ["usdt-eth-arb-100", "USDT Ethereum → USDT0 Arbitrum, 100 USDT (V5 prices another rail, ~20 min; the plain deposit is priced at V5's fee net of its origin step)", "eip155:1", "USDT", "eip155:42161", T.arbUsdt0, "100000000"],
  ["wbtc-eth-arb-100", "WBTC Ethereum → Arbitrum, ~$100", "eip155:1", "WBTC", "eip155:42161", T.arbWbtc, "156000"],
  ["usdc-base-arb-25-dry", "USDC Base → Arbitrum, 25 USDC, a dry quote (no signing account: priced, never built)", "eip155:8453", "USDC", "eip155:42161", T.arbUsdc, "25000000", {dry: true}],
  ["eth-arb-base-2000-floor", "ETH Arbitrum → Base, ~$2 000, without /suggested-fees: the pinned floor and the chains' block times", "eip155:42161", "ETH", "eip155:8453", ZERO, "1134000000000000000", {floor: true}],
  ["usdc-arb-base-100-floor", "USDC Arbitrum → Base, 100 USDC, without /suggested-fees", "eip155:42161", "USDC", "eip155:8453", T.baseUsdc, "100000000", {floor: true}],
  ["usdc-base-arb-tiny", "USDC Base → Arbitrum, 0.0001 USDC: V5 and Across both refuse", "eip155:8453", "USDC", "eip155:42161", T.arbUsdc, "100"],
];

/** V5 answers carry a `chain` object (and logos) on every token: display only, never read. */
function trim(v) {
  if (Array.isArray(v)) return v.map(trim);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !["chain", "refundTo", "logoUrl", "explorerUrl", "publicRpcUrl"].includes(k)).map(([k, x]) => [k, trim(x)]));
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [name, note, from, sourceToken, to, destToken, amountIn, opts = {}] of CELLS) {
  if (ONLY && !ONLY.test(name)) continue;
  const calls = [];
  let nowMs = Date.now();
  const recording = async (url, init) => {
    const u = String(url);
    const res = await fetch(u, init);
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    const kind = u.startsWith("https://api.across.to/") ? "v5" : u.startsWith("https://app.across.to/api/suggested-fees") ? "suggested-fees" : "rpc";
    if (kind === "suggested-fees") nowMs = Date.now();
    const request = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      kind,
      url: kind === "rpc" ? rpcLabel[u] ?? "rpc" : u,
      method: init?.method ?? "GET",
      ...(request !== undefined ? {request: kind === "rpc" ? {method: request.method, params: request.params} : request} : {}),
      status: res.status,
      response: kind === "v5" ? trim(body) : kind === "rpc" ? {result: body?.result ? {number: body.result.number, timestamp: body.result.timestamp} : null} : body,
    });
    return new Response(text, {status: res.status, headers: res.headers});
  };
  const provider = acrossProvider({apiKey: () => KEY, fetchImpl: recording, ...(opts.floor ? {suggestedFeesUrl: null, rpcUrls: RPC} : {})});
  const dry = opts.dry === true;
  const params = {sourceChain: from, sourceToken, destChain: to, destToken, amountIn, destAddress: SUBJECT, refundAddress: SUBJECT, ...(dry ? {dry: true} : {sender: SUBJECT, dry: false})};
  let refusal = null;
  const q = await provider.getQuote({...params, onRefusal: (r, info) => { refusal = {text: r, reason: info?.reason ?? null}; }});
  const result = q
    ? {
      outputAmount: q.destAmount, fee: (BigInt(amountIn) - BigInt(q.destAmount)).toString(), priceSource: q.providerData.priceSource,
      v5Fee: q.providerData.v5Fee, relayerFee: q.providerData.relayerFee, quoteTimestamp: Number(q.providerData.quoteTimestamp), fillDeadline: Number(q.providerData.fillDeadline),
      etaSeconds: q.etaSeconds, placeholder: q.providerData.placeholder === "1",
    }
    : {refusal};
  const fixture = {note: `${note}. Recorded ${new Date(nowMs).toISOString()} through acrossProvider (dist), the subject a public address; nothing signed or sent.`, nowMs, params, floor: opts.floor === true, calls, result};
  const json = JSON.stringify(fixture, null, 1) + "\n";
  if (json.includes(KEY)) throw new Error(`${name}: the fixture would contain the key — not written`);
  writeFileSync(join(OUT, `${name}.json`), json);
  console.log(name.padEnd(26), q ? `out ${result.outputAmount} fee ${result.fee} (${result.priceSource}; V5 net ${result.v5Fee}, relayer ${result.relayerFee})` : `refused: ${refusal?.text} [${refusal?.reason}]`);
  await sleep(1300);
}
