#!/usr/bin/env node
// Read-only. Nothing is signed or sent.
//
//  1. Always, keyless, on every pinned chain over a public RPC: the chain id; the SpokePool is a proxy with an
//     implementation, answers its own chainId(), names the HubPool as crossDomainAdmin(), the pinned
//     wrappedNativeToken(), the 3600 s / 21600 s buffers and pausedDeposits() false; every pinned token's decimals();
//     and on Ethereum the HubPool's crossChainContracts(chainId) names the pinned SpokePool. Any difference is "BAD":
//     a pin to review before a deposit is signed against it.
//  2. Keyless too: Across's /suggested-fees answers a plain deposit on the corridors below, on the pinned SpokePools
//     (the relayer price the module stands behind while Across serves it). A corridor it does not answer prints a
//     "FAILED" line, which the watch's canary reports as "warn": the provider then prices from the pinned floor where
//     it covers the route and refuses the rest, and the app's own read stands on the floor alike. A corridor Across
//     refuses (a 400, another SpokePool) is "BAD" and fails the run: the module would refuse every quote on it.
//  3. Only with ACROSS_API_KEY (the Across API V5 key): live quotes for the corridors below through the provider —
//     priced by the rule, built, held to the request by acrossPins and preflighted — and once through the real server
//     handler and acrossRemoteProvider (remote mode). Without the key this part is skipped with a neutral line and the
//     script exits 0 (CI has no key).
//
//   pnpm build && node scripts/verify-live.mjs [--no-chain] [--no-quotes] [--only REGEX]
// ACROSS_API_KEY is read from the environment only and sent only as the bearer header; it is never printed.
// RPC_<chainId>=url overrides a public endpoint.
import {ACROSS_CHAINS, ACROSS_HUB_POOL, ACROSS_SUGGESTED_FEES_URL, acrossPins, acrossProvider, acrossRemoteProvider, acrossRouteOf, acrossSuggestedFeesQuery, readAcrossSuggestedFees} from "../dist/index.js";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";

const args = process.argv.slice(2);
const ONLY = args.includes("--only") ? new RegExp(args[args.indexOf("--only") + 1]) : null;
const KEY = process.env.ACROSS_API_KEY;
const PUBLIC_RPC = {
  1: "https://ethereum-rpc.publicnode.com", 10: "https://optimism-rpc.publicnode.com", 130: "https://unichain-rpc.publicnode.com", 137: "https://polygon-bor-rpc.publicnode.com",
  143: "https://rpc.monad.xyz", 324: "https://mainnet.era.zksync.io", 480: "https://worldchain-mainnet.g.alchemy.com/public", 999: "https://rpc.hyperliquid.xyz/evm",
  4326: "https://mainnet.megaeth.com/rpc", 4663: "https://rpc.mainnet.chain.robinhood.com", 5042: "https://rpc.mainnet.arc.io", 8453: "https://base-rpc.publicnode.com",
  9745: "https://rpc.plasma.to", 42161: "https://arbitrum-one-rpc.publicnode.com", 43114: "https://avalanche-c-chain-rpc.publicnode.com", 57073: "https://rpc-gel.inkonchain.com",
  59144: "https://rpc.linea.build",
};
const rpcFor = (id) => process.env[`RPC_${id}`] || PUBLIC_RPC[id];
const SLOT_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const lc = (s) => String(s ?? "").toLowerCase();
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const addressOf = (w) => (typeof w === "string" && /^0x0{24}[0-9a-fA-F]{40}$/.test(w) ? `0x${w.slice(26).toLowerCase()}` : null);
const uintOf = (w) => (typeof w === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(w) ? BigInt(w) : null);
const withTimeout = async (ms, run) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); try { return await run(c.signal); } finally { clearTimeout(t); } };
const call = (url, method, params) => withTimeout(15_000, async (signal) => {
  const r = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}), signal});
  const j = await r.json();
  if (j.error) throw new Error(String(j.error.message).slice(0, 80));
  return j.result;
});
const ethCall = (url, to, data) => call(url, "eth_call", [{to, data}, "latest"]);
let bad = 0;
let warn = 0;
const unreachable = [];

