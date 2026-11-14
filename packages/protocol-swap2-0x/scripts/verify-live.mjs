#!/usr/bin/env node
// Read-only. Nothing is signed or sent.
//
//  1. Always, keyless, on all seven chains over a public RPC: the chain id; the Settler registry is an ERC-1967 proxy
//     with an implementation that has code and an owner(); ownerOf(2) (and prev(2) when there is one) name contracts
//     with code that are CREATE3 deployments of the registry (zeroExSettlerNonce); Permit2 and the wrapped native have code.
//     The pin: the deployment in force must be no newer than the newest one pinned in src/chains.ts (maxSettlerNonce
//     minus ZEROEX_SETTLER_NONCE_MARGIN). A newer one is 0x deploying: the device still accepts it inside the margin,
//     but this run fails ("NEW") until the pin is raised — past the margin the device refuses it ("PIN").
//  2. Only with ZEROEX_API_KEY: live quotes for the corridors below through the provider — the Settler call and the
//     Permit2 payload checked on the way — then held to the request by zeroExVerifyQuote, built, checked by
//     zeroExVerifyBuild and preflighted; and once through the real server handler and zeroExRemoteProvider (remote mode).
//     Without the key this part is skipped with a neutral line and the script exits 0 (CI has no key).
//
//   node scripts/verify-live.mjs [--no-chain] [--no-quotes] [--only REGEX]
// ZEROEX_API_KEY is read from the environment only and sent only as the 0x-api-key header; it is never printed.
// RPC_<chainId>=url overrides a public endpoint.
import {ZEROEX_CHAINS, ZEROEX_PERMIT2, ZEROEX_SETTLER_LOOKAHEAD, ZEROEX_SETTLER_NONCE_MARGIN, createSettlerResolver, zeroExProvider, zeroExRemoteProvider, zeroExSettlerNonce, zeroExVerifyBuild, zeroExVerifyQuote} from "../dist/index.js";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";

const args = process.argv.slice(2);
const ONLY = args.includes("--only") ? new RegExp(args[args.indexOf("--only") + 1]) : null;
const KEY = process.env.ZEROEX_API_KEY;
const PUBLIC_RPC = {
  1: "https://ethereum-rpc.publicnode.com", 10: "https://optimism-rpc.publicnode.com", 56: "https://bsc-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com", 8453: "https://base-rpc.publicnode.com", 42161: "https://arbitrum-one-rpc.publicnode.com",
  43114: "https://avalanche-c-chain-rpc.publicnode.com",
};
const rpcFor = (id) => process.env[`RPC_${id}`] || PUBLIC_RPC[id];
const rpcUrls = Object.fromEntries(Object.keys(ZEROEX_CHAINS).map((id) => [id, [rpcFor(id)]]));
const SLOT_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const lc = (s) => String(s ?? "").toLowerCase();
const word2 = "0000000000000000000000000000000000000000000000000000000000000002";
const addressOf = (w) => (typeof w === "string" && /^0x0{24}[0-9a-fA-F]{40}$/.test(w) && !/^0x0{64}$/.test(w) ? `0x${w.slice(26)}` : null);
const withTimeout = async (ms, run) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); try { return await run(c.signal); } finally { clearTimeout(t); } };
const call = (url, method, params) => withTimeout(12_000, async (signal) => {
  const r = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}), signal});
  const j = await r.json();
  if (j.error) return {reverted: /revert/i.test(String(j.error.message)), message: String(j.error.message).slice(0, 80)};
  return {result: j.result};
});
let bad = 0;
const unreachable = [];

