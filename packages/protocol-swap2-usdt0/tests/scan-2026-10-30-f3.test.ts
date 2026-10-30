// Scan 2026-10-30 F3 (USDT0): usdt0Pins pinned only the OFT address, so a compromised backend could answer with a
// send(SendParam, fee, refund) to its own `to` (or another eid, floor, refund, options) and the engine signed it.
// usdt0Pins now carry usdt0VerifyQuote, which decodes the send against the app's own request. The real provider's
// sends (an L2 OFT, the Ethereum adapter, dry quotes) keep passing; the remote corridor still executes.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeFunctionData, pad, type Hex} from "viem";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {usdt0Pins, usdt0VerifyQuote} from "../src/config.js";
import {ARB, ETH, HYPE, OFT_ABI, PARAMS, RECIPIENT, SEALED, SENDER, make} from "./fixtures.js";

const ATTACKER = "0x9999999999999999999999999999999999999999";
afterEach(() => vi.unstubAllGlobals());

function realBackend(): typeof fetch {
  const handle = createSwap2Handler<string>({providers: [make().p], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
  return (async (url: string, init: RequestInit) => {
    const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
    return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
}

/** Re-encode one SendParam field (or the refund) of a quote's send. */
function edit(q: Quote, f: (sp: Record<string, unknown>, rest: {fee: {nativeFee: bigint; lzTokenFee: bigint}; refund: string}) => void): Quote {
  const d = decodeFunctionData({abi: OFT_ABI, data: q.txRequest!.data as Hex});
  const [sp0, fee, refund] = d.args as unknown as [Record<string, unknown>, {nativeFee: bigint; lzTokenFee: bigint}, string];
  const sp = {...sp0};
  const rest = {fee: {...fee}, refund};
  f(sp, rest);
  return {...q, txRequest: {...q.txRequest!, data: encodeFunctionData({abi: OFT_ABI, functionName: "send", args: [sp as never, rest.fee, rest.refund as `0x${string}`]})}};
}

/** Compromised backend: the real quote and build, the send's `to` swapped for the attacker in both. */
function evilBackend(): typeof fetch {
  const real = realBackend();
  const swap = (data: Hex): Hex => {
    const d = decodeFunctionData({abi: OFT_ABI, data});
    const [sp, fee, refund] = d.args as unknown as [Record<string, unknown>, {nativeFee: bigint; lzTokenFee: bigint}, `0x${string}`];
    return encodeFunctionData({abi: OFT_ABI, functionName: "send", args: [{...sp, to: pad(ATTACKER, {size: 32})} as never, fee, refund]});
  };
  return (async (url: string, init: RequestInit) => {
    const action = String(url).split("/").pop();
    const res = await real(url, init);
    if (action === "quote") {
      const q = await res.json() as Quote;
      return new Response(JSON.stringify({...q, txRequest: {...q.txRequest!, data: swap(q.txRequest!.data as Hex)}}), {status: 200});
    }
    return res;
  }) as unknown as typeof fetch;
}

function app(fetchImpl: typeof fetch) {
  const sent: Array<{to: string; data?: string; value?: bigint}> = [];
  const account = {
    getAddress: async () => SENDER, getChainId: async () => 42161, getAllowance: async () => 0n, waitForTransaction: async () => {},
    sendTransaction: async (tx: {to: string; data?: string; value?: bigint}) => { sent.push(tx); return {hash: `0x${String(sent.length).padStart(64, "0")}`}; },
  };
  const provider: CrossChainProvider = remoteProvider({name: "usdt0", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, ...usdt0Pins});
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  return {sent, swap2: new P(account as never, {fromChain: "eip155:42161"})};
}
const REQ = {fromToken: "USDT0", toToken: HYPE.token, toChain: 999, recipient: RECIPIENT, fromTokenAmount: 10_000_000n, minAmountOut: 10_000_000n} as never;

describe("scan 2026-10-30 F3: remote USDT0 send bound to the request", () => {
  it("honest corridor Arbitrum → HyperEVM still sends with the messaging fee as value", async () => {
    const a = app(realBackend());
    await a.swap2.swap2(REQ);
    expect(a.sent.map((t) => [t.to.toLowerCase(), t.value])).toEqual([[ARB.oft.toLowerCase(), SEALED]]);
  });

  it("a send delivering to the attacker is refused before anything is signed", async () => {
    const a = app(evilBackend());
    await expect(a.swap2.swap2(REQ)).rejects.toThrow(/fails this app's own check — the send delivers to/);
    expect(a.sent).toEqual([]);
  });
});

describe("scan 2026-10-30 F3: usdt0VerifyQuote", () => {
  const params = (o: Partial<QuoteParams> = {}): QuoteParams => ({...PARAMS, dry: false, ...o});

  it("passes the real provider's L2 send, the Ethereum adapter send, a dry quote with placeholders, and a floor it meets", async () => {
    const q = (await make().p.getQuote(params()))!;
    expect(usdt0VerifyQuote(params(), q)).toBeNull();
    expect(usdt0VerifyQuote(params({destToken: "USDT0", minAmountOut: q.minDestAmount}), q)).toBeNull();
    const eth = params({sourceChain: "eip155:1", sourceToken: "USDT"});
    const qe = (await make().p.getQuote(eth))!;
    expect(qe.txRequest!.approvalAddress).toBe(ETH.oft);
    expect(usdt0VerifyQuote(eth, qe)).toBeNull();
    const dry = params({destAddress: "", refundAddress: "", dry: true});
    expect(usdt0VerifyQuote(dry, (await make().p.getQuote(dry))!)).toBeNull();
  });

  it("refuses another recipient, eid, amount, floor, options, refund, fee, value, target or approval", async () => {
    const q = (await make().p.getQuote(params()))!;
    const p = params();
    expect(usdt0VerifyQuote(p, edit(q, (sp) => { sp.to = pad(ATTACKER, {size: 32}); }))).toMatch(/delivers to/);
    expect(usdt0VerifyQuote(p, edit(q, (sp) => { sp.dstEid = ETH.eid; }))).toMatch(/eid 30101/);
    expect(usdt0VerifyQuote(p, edit(q, (sp) => { sp.amountLD = 1n; }))).toMatch(/not the 10000000 input/);
    expect(usdt0VerifyQuote(p, edit(q, (sp) => { sp.minAmountLD = 1n; }))).toMatch(/below the/);
    expect(usdt0VerifyQuote(params({minAmountOut: "10000001"}), q)).toMatch(/below the 10000001 minimum/);
    expect(usdt0VerifyQuote(p, edit(q, (sp) => { sp.composeMsg = "0x01"; }))).toMatch(/compose message/);
    expect(usdt0VerifyQuote(p, edit(q, (sp) => { sp.extraOptions = "0x0003"; }))).toMatch(/options/);
    expect(usdt0VerifyQuote(p, edit(q, (_sp, r) => { r.refund = ATTACKER; }))).toMatch(/refunds/);
    expect(usdt0VerifyQuote(p, edit(q, (_sp, r) => { r.fee.lzTokenFee = 1n; }))).toMatch(/LZ-token fee/);
    expect(usdt0VerifyQuote(p, {...q, txRequest: {...q.txRequest!, value: "1"}})).toMatch(/msg.value/);
    expect(usdt0VerifyQuote(p, {...q, txRequest: {...q.txRequest!, to: ATTACKER}})).toMatch(/not the Arbitrum OFT/);
    expect(usdt0VerifyQuote(p, {...q, txRequest: {...q.txRequest!, approvalAddress: ATTACKER}})).toMatch(/needs no approval/);
    expect(usdt0VerifyQuote(p, {...q, txRequest: {...q.txRequest!, data: "0x12345678"}})).toMatch(/is not send/);
  });
});
