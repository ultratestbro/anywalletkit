#!/usr/bin/env node
// Read-only. Nothing is signed or sent, and no API key is needed (RELAY_API_KEY is sent as x-api-key when set).
//
//  1. Every pin in config.ts against Relay's `GET /chains`: the chain is listed, its `protocol.v2.chainId` is our slug,
//     its `protocol.v2.depository` is our depository, the pinned solver is among its `solverAddresses`.
//  2. Every pinned depository on chain over a public RPC: it has code, `allocator()` and `owner()` are the pinned ones,
//     the bytecode carries the three deposit selectors.
//  3. Live quotes for the corridors below through the provider (the order verified on the way), each then built and
//     preflighted — through `Swap2Router` as well.
//
//   node scripts/verify-live.mjs [--no-chain] [--no-quotes] [--only REGEX]
// RELAY_API=url points at another base; RPC_<chainId>=url overrides a public endpoint.
import {relayProvider} from "../dist/provider.js";
import {RELAY_ALLOCATOR, RELAY_API, RELAY_CHAINS, RELAY_DEPOSIT_ERC20, RELAY_DEPOSIT_ERC20_ALLOWANCE, RELAY_DEPOSIT_NATIVE, RELAY_OWNER, RELAY_SOLVERS} from "../dist/config.js";
import {relayVerifyQuote} from "../dist/verify.js";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router";

const args = process.argv.slice(2);
const ONLY = args.includes("--only") ? new RegExp(args[args.indexOf("--only") + 1]) : null;
const API = (process.env.RELAY_API ?? RELAY_API).replace(/\/+$/, "");
const KEY = process.env.RELAY_API_KEY;
const PUBLIC_RPC = {
  1: "https://ethereum-rpc.publicnode.com", 10: "https://optimism-rpc.publicnode.com", 56: "https://bsc-rpc.publicnode.com", 100: "https://gnosis-rpc.publicnode.com",
  130: "https://unichain-rpc.publicnode.com", 137: "https://polygon-bor-rpc.publicnode.com", 143: "https://rpc.monad.xyz", 146: "https://rpc.soniclabs.com",
  196: "https://rpc.xlayer.tech", 324: "https://mainnet.era.zksync.io", 480: "https://worldchain-mainnet.g.alchemy.com/public", 999: "https://rpc.hyperliquid.xyz/evm",
  2818: "https://rpc.morphl2.io", 4326: "https://mainnet.megaeth.com/rpc", 4663: "https://rpc.mainnet.chain.robinhood.com", 5000: "https://rpc.mantle.xyz",
  5042: "https://rpc.mainnet.arc.io", 8453: "https://base-rpc.publicnode.com", 9745: "https://rpc.plasma.to", 42161: "https://arbitrum-one-rpc.publicnode.com",
  42220: "https://forno.celo.org", 43114: "https://avalanche-c-chain-rpc.publicnode.com", 57073: "https://rpc-gel.inkonchain.com", 59144: "https://rpc.linea.build",
  80094: "https://rpc.berachain.com", 98866: "https://rpc.plume.org", 99901: "https://rpc.elysium.kinetiq.xyz", 534352: "https://rpc.scroll.io", 747474: "https://rpc.katana.network",
};
const lc = (s) => String(s ?? "").toLowerCase();
const withTimeout = async (ms, run) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); try { return await run(c.signal); } finally { clearTimeout(t); } };
let bad = 0;
const unreachable = [];