// ── 1. on chain, keyless ─────────────────────────────────────────────────────
if (!args.includes("--no-chain")) {
  await Promise.all(Object.entries(ZEROEX_CHAINS).map(async ([id, chain]) => {
    const url = rpcFor(id);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // One call at a time: public endpoints throttle a burst.
        const chainId = await call(url, "eth_chainId", []);
        if (!chainId.result) throw new Error("no chain id");
        const proxyCode = (await call(url, "eth_getCode", [chain.registry, "latest"])).result ?? "0x";
        const impl = addressOf((await call(url, "eth_getStorageAt", [chain.registry, SLOT_IMPL, "latest"])).result);
        const implCode = impl ? (await call(url, "eth_getCode", [impl, "latest"])).result ?? "0x" : "0x";
        const owner = addressOf((await call(url, "eth_call", [{to: chain.registry, data: "0x8da5cb5b"}, "latest"])).result);
        const current = addressOf((await call(url, "eth_call", [{to: chain.registry, data: `0x6352211e${word2}`}, "latest"])).result);
        const prevAnswer = await call(url, "eth_call", [{to: chain.registry, data: `0xe2603dc2${word2}`}, "latest"]);
        const prev = addressOf(prevAnswer.result);
        const codeOf = async (a) => (a ? ((await call(url, "eth_getCode", [a, "latest"])).result ?? "0x").length > 2 : false);
        // Derived past the pin too, so a newer 0x deployment is named rather than called "not a Settler".
        const nonceOf = (a) => (a ? zeroExSettlerNonce(Number(id), a, chain.registry, chain.maxSettlerNonce + ZEROEX_SETTLER_LOOKAHEAD) : null);
        const nonce = nonceOf(current);
        const pinnedNewest = chain.maxSettlerNonce - ZEROEX_SETTLER_NONCE_MARGIN;
        const checks = {
          chain: BigInt(chainId.result) === BigInt(id),
          registryIsProxy: proxyCode.length > 2 && !!impl && implCode.length > 2,
          owner: !!owner,
          settler: nonce !== null && (await codeOf(current)),
          previous: prevAnswer.reverted || (nonceOf(prev) !== null && (await codeOf(prev))),
          permit2: await codeOf(ZEROEX_PERMIT2),
          wrappedNative: await codeOf(chain.wrappedNative),
          // the device refuses a deployment past maxSettlerNonce; one past the pinned newest means the pin is stale
          withinPin: nonce !== null && nonce <= chain.maxSettlerNonce,
          pinCurrent: nonce !== null && nonce <= pinnedNewest,
        };
        const ok = Object.values(checks).every(Boolean);
        if (!ok) bad++;
        const tag = ok ? "ok " : nonce !== null && checks.settler && !checks.withinPin ? "PIN" : nonce !== null && checks.settler && checks.withinPin && !checks.pinCurrent ? "NEW" : "BAD";
        const pin = `pinned newest ${pinnedNewest}, accepted up to ${chain.maxSettlerNonce}`;
        const advice = tag === "NEW" ? ` — 0x deployed Settler ${nonce}: check it, then raise maxSettlerNonce for chain ${id} in src/chains.ts` : tag === "PIN" ? ` — the device refuses Settler ${nonce} until maxSettlerNonce for chain ${id} is raised in src/chains.ts` : "";
        console.log(`${tag} chain   ${id.padEnd(6)} ${chain.name.padEnd(16)} Settler ${current ?? "—"} (deployment ${nonce ?? "?"}; ${pin})${prev ? `, previous ${prev}` : ""} · registry impl ${impl ?? "—"} owner ${owner ?? "—"}${advice}`, ok || tag !== "BAD" ? "" : checks);
        return;
      } catch { /* second try */ }
    }
    unreachable.push(id);
    console.log(`??? chain   ${id.padEnd(6)} ${chain.name.padEnd(16)} no RPC answered`);
  }));
}

