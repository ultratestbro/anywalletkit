#!/usr/bin/env node
// Read-only. Nothing is signed or sent.
//
//  1. Always, keyless, on every chain of the table (eight) over a public RPC: the chain id; the Settler registry is an ERC-1967 proxy
//     with an implementation that has code and an owner(); ownerOf(2) (and prev(2) when there is one) name contracts
//     with code that are CREATE3 deployments of the registry (zeroExSettlerNonce); Permit2 and the wrapped native have code.
//     The pins: the registry must name exactly the current and previous deployments pinned in src/chains.ts
//     (newestLiveNonce / previousLiveNonce; verdict in pin-status.mjs). A newer one is 0x deploying: native-coin sales
//     to it are refused from that day, token sales still use it inside ZEROEX_SETTLER_NONCE_MARGIN, and this run fails
//     ("NEW") until the pins are raised — past the margin every sale is refused ("PIN"). A rollback ("OLD") or another
//     previous Settler ("PREV") fails it too, and so does a chain no RPC answered on: its pins are unchecked, so it is
//     a failure, never an ok. A read the RPC did not answer — a JSON-RPC error that is not a revert (a rate limit), no
//     result, an answer for another chain — fails the attempt, and the next URL (or the same one, a second later) is
//     tried; it is never read as the registry's word (a revert is: a paused registry reverts ownerOf(2)).
//  2. Only with ZEROEX_API_KEY: live quotes for the corridors below through the provider — the Settler call and the
//     Permit2 payload checked on the way — then held to the request by zeroExVerifyQuote, built, checked by
//     zeroExVerifyBuild and preflighted; and a token and a native sale through the real server handler and
//     zeroExRemoteProvider (remote mode: quote, build, preflight).
//     Without the key this part is skipped with a neutral line (CI has no key).
//  3. A run that fails ends with `FAILED (n)` and a `Reason:` line naming every chain that is not ok, by verdict
//     (`Reason: NEW on 1, 10, 56`): a reader that keeps only the last lines (the canary's note, Telegram) still has
//     every chain. When a sale through the Settler in force is refused today on a chain that answered, a
//     `Severity: high` line follows (pin-status.mjs, runSummary). Exit 1; a clean run prints `ok` and exits 0.
//
//   node scripts/verify-live.mjs [--no-chain] [--no-quotes] [--only REGEX]
// ZEROEX_API_KEY is read from the environment only and sent only as the 0x-api-key header; it is never printed.
// RPC_<chainId>=url[,url] overrides a public endpoint (the first answers the chain checks, the next is the retry); URLs
// are never printed.
import {ZEROEX_CHAINS, ZEROEX_PERMIT2, ZEROEX_SETTLER_LOOKAHEAD, ZEROEX_SETTLER_NONCE_MARGIN, createSettlerResolver, zeroExProvider, zeroExRemoteProvider, zeroExSettlerNonce, zeroExVerifyBuild, zeroExVerifyQuote} from "../dist/index.js";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {pinStatus, runSummary} from "./pin-status.mjs";

const args = process.argv.slice(2);
const ONLY = args.includes("--only") ? new RegExp(args[args.indexOf("--only") + 1]) : null;
const KEY = process.env.ZEROEX_API_KEY;
const PUBLIC_RPC = {
  1: "https://ethereum-rpc.publicnode.com", 10: "https://optimism-rpc.publicnode.com", 56: "https://bsc-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com", 8453: "https://base-rpc.publicnode.com", 42161: "https://arbitrum-one-rpc.publicnode.com",
  43114: "https://avalanche-c-chain-rpc.publicnode.com", 143: "https://rpc.monad.xyz",
};
const rpcsFor = (id) => String(process.env[`RPC_${id}`] || PUBLIC_RPC[id] || "").split(",").map((u) => u.trim()).filter(Boolean);
const rpcUrls = Object.fromEntries(Object.keys(ZEROEX_CHAINS).map((id) => [id, rpcsFor(id)]));
const SLOT_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const lc = (s) => String(s ?? "").toLowerCase();
const word2 = "0000000000000000000000000000000000000000000000000000000000000002";
const addressOf = (w) => (typeof w === "string" && /^0x0{24}[0-9a-fA-F]{40}$/.test(w) && !/^0x0{64}$/.test(w) ? `0x${w.slice(26)}` : null);
const withTimeout = async (ms, run) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); try { return await run(c.signal); } finally { clearTimeout(t); } };
const cleanText = (s) => String(s ?? "").replace(/https?:\/\/\S+/g, "<url>").replace(/\s+/g, " ").trim();
/** A read the RPC did not answer: the attempt fails and the next URL (or the same one, once) is tried. */
class NoAnswer extends Error {}
// A revert is the chain's answer (a paused registry reverts ownerOf(2); a registry with no previous Settler reverts
// prev(2)) and comes back as `{reverted: true}`. Anything else that is not a result — a JSON-RPC error such as a rate
// limit (-32005, -32007), an answer with no result, a body that is not JSON, no answer at all — is the RPC's failure,
// not the registry's word, and throws: a single rate-limited ownerOf(2) read was read as "no Settler" (BAD, severity
// high) before 2026-11-26, and never retried.
const call = (url, method, params) => withTimeout(12_000, async (signal) => {
  const r = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}), signal});
  const j = await r.json();
  if (j?.error) {
    const message = String(j.error.message ?? "");
    if (/revert/i.test(message)) return {reverted: true, message: message.slice(0, 80)};
    throw new NoAnswer(`${method}: RPC error ${j.error.code ?? "?"} ${cleanText(message).slice(0, 80)}`.trim());
  }
  if (j?.result === undefined || j.result === null) throw new NoAnswer(`${method}: no result (HTTP ${r.status})`);
  return {result: j.result};
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
/** Per chain: its verdict (pinStatus tag, "BAD", or "unreachable") and whether sales through the Settler in force pass. */
const verdicts = [];
/** Live corridors that failed, by chain. */
const failedQuotes = [];