// ── 1. /chains ───────────────────────────────────────────────────────────────
const listed = await withTimeout(20_000, async (signal) => {
  const r = await fetch(`${API}/chains`, {headers: {accept: "application/json", ...(KEY ? {"x-api-key": KEY} : {})}, signal});
  if (!r.ok) throw new Error(`/chains → HTTP ${r.status}`);
  return (await r.json()).chains;
});
const byId = new Map(listed.map((c) => [c.id, c]));
const solver = lc(RELAY_SOLVERS[0].address);
for (const pin of Object.values(RELAY_CHAINS)) {
  const c = byId.get(pin.chainId);
  const checks = c ? {
    slug: c.protocol?.v2?.chainId === pin.slug,
    depository: lc(c.protocol?.v2?.depository) === pin.depository,
    solver: Array.isArray(c.solverAddresses) && c.solverAddresses.map(lc).includes(solver),
    evm: c.vmType === "evm",
  } : {listed: false};
  const ok = Object.values(checks).every(Boolean);
  if (!ok) bad++;
  const note = c?.disabled ? " (disabled on Relay)" : c?.depositEnabled === false ? " (deposits off on Relay)" : "";
  console.log(`${ok ? "ok " : "BAD"} /chains ${String(pin.chainId).padEnd(7)} ${pin.slug.padEnd(11)} ${pin.depository}${note}`, ok ? "" : {checks, theirs: c?.protocol?.v2});
}
// An EVM chain of Relay with a depository that is not pinned: only said, never a failure (the SDK may not carry it).
const unpinned = listed.filter((c) => c.vmType === "evm" && c.protocol?.v2?.depository && !RELAY_CHAINS[`eip155:${c.id}`] && !c.disabled);
console.log(`/chains: ${listed.length} chains, ${Object.keys(RELAY_CHAINS).length} pinned, ${unpinned.length} more EVM chains with a depository are not pinned`);

// ── 2. the depositories on chain ─────────────────────────────────────────────
if (!args.includes("--no-chain")) {
  const call = (url, method, params) => withTimeout(12_000, async (signal) => {
    const r = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}), signal});
    const j = await r.json();
    if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 120));
    return j.result;
  });
  await Promise.all(Object.values(RELAY_CHAINS).map(async (pin) => {
    // Relay's own RPC for the chain is the fallback; each endpoint gets a second try.
    const one = [process.env[`RPC_${pin.chainId}`], PUBLIC_RPC[pin.chainId], byId.get(pin.chainId)?.httpRpcUrl].filter(Boolean);
    const urls = [...one, ...one];
    for (const url of urls) {
      try {
        // One call at a time: public endpoints throttle a burst.
        const chainId = await call(url, "eth_chainId", []);
        const code = await call(url, "eth_getCode", [pin.depository, "latest"]);
        const allocator = await call(url, "eth_call", [{to: pin.depository, data: "0xaa5dcecc"}, "latest"]);
        const owner = await call(url, "eth_call", [{to: pin.depository, data: "0x8da5cb5b"}, "latest"]);
        const checks = {
          chain: BigInt(chainId) === BigInt(pin.chainId),
          code: code.length > 2,
          allocator: `0x${allocator.slice(-40)}` === RELAY_ALLOCATOR,
          owner: `0x${owner.slice(-40)}` === RELAY_OWNER,
          selectors: [RELAY_DEPOSIT_NATIVE, RELAY_DEPOSIT_ERC20, RELAY_DEPOSIT_ERC20_ALLOWANCE].every((s) => code.includes(s.slice(2))),
        };
        const ok = Object.values(checks).every(Boolean);
        if (!ok) bad++;
        console.log(`${ok ? "ok " : "BAD"} chain   ${String(pin.chainId).padEnd(7)} ${pin.name.padEnd(15)} ${(code.length - 2) / 2} bytes`, ok ? "" : checks);
        return;
      } catch { /* next endpoint */ }
    }
    unreachable.push(pin.chainId);
    console.log(`??? chain   ${String(pin.chainId).padEnd(7)} ${pin.name.padEnd(15)} no RPC answered`);
  }));
}

