// Scan 2026-10-30 F3 (LI.FI): lifiPins pinned only the Diamond, so a compromised backend could answer with Diamond
// calldata paying its own receiver (or bridging elsewhere, accepting less) and the engine signed it. lifiPins now carry
// lifiVerifyQuote: the provider's own diamondCallMismatch with the expectation it builds, run on the device.
// The fixture is read-only answers of the public li.quest/v1/quote (2026-10-30, no API key) across 32 corridors — same-chain
// swaps, bridges via Across, Stargate, Relay, Mayan, LayerSwap, Polymer, Glacis, LI.FI Intents and NEAR, native in and
// out, and the routes the provider refuses (no quote, a Solana destination). Every quote the provider accepts must
// pass the remote check, directly and through the real swap2 server handler and remoteProvider.
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {lifiPins, lifiProvider, lifiVerifyQuote} from "../src/provider.js";

type Corridor = {name: string; params: QuoteParams; responses: {status: number; body: unknown}[]};
const live = JSON.parse(readFileSync(new URL("./fixtures-live-2026-10-30.json", import.meta.url), "utf8")) as {corridors: Corridor[]};
const ATTACKER = "9999999999999999999999999999999999999999";
const RECIPIENT = "3333333333333333333333333333333333333333";

afterEach(() => vi.unstubAllGlobals());

/** LI.FI answers the corridor's recorded responses in order (the provider's own retry included). */
function replay(c: Corridor) {
  let i = 0;
  vi.stubGlobal("fetch", async () => {
    const r = c.responses[Math.min(i++, c.responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), {status: r.status});
  });
}
async function localQuote(c: Corridor): Promise<{quote: Quote | null; reasons: string[]}> {
  replay(c);
  const reasons: string[] = [];
  const quote = await lifiProvider({integrator: "awk-probe"}).getQuote({...c.params, onRefusal: (r) => reasons.push(r)});
  return {quote, reasons};
}