// ── 1. pins on chain, keyless ─────────────────────────────────────────────────
if (!args.includes("--no-chain")) {
  const hubRpc = rpcFor(1);
  await Promise.all(Object.values(ACROSS_CHAINS).filter((c) => !ONLY || ONLY.test(c.name)).map(async (c) => {
    const url = rpcFor(c.chainId);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const chainId = await call(url, "eth_chainId", []);
        const impl = addressOf(await call(url, "eth_getStorageAt", [c.spokePool, SLOT_IMPL, "latest"]));
        const spokeChainId = uintOf(await ethCall(url, c.spokePool, "0x9a8a0592"));
        const admin = addressOf(await ethCall(url, c.spokePool, "0x5285e058"));
        const wrapped = addressOf(await ethCall(url, c.spokePool, "0x17fcb39b"));
        const quoteBuffer = uintOf(await ethCall(url, c.spokePool, "0x57f6dcb8"));
        const fillBuffer = uintOf(await ethCall(url, c.spokePool, "0x079bd2c7"));
        const paused = uintOf(await ethCall(url, c.spokePool, "0x6068d6cb"));
        const decimals = [];
        for (const t of c.tokens) decimals.push([t.symbol, Number(uintOf(await ethCall(url, t.address, "0x313ce567")) ?? -1n), t.decimals]);
        const hub = await ethCall(hubRpc, ACROSS_HUB_POOL, `0x09474ae2${word(c.chainId)}`);
        const hubSpoke = typeof hub === "string" && hub.length >= 130 ? addressOf(`0x${hub.slice(66, 130)}`) : null;
        const checks = {
          chain: BigInt(chainId) === BigInt(c.chainId),
          proxy: !!impl && !/^0x0{40}$/.test(impl),
          spokeChainId: spokeChainId === BigInt(c.chainId),
          admin: admin === ACROSS_HUB_POOL,
          wrappedNative: (wrapped && /^0x0{40}$/.test(wrapped) ? null : wrapped) === c.wrappedNative,
          buffers: quoteBuffer === 3600n && fillBuffer === 21600n,
          notPaused: paused === 0n,
          decimals: decimals.every(([, got, want]) => got === want),
          hubRegistry: hubSpoke === c.spokePool,
        };
        const ok = Object.values(checks).every(Boolean);
        if (!ok) bad++;
        console.log(`${ok ? "ok " : "BAD"} chain   ${String(c.chainId).padEnd(6)} ${c.name.padEnd(16)} SpokePool ${c.spokePool} impl ${impl ?? "—"} · ${c.tokens.map((t) => t.symbol).join(", ")}`, ok ? "" : JSON.stringify(checks));
        return;
      } catch { /* second try */ }
    }
    unreachable.push(c.chainId);
    console.log(`??? chain   ${String(c.chainId).padEnd(6)} ${c.name.padEnd(16)} no RPC answered`);
  }));
}