// ── 2. live quotes (needs the key) ───────────────────────────────────────────
if (!args.includes("--no-quotes")) {
  if (!KEY) {
    console.log("API corridors skipped: no ZEROEX_API_KEY in the environment (on-chain checks only)");
  } else {
    const NATIVE = "0x0000000000000000000000000000000000000000";
    // A watch address of ours: it holds nothing, receives nothing here.
    const me = "0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA";
    const corridors = [
      ["Base USDC → ETH (Permit2)", 8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6, NATIVE, "25000000"],
      ["Base ETH → USDC (native)", 8453, NATIVE, 18, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "8000000000000000"],
      ["Ethereum USDT → USDC (Permit2)", 1, "0xdAC17F958D2ee523a2206206994597C13D831ec7", 6, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "50000000"],
      ["Arbitrum USDC → ETH (Permit2)", 42161, "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", 6, NATIVE, "25000000"],
      ["Optimism ETH → USDC (native)", 10, NATIVE, 18, "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", "8000000000000000"],
      ["Polygon USDC → POL (Permit2)", 137, "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", 6, NATIVE, "25000000"],
      ["Avalanche USDC → AVAX (Permit2)", 43114, "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", 6, NATIVE, "25000000"],
      ["BNB Smart Chain USDT → BNB (Permit2)", 56, "0x55d398326f99059fF775485246999027B3197955", 18, NATIVE, "25000000000000000000"],
    ].filter(([name]) => !ONLY || ONLY.test(name));
    const resolver = createSettlerResolver({chains: ZEROEX_CHAINS, rpcUrls});
    const provider = zeroExProvider({apiKey: () => process.env.ZEROEX_API_KEY, rpcUrls, settlerResolver: resolver});
    const pause = () => new Promise((r) => setTimeout(r, 1200)); // stay well under the API's rate limit
    const paramsOf = ([, id, sourceToken, decimals, destToken, amountIn]) => ({
      sourceChain: `eip155:${id}`, destChain: `eip155:${id}`, sourceToken, ...(sourceToken === NATIVE ? {} : {sourceDecimals: decimals}),
      destToken, amountIn, slippageBps: 50, destAddress: me, refundAddress: me, dry: false,
    });
    for (const corridor of corridors) {
      const [name, id] = corridor;
      const params = paramsOf(corridor);
      const reasons = [];
      try {
        const q = await provider.getQuote({...params, onRefusal: (r, info) => reasons.push(`${r}${info?.reason ? ` [${info.reason}]` : ""}`)});
        if (!q) throw new Error(reasons.join("; ") || "null quote");
        // The checks a remote client runs, a second time and apart from the provider.
        const settlers = await resolver.resolve(id, {fresh: true});
        const ctx = {chains: ZEROEX_CHAINS, settlers: () => settlers};
        const again = zeroExVerifyQuote(params, q, ctx);
        if (again) throw new Error(`verifyQuote: ${again}`);
        const tx = await provider.buildDeposit(q);
        const built = await zeroExVerifyBuild(q, tx, params, {...ctx, resolver});
        if (built) throw new Error(`verifyBuild: ${built}`);
        await provider.preflightDeposit(q, tx);
        console.log(`ok  quote   ${name.padEnd(38)} out ${q.destAmount} min ${q.minDestAmount} · ${tx.to}${tx.approvalAddress ? " (Permit2 approve + signature)" : " (value)"} · ${q.providerData?.sources ?? "?"}`);
      } catch (e) {
        bad++;
        console.log(`BAD quote   ${name.padEnd(38)} ${String(e?.message ?? e).replace(/https?:\/\/\S+/g, "<url>").replace(/\s+/g, " ").slice(0, 260)}`);
      }
      await pause();
    }
    // Remote mode once: the real provider behind the real server handler, every answer checked again on the "device".
    if (!ONLY || ONLY.test("remote")) {
      const corridor = corridors[0] ?? null;
      if (corridor) {
        try {
          const handle = createSwap2Handler({providers: [provider], sealSecret: crypto.getRandomValues(new Uint8Array(32)), guard: () => {}, subject: () => "verify-live"});
          const backend = async (url, init) => {
            const res = await handle(String(url).split("/").pop(), JSON.parse(String(init.body)), "verify-live");
            return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
          };
          const app = zeroExRemoteProvider({baseUrl: "https://backend.invalid/api/swap2", fetchImpl: backend, rpcUrls});
          const q = await app.getQuote(paramsOf(corridor));
          if (!q) throw new Error("null quote");
          const tx = await app.buildDeposit(q);
          console.log(`ok  remote  ${corridor[0].padEnd(38)} through createSwap2Handler → zeroExRemoteProvider · ${tx.to}`);
        } catch (e) {
          bad++;
          console.log(`BAD remote  ${String(e?.message ?? e).replace(/https?:\/\/\S+/g, "<url>").replace(/\s+/g, " ").slice(0, 260)}`);
        }
      }
    }
  }
}
console.log(bad ? `FAILED (${bad})` : `ok${unreachable.length ? ` — no RPC for ${unreachable.join(", ")}` : ""}`);
process.exit(bad ? 1 : 0);