// ── 1. on chain, keyless ─────────────────────────────────────────────────────
if (!args.includes("--no-chain")) {
  await Promise.all(Object.entries(ZEROEX_CHAINS).map(async ([id, chain]) => {
    const urls = rpcsFor(id);
    // Why the last attempt failed (no URL: it goes into the run's output).
    let lastFailure = "";
    for (let attempt = 0; urls.length && attempt < 2; attempt++) {
      const url = urls[attempt % urls.length];
      if (attempt) await sleep(1000); // a rate limit, or the same burst, is often over a second later
      try {
        // One call at a time: public endpoints throttle a burst.
        const chainId = await call(url, "eth_chainId", []);
        // An RPC that answers for another chain answered nothing about this one: the next URL is tried (its registry
        // reading would name no Settler of this chain and read as BAD, severity high).
        if (BigInt(chainId.result) !== BigInt(id)) throw new NoAnswer(`the RPC answered for chain ${BigInt(chainId.result)}`);
        const proxyCode = (await call(url, "eth_getCode", [chain.registry, "latest"])).result ?? "0x";
        const impl = addressOf((await call(url, "eth_getStorageAt", [chain.registry, SLOT_IMPL, "latest"])).result);
        const implCode = impl ? (await call(url, "eth_getCode", [impl, "latest"])).result ?? "0x" : "0x";
        const owner = addressOf((await call(url, "eth_call", [{to: chain.registry, data: "0x8da5cb5b"}, "latest"])).result);
        const current = addressOf((await call(url, "eth_call", [{to: chain.registry, data: `0x6352211e${word2}`}, "latest"])).result);
        const prevAnswer = await call(url, "eth_call", [{to: chain.registry, data: `0xe2603dc2${word2}`}, "latest"]);
        const prev = addressOf(prevAnswer.result);
        const codeOf = async (a) => (a ? ((await call(url, "eth_getCode", [a, "latest"])).result ?? "0x").length > 2 : false);
        // Derived past the pin too, so a newer 0x deployment is named rather than called "not a Settler".
        const nonceOf = (a) => (a ? zeroExSettlerNonce(Number(id), a, chain.registry, chain.newestLiveNonce + ZEROEX_SETTLER_NONCE_MARGIN + ZEROEX_SETTLER_LOOKAHEAD) : null);
        const nonce = nonceOf(current);
        const prevNonce = nonceOf(prev);
        const status = pinStatus({id, chain, current: nonce, previous: prevAnswer.reverted ? null : prevNonce, margin: ZEROEX_SETTLER_NONCE_MARGIN});
        const checks = {
          chain: BigInt(chainId.result) === BigInt(id),
          registryIsProxy: proxyCode.length > 2 && !!impl && implCode.length > 2,
          owner: !!owner,
          settler: nonce !== null && (await codeOf(current)),
          previous: prevAnswer.reverted || (prevNonce !== null && (await codeOf(prev))),
          permit2: await codeOf(ZEROEX_PERMIT2),
          wrappedNative: await codeOf(chain.wrappedNative),
          // the registry names exactly the pinned current and previous Settlers (pin-status.mjs says what to do otherwise)
          pins: status.tag === "ok",
        };
        const ok = Object.values(checks).every(Boolean);
        if (!ok) bad++;
        const onChain = Object.entries(checks).filter(([k]) => k !== "pins").every(([, v]) => v);
        const tag = ok ? "ok " : onChain && status.tag !== "BAD" ? status.tag.padEnd(3) : "BAD";
        // Every verdict below comes from a registry that answered ownerOf(2) (a result or a revert): a read the RPC did not
        // answer threw above, so a chain whose reads all failed ends as "unreachable", which carries no severity.
        verdicts.push({id, tag: tag.trim(), pin: status.tag, native: status.native, token: status.token});
        const pin = `pinned ${chain.newestLiveNonce} / previous ${chain.previousLiveNonce}, token sales up to ${chain.newestLiveNonce + ZEROEX_SETTLER_NONCE_MARGIN}`;
        const advice = status.advice && tag !== "BAD" ? ` — ${status.advice}` : "";
        // A BAD line names its failing checks first, on the line itself (it printed the check map as a multi-line object
        // after it, which the canary's note — the line, cut to the room left — never kept).
        const failing = tag === "BAD" ? `failing: ${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(", ")} · ` : "";
        console.log(`${tag} chain   ${id.padEnd(6)} ${chain.name.padEnd(16)} ${failing}Settler ${current ?? "—"} (deployment ${nonce ?? "?"}; ${pin})${prev ? `, previous ${prev} (deployment ${prevNonce ?? "?"})` : ""} · registry impl ${impl ?? "—"} owner ${owner ?? "—"}${advice}`);
        return;
      } catch (e) {
        // second try; what failed is kept without its URL
        lastFailure = e instanceof NoAnswer ? e.message : cleanText(e?.name === "AbortError" ? "timed out (12 s)" : e?.message ?? e).slice(0, 80);
      }
    }
    // Unchecked is not ok: a new 0x deployment there would go unseen (up to 0.1.6 this printed `ok — no RPC for …`, exit 0).
    bad++;
    verdicts.push({id, tag: "unreachable"});
    const which = process.env[`RPC_${id}`] ? `RPC_${id}` : `the public endpoint; set RPC_${id}`;
    console.log(`??? chain   ${id.padEnd(6)} ${chain.name.padEnd(16)} ${urls.length ? `no RPC answered (2 tries, ${which}${lastFailure ? `; last: ${lastFailure}` : ""})` : `no RPC configured (set RPC_${id})`} — the chain is unchecked, which fails this run`);
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
      // Monad: 100 MON → AUSD (Agora, 6 decimals), and USDC → MON
      ["Monad MON → AUSD (native)", 143, NATIVE, 18, "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", "100000000000000000000"],
      ["Monad USDC → MON (Permit2)", 143, "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", 6, NATIVE, "25000000"],
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
        failedQuotes.push({id, kind: "quote"});
        console.log(`BAD quote   ${name.padEnd(38)} ${String(e?.message ?? e).replace(/https?:\/\/\S+/g, "<url>").replace(/\s+/g, " ").slice(0, 260)}`);
      }
      await pause();
    }
    // Remote mode: the real provider behind the real server handler, every answer checked again on the "device" — a
    // token sale and a native sale (the first of each selected), each quoted, built and preflighted (the device reads
    // the registry again, then the backend's preflight runs).
    if (!ONLY || ONLY.test("remote")) {
      const picked = [corridors.find(([, , source]) => source !== NATIVE), corridors.find(([, , source]) => source === NATIVE)].filter(Boolean);
      const handle = createSwap2Handler({providers: [provider], sealSecret: crypto.getRandomValues(new Uint8Array(32)), guard: () => {}, subject: () => "verify-live"});
      const backend = async (url, init) => {
        const res = await handle(String(url).split("/").pop(), JSON.parse(String(init.body)), "verify-live");
        return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
      };
      const app = zeroExRemoteProvider({baseUrl: "https://backend.invalid/api/swap2", fetchImpl: backend, rpcUrls});
      for (const corridor of picked) {
        try {
          const q = await app.getQuote(paramsOf(corridor));
          if (!q) throw new Error("null quote");
          const tx = await app.buildDeposit(q);
          await app.preflightDeposit(q, tx);
          console.log(`ok  remote  ${corridor[0].padEnd(38)} through createSwap2Handler → zeroExRemoteProvider (quote, build, preflight) · ${tx.to}`);
        } catch (e) {
          bad++;
          failedQuotes.push({id: corridor[1], kind: "remote"});
          console.log(`BAD remote  ${corridor[0].padEnd(38)} ${String(e?.message ?? e).replace(/https?:\/\/\S+/g, "<url>").replace(/\s+/g, " ").slice(0, 260)}`);
        }
        await pause();
      }
    }
  }
}
const {reason, severity} = runSummary({chains: verdicts, quotes: failedQuotes});
console.log(bad ? `FAILED (${bad})` : "ok");
// Last, so whatever keeps only the end of the output still names every chain that is not ok.
if (bad && severity) console.log(severity);
if (bad && reason) console.log(reason);
process.exit(bad ? 1 : 0);