const NATIVE = "0x0000000000000000000000000000000000000000";
// A public address: the subject of the quotes only (nothing is signed or sent).
const ME = "0xF977814e90dA44bFA03b6295A0616a897441aceC";
const CORRIDORS = [
  ["USDC Base → Arbitrum", "eip155:8453", "USDC", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "eip155:42161", "0xaf88d065e77c8cc2239327c5edb3a432268e5831", "25000000"],
  ["USDC Arbitrum → Base", "eip155:42161", "USDC", "0xaf88d065e77c8cc2239327c5edb3a432268e5831", "eip155:8453", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "25000000"],
  ["USDC Base → Optimism", "eip155:8453", "USDC", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "eip155:10", "0x0b2c639c533813f4aa9d7837caf62653d097ff85", "25000000"],
  ["ETH Base → Arbitrum", "eip155:8453", "ETH", NATIVE, "eip155:42161", NATIVE, "10000000000000000"],
  ["ETH Arbitrum → Base", "eip155:42161", "ETH", NATIVE, "eip155:8453", NATIVE, "10000000000000000"],
  ["ETH Optimism → Base", "eip155:10", "ETH", NATIVE, "eip155:8453", NATIVE, "10000000000000000"],
  ["ETH Ethereum → Base", "eip155:1", "ETH", NATIVE, "eip155:8453", NATIVE, "10000000000000000"],
  ["USDT Ethereum → USDT0 Arbitrum", "eip155:1", "USDT", "0xdac17f958d2ee523a2206206994597c13d831ec7", "eip155:42161", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", "25000000"],
  ["WBTC Ethereum → Arbitrum", "eip155:1", "WBTC", "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", "eip155:42161", "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f", "40000"],
].filter(([name]) => !ONLY || ONLY.test(name));
const pause = () => new Promise((r) => setTimeout(r, 1200));

if (!args.includes("--no-quotes")) {
  // ── 2. the relayer price, keyless ────────────────────────────────────────────
  for (const [name, src, , token, dst, out, amount] of CORRIDORS) {
    const route = acrossRouteOf(src, token, dst, out);
    const request = {sourceChain: src, destChain: dst, sourceToken: token, destToken: out, amount: BigInt(amount), depositor: ME, recipient: ME};
    try {
      const res = await withTimeout(15_000, (signal) => fetch(`${ACROSS_SUGGESTED_FEES_URL}?${acrossSuggestedFeesQuery(request, route)}`, {headers: {accept: "application/json"}, signal}));
      let body; try { body = await res.json(); } catch { body = undefined; }
      const r = readAcrossSuggestedFees(request, route, res.status, body, Math.floor(Date.now() / 1000));
      if (r.kind === "fees") console.log(`ok  fees    ${name.padEnd(32)} relayer fee ${r.totalRelayFee} of ${amount} (${(Number((r.totalRelayFee * 1_000_000n) / BigInt(amount)) / 100).toFixed(2)} bps), quote time ${Math.floor(Date.now() / 1000) - r.timestamp} s old`);
      else if (r.kind === "refused") { bad++; console.log(`BAD fees    ${name.padEnd(32)} ${r.detail} [${r.reason}]`); }
      else { warn++; console.log(`warn fees   ${name.padEnd(32)} /suggested-fees FAILED: unavailable (${r.detail}) — the pinned floor prices where it covers the route, the rest is refused`); }
    } catch (e) {
      warn++;
      console.log(`warn fees   ${name.padEnd(32)} /suggested-fees FAILED: no answer (${String(e?.name ?? e).slice(0, 40)})`);
    }
    await pause();
  }

  // ── 3. live quotes (needs the key) ──────────────────────────────────────────
  if (!KEY) {
    console.log("API corridors skipped: no ACROSS_API_KEY in the environment (on-chain and relayer-price checks only)");
  } else {
    const provider = acrossProvider({apiKey: () => process.env.ACROSS_API_KEY});
    const paramsOf = ([, src, sym, , dst, out, amount]) => ({sourceChain: src, sourceToken: sym, destChain: dst, destToken: out, amountIn: amount, destAddress: ME, refundAddress: ME, sender: ME, dry: false});
    for (const corridor of CORRIDORS) {
      const [name] = corridor;
      const params = paramsOf(corridor);
      const reasons = [];
      try {
        const q = await provider.getQuote({...params, onRefusal: (r, info) => reasons.push(`${r}${info?.reason ? ` [${info.reason}]` : ""}`)});
        if (!q) throw new Error(reasons.join("; ") || "null quote");
        const again = acrossPins.verifyQuote(params, q);
        if (again) throw new Error(`verifyQuote: ${again}`);
        const tx = await provider.buildDeposit(q);
        const built = acrossPins.verifyBuild(q, tx, params);
        if (built) throw new Error(`verifyBuild: ${built}`);
        await provider.preflightDeposit(q, tx);
        const amount = BigInt(params.amountIn);
        const bps = (v) => (Number((BigInt(v) * 1_000_000n) / amount) / 100).toFixed(2);
        console.log(`ok  quote   ${name.padEnd(32)} out ${q.destAmount} · fee ${bps(amount - BigInt(q.destAmount))} bps (V5 net ${bps(q.providerData.v5Fee)}, relayer ${bps(q.providerData.relayerFee)}, ${q.providerData.priceSource}) · ~${q.etaSeconds}s`);
      } catch (e) {
        bad++;
        console.log(`BAD quote   ${name.padEnd(32)} ${String(e?.message ?? e).replace(/https?:\/\/\S+/g, "<url>").replace(/\s+/g, " ").slice(0, 260)}`);
      }
      await pause();
    }
    // Remote mode once: the real provider behind the real server handler, every answer checked again on the "device".
    if (CORRIDORS[0] && (!ONLY || ONLY.test("remote"))) {
      try {
        const handle = createSwap2Handler({providers: [provider], sealSecret: crypto.getRandomValues(new Uint8Array(32)), guard: () => {}, subject: () => "verify-live"});
        // The app's fetch: the backend's actions to the handler; Across's relayer fee, which the app reads itself, to Across.
        const backend = async (url, init) => {
          if (!String(url).startsWith("https://backend.invalid/")) return fetch(url, init);
          const res = await handle(String(url).split("/").pop(), JSON.parse(String(init.body)), "verify-live");
          return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
        };
        const app = acrossRemoteProvider({baseUrl: "https://backend.invalid/api/swap2", fetchImpl: backend});
        const q = await app.getQuote(paramsOf(CORRIDORS[0]));
        if (!q || !/~[0-9a-f]{32}$/.test(q.intentId)) throw new Error("no sealed quote");
        const tx = await app.buildDeposit(q);
        if (lc(tx.data) !== lc(q.txRequest.data)) throw new Error("the build is not the quoted deposit");
        await app.preflightDeposit(q, tx);
        console.log(`ok  remote  ${CORRIDORS[0][0].padEnd(32)} through createSwap2Handler + acrossRemoteProvider (relayer fee read on the "device" too): out ${q.destAmount}`);
      } catch (e) {
        bad++;
        console.log(`BAD remote  ${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 260)}`);
      }
    }
  }
}

if (unreachable.length) console.log(`unreachable: ${unreachable.join(", ")} (public RPCs; set RPC_<chainId>)`);
console.log(bad ? `${bad} failing` : `all ok${warn ? ` (${warn} warnings)` : ""}`);
process.exit(bad ? 1 : 0);