// ── 3. live quotes, verified, built, preflighted ─────────────────────────────
if (!args.includes("--no-quotes")) {
  const NATIVE = "0x0000000000000000000000000000000000000000";
  const USDC = {1: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 10: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", 137: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", 8453: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 42161: "0xaf88d065e77c8cc2239327c5edb3a432268e5831"};
  const USDT = {1: "0xdac17f958d2ee523a2206206994597c13d831ec7", 42161: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"};
  // A watch address of ours: it holds nothing, receives nothing here, and is not the pricing placeholder.
  const me = "0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA";
  const corridors = [
    ["Arbitrum USDC → Elysium HYPE", 42161, USDC[42161], 99901, NATIVE, "25000000"],
    ["Base ETH → Arbitrum ETH", 8453, NATIVE, 42161, NATIVE, "5000000000000000"],
    ["OP Mainnet ETH → Base ETH", 10, NATIVE, 8453, NATIVE, "5000000000000000"],
    ["Arbitrum USDC → Base USDC", 42161, USDC[42161], 8453, USDC[8453], "25000000"],
    ["Base USDC → OP Mainnet USDC", 8453, USDC[8453], 10, USDC[10], "25000000"],
    ["Ethereum USDT → Base USDC", 1, USDT[1], 8453, USDC[8453], "50000000"],
    ["Ethereum USDC → Arbitrum USDT", 1, USDC[1], 42161, USDT[42161], "50000000"],
    ["Polygon USDC → Base ETH", 137, USDC[137], 8453, NATIVE, "25000000"],
    ["BNB Chain BNB → Arbitrum ETH", 56, NATIVE, 42161, NATIVE, "20000000000000000"],
    ["Linea ETH → Base ETH", 59144, NATIVE, 8453, NATIVE, "5000000000000000"],
    ["HyperEVM HYPE → Elysium HYPE", 999, NATIVE, 99901, NATIVE, "500000000000000000"],
    ["Base ETH → Mantle MNT", 8453, NATIVE, 5000, NATIVE, "5000000000000000"],
  ].filter(([name]) => !ONLY || ONLY.test(name));
  const provider = relayProvider({baseUrl: API, ...(KEY ? {apiKey: KEY} : {})});
  const router = new CrossChainRouter([relayProvider({baseUrl: API, ...(KEY ? {apiKey: KEY} : {})})]);
  for (const [name, from, sourceToken, to, destToken, amountIn] of corridors) {
    const params = {sourceChain: `eip155:${from}`, sourceToken, destChain: `eip155:${to}`, destToken, amountIn, destAddress: me, refundAddress: me, dry: false};
    const reasons = [];
    try {
      const q = await provider.getQuote({...params, onRefusal: (r) => reasons.push(r)});
      if (!q) throw new Error(reasons.join("; ") || "null quote");
      // The same check a remote client runs, a second time and apart from the provider.
      const again = relayVerifyQuote(params, q);
      if (again) throw new Error(`verifyQuote: ${again}`);
      const tx = await provider.buildDeposit(q);
      await provider.preflightDeposit(q, tx);
      // Through the router: its own quote (another order), verified, built and preflighted by the dispatched provider.
      const routed = await router.getBestQuote(params);
      if (!routed || routed.provider !== "relay") throw new Error(`router: no relay quote (${router.lastRejections?.join("; ") ?? ""})`);
      const routedWhy = relayVerifyQuote(params, routed);
      if (routedWhy) throw new Error(`router verifyQuote: ${routedWhy}`);
      const via = router.getProvider("relay");
      await via.preflightDeposit(routed, await via.buildDeposit(routed));
      console.log(`ok  quote   ${name.padEnd(30)} out ${q.destAmount} min ${q.minDestAmount} · ${tx.data.slice(0, 10)} → ${tx.to}${tx.approvalAddress ? " (approve)" : ""} · ~${q.etaSeconds ?? "?"}s · router ok`);
    } catch (e) {
      bad++;
      console.log(`BAD quote   ${name.padEnd(30)} ${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 260)}`);
    }
  }
}
console.log(bad ? `FAILED (${bad})` : `ok${unreachable.length ? ` — no RPC for ${unreachable.join(", ")}` : ""}`);
process.exit(bad ? 1 : 0);