describe("scan 2026-10-30 F3: lifiVerifyQuote over live LI.FI answers", () => {
  it("is in the pins", () => {
    expect(lifiPins.verifyQuote).toBe(lifiVerifyQuote);
  });

  it("every quote the local provider accepts passes the remote check; refusals stay refusals", async () => {
    const table: string[] = [];
    let accepted = 0;
    for (const c of live.corridors) {
      const {quote, reasons} = await localQuote(c);
      if (!quote) { table.push(`${c.name}: local refused (${reasons[0]})`); continue; }
      accepted++;
      expect([c.name, lifiVerifyQuote(c.params, quote)]).toEqual([c.name, null]);
      table.push(`${c.name}: pass`);
    }
    expect(accepted).toBe(26);
    expect(table.filter((t) => t.includes("local refused"))).toEqual([
      expect.stringMatching(/^base-usdc>arb-usdc cbridge: local refused \(lifi: No available quotes/),
      expect.stringMatching(/^op-usdc>arb-usdc symbiosis: local refused/),
      expect.stringMatching(/^eth-eth>arb-eth hop: local refused/),
      expect.stringMatching(/^base-usdc>solana-usdc default: local refused .*non-EVM destination/),
      expect.stringMatching(/^base-eth>arb-eth gasZip: local refused/),
      expect.stringMatching(/^base-usdc>op-usdc eco: local refused/),
    ]);
  });

  it("the live corridors run through the real server handler and remoteProvider + lifiPins", async () => {
    for (const c of live.corridors) {
      const {quote} = await localQuote(c);
      if (!quote) continue;
      replay(c);
      const handle = createSwap2Handler<string>({providers: [lifiProvider({integrator: "awk-probe"})], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
      const fetchImpl = (async (url: string, init: RequestInit) => {
        const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
        return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
      }) as unknown as typeof fetch;
      const stub = remoteProvider({name: "lifi", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, ...lifiPins});
      const q = await stub.getQuote(c.params);
      expect([c.name, q?.minDestAmount]).toEqual([c.name, quote.minDestAmount]);
    }
  });

  it("refuses calldata paying another receiver, a lower minimum, another value, approval, target or intent", async () => {
    const pick = (name: string) => live.corridors.find((c) => c.name === name)!;
    for (const name of ["base-usdc>arb-usdc across", "base-usdc>arb-usdc stargate", "base-usdc>arb-usdc relay", "base-eth>base-usdc same-chain", "base-usdc>base-eth same-chain"]) {
      const c = pick(name);
      const q = (await localQuote(c)).quote!;
      const data = q.txRequest!.data!;
      expect(data.toLowerCase()).toContain(RECIPIENT);
      const evil = {...q, txRequest: {...q.txRequest!, data: data.toLowerCase().split(RECIPIENT).join(ATTACKER)}};
      expect([name, lifiVerifyQuote(c.params, evil)]).toEqual([name, expect.stringMatching(/pays 0x9999/)]);
    }
    const swap = pick("base-eth>base-usdc same-chain");
    const q = (await localQuote(swap)).quote!;
    // The calldata's minimum is the quote's: a higher quoted minimum than the calldata enforces is refused.
    expect(lifiVerifyQuote(swap.params, {...q, minDestAmount: (BigInt(q.minDestAmount) * 2n).toString()})).toMatch(/accepts .* below/);
    expect(lifiVerifyQuote({...swap.params, minAmountOut: (BigInt(q.minDestAmount) + 1n).toString()}, q)).toMatch(/below the caller's floor/);
    expect(lifiVerifyQuote(swap.params, {...q, txRequest: {...q.txRequest!, value: (BigInt(q.txRequest!.value!) + 1n).toString()}})).toMatch(/native input is paid/);
    expect(lifiVerifyQuote(swap.params, {...q, txRequest: {...q.txRequest!, approvalAddress: `0x${ATTACKER}`}})).toMatch(/approves nothing/);
    expect(lifiVerifyQuote(swap.params, {...q, txRequest: {...q.txRequest!, to: `0x${ATTACKER}`}})).toMatch(/not the LI.FI Diamond/);
    expect(lifiVerifyQuote(swap.params, {...q, intentId: "lifi:8453:42161"})).toMatch(/intent id/);
    expect(lifiVerifyQuote({...swap.params, destChain: "eip155:42161"}, q)).toMatch(/intent id|same-chain swap call/);
    const token = pick("base-usdc>arb-usdc across");
    const t = (await localQuote(token)).quote!;
    expect(lifiVerifyQuote(token.params, {...t, txRequest: {...t.txRequest!, value: "1"}})).toMatch(/only its declared bridge fee/);
    expect(lifiVerifyQuote(token.params, {...t, txRequest: {...t.txRequest!, approvalAddress: `0x${ATTACKER}`}})).toMatch(/approves the LI.FI Diamond/);
    expect(lifiVerifyQuote({...token.params, amountIn: "1"}, t)).toMatch(/not the 1 input/);
  });

  it("a dry quote prices the placeholder; a Solana source's serialized transaction is left to the balance proof", () => {
    const dry = {sourceChain: "eip155:8453", sourceToken: "ETH", destChain: "eip155:8453", destToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amountIn: "1", destAddress: ""} as QuoteParams;
    expect(lifiVerifyQuote(dry, {intentId: "lifi:8453:8453", sourceAmount: "1", minDestAmount: "1", txRequest: {to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", data: "0x12345678", value: "1"}} as Quote)).toMatch(/unknown Diamond call|too short/);
    const sol = {sourceChain: "solana:mainnet", sourceToken: "SOL", destChain: "eip155:8453", destToken: "0x0000000000000000000000000000000000000000", amountIn: "1", destAddress: "0x3333333333333333333333333333333333333333"} as QuoteParams;
    expect(lifiVerifyQuote(sol, {txRequest: {serializedTx: "AQ==", value: "1"}} as Quote)).toBeNull();
    expect(lifiVerifyQuote(sol, {txRequest: {serializedTx: "AQ==", to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", value: "1"}} as Quote)).toMatch(/serialized transaction only/);
  });
});
