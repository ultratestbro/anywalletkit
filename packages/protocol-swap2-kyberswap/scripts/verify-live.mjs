#!/usr/bin/env node
// Read-only. Nothing is signed or sent.
//
//  1. On every chain in KYBER_CHAINS over a public RPC (RPC_<chainId> overrides): MetaAggregationRouterV2 and the
//     executor have code; the router build matches the pin (`generic` has swapGeneric and the whitelist, `lite` has
//     neither); swap() is present; the owner is printed (EOA or contract).
//  2. Keyless (or with KYBERSWAP_API_KEY from the environment, never printed, through the keyed gateway), through the provider: for each chain a stablecoin → native (or stable → stable where native swaps are
//     off) execution quote — routes + build, the calldata checked by checkKyberTransaction, a native-input build also
//     simulated with a balance override — then the same back; each quote held to the request by kyberVerifyQuote.
//     Requests are paced (the public API allows 3 per second per IP).
//
//   node scripts/verify-live.mjs [--no-chain] [--no-quotes] [--only REGEX]
import {CC_SOURCE_CHAINS} from "@anywalletkit/swap2-assets";
import {KYBER_CHAINS, KYBER_EXECUTOR, KYBER_ROUTER_V2, kyberNativeSwaps, kyberVerifyQuote, kyberswapProvider} from "../dist/index.js";

const args = process.argv.slice(2);
const ONLY = args.includes("--only") ? new RegExp(args[args.indexOf("--only") + 1]) : null;
const PUBLIC_RPC = {
  1: "https://ethereum-rpc.publicnode.com", 8453: "https://base-rpc.publicnode.com", 56: "https://bsc-rpc.publicnode.com",
  42161: "https://arbitrum-one-rpc.publicnode.com", 10: "https://optimism-rpc.publicnode.com", 137: "https://polygon-bor-rpc.publicnode.com",
  43114: "https://avalanche-c-chain-rpc.publicnode.com", 59144: "https://rpc.linea.build", 146: "https://rpc.soniclabs.com",
  80094: "https://rpc.berachain.com", 130: "https://unichain-rpc.publicnode.com", 999: "https://rpc.hyperliquid.xyz/evm",
  9745: "https://rpc.plasma.to", 143: "https://rpc.monad.xyz", 4326: "https://mainnet.megaeth.com/rpc",
  4663: "https://rpc.mainnet.chain.robinhood.com", 5042: "https://rpc.mainnet.arc.io", 99901: "https://rpc.elysium.kinetiq.xyz",
};
const rpcFor = (id) => process.env[`RPC_${id}`] || PUBLIC_RPC[id];
const ids = Object.keys(KYBER_CHAINS).map(Number).filter((id) => !ONLY || ONLY.test(`${id} ${KYBER_CHAINS[id].slug}`));
const SENDER = "0x1111111111111111111111111111111111111111";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (url, method, params) => {
  const res = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}), signal: AbortSignal.timeout(15_000)});
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
};
let failed = 0;
const bad = (msg) => { failed++; console.log(`  ✗ ${msg}`); };

if (!args.includes("--no-chain")) {
  console.log("1. contracts");
  for (const id of ids) {
    const c = KYBER_CHAINS[id], url = rpcFor(id);
    try {
      const [router, executor] = await Promise.all([call(url, "eth_getCode", [KYBER_ROUTER_V2, "latest"]), call(url, "eth_getCode", [KYBER_EXECUTOR, "latest"])]);
      const code = router.toLowerCase();
      const generic = code.includes("6359e50fed"), whitelist = code.includes("63c683630d"), swap = code.includes("63e21fd0e9");
      const owner = `0x${(await call(url, "eth_call", [{to: KYBER_ROUTER_V2, data: "0x8da5cb5b"}, "latest"])).slice(26)}`;
      const ownerCode = await call(url, "eth_getCode", [owner, "latest"]);
      const kind = ownerCode === "0x" ? "EOA" : ownerCode.startsWith("0xef0100") ? "EOA (EIP-7702 delegated)" : `contract ${(ownerCode.length - 2) / 2} B`;
      const ok = router.length > 2 && executor.length > 2 && swap && (c.build === "generic" ? generic && whitelist : !generic && !whitelist);
      console.log(`  ${ok ? "✓" : "✗"} ${c.name}: router ${(router.length - 2) / 2} B (${generic ? "with" : "no"} swapGeneric), executor ${(executor.length - 2) / 2} B, owner ${owner} (${kind})`);
      if (!ok) failed++;
    } catch (e) {
      bad(`${c.name}: ${String(e.message).slice(0, 100)}`);
    }
  }
}

if (!args.includes("--no-quotes")) {
  // KYBERSWAP_API_KEY (environment only, never printed): the same checks through KyberSwap's keyed API gateway.
  const apiKey = process.env.KYBERSWAP_API_KEY || undefined;
  console.log(`2. quotes and builds (${apiKey ? "API key, api.kyberswap.com/swap" : "keyless"})`);
  const rpcUrls = Object.fromEntries(ids.map((id) => [id, [rpcFor(id)]]));
  const kyber = kyberswapProvider({rpcUrls, clientId: "anywalletkit-verify", ...(apiKey ? {apiKey} : {})});
  const stableOf = (assets) => ["USDC", "USDT0", "USDT", "USDC.e"].map((s) => assets.find((a) => a.symbol === s && a.contract)).find(Boolean);
  for (const id of ids) {
    const caip2 = `eip155:${id}`, assets = CC_SOURCE_CHAINS.find((c) => c.caip2 === caip2)?.assets ?? [];
    const stable = stableOf(assets);
    const other = kyberNativeSwaps(id) ? assets.find((a) => !a.contract) : assets.find((a) => a.contract && a !== stable && /^(USD|WETH|EURC)/.test(a.symbol));
    if (!stable || !other) { console.log(`  – ${KYBER_CHAINS[id].name}: no corridor in the catalog`); continue; }
    const leg = async (from, to, amount) => {
      const why = [];
      const params = {sourceChain: caip2, sourceToken: from.symbol, destChain: caip2, destToken: to.contract ?? "0x0000000000000000000000000000000000000000", amountIn: amount.toString(), destAddress: SENDER, refundAddress: SENDER, sender: SENDER, slippageBps: 50, dry: false, onRefusal: (r, i) => why.push(`${r}${i?.reason ? ` [${i.reason}]` : ""}`)};
      const t = Date.now();
      const q = await kyber.getQuote(params);
      await sleep(800);
      if (!q) { bad(`${KYBER_CHAINS[id].name} ${from.symbol} → ${to.symbol}: ${why.join("; ").slice(0, 160)}`); return null; }
      const verdict = kyberVerifyQuote(params, q);
      if (verdict) { bad(`${KYBER_CHAINS[id].name} ${from.symbol} → ${to.symbol}: kyberVerifyQuote: ${verdict}`); return null; }
      const bps = ((BigInt(q.destAmount) - BigInt(q.minDestAmount)) * 10_000n) / BigInt(q.destAmount);
      console.log(`  ✓ ${KYBER_CHAINS[id].name} ${from.symbol} → ${to.symbol}: ${q.destAmount} (min ${q.minDestAmount}, ${bps} bps), ${q.txRequest.data.length / 2 - 1} B calldata, ${Date.now() - t} ms${q.providerData?.sources ? `, via ${q.providerData.sources}` : ""}`);
      return q;
    };
    const there = await leg(stable, other, 20n * 10n ** BigInt(stable.decimals));
    if (there) await leg(other, stable, BigInt(there.minDestAmount));
  }
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
