// Scan 2026-10-30 F3 (CCTP): cctpPins pinned only the TokenMessenger address, so a compromised backend could return a
// quote + build whose depositForBurn names another mintRecipient (or domain, fee, token) and the engine signed it.
// cctpPins now carry cctpVerifyQuote, which decodes the burn against the app's own request. Honest Fast and Standard
// burns from the real provider keep passing.
import {describe, expect, it} from "vitest";
import {decodeFunctionData, encodeFunctionData, pad, getAddress, type Hex} from "viem";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {cctpPins, cctpVerifyQuote} from "../src/provider.js";
import {CCTP_DOMAINS, TOKEN_MESSENGER_V2} from "../src/config.js";
import {make, MESSENGER_ABI} from "./fixtures.js";

const ARB_USDC = CCTP_DOMAINS["eip155:42161"]!.usdc;
const BASE_USDC = CCTP_DOMAINS["eip155:8453"]!.usdc;
const SENDER = "0x4444444444444444444444444444444444444444";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const ATTACKER = "0x9999999999999999999999999999999999999999";

function realBackend(): typeof fetch {
  const handle = createSwap2Handler<string>({providers: [make().p], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
  return (async (url: string, init: RequestInit) => {
    const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
    return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
}

/** Real quote metadata (recipient R in the review), calldata re-encoded with mintRecipient = attacker; build repeats it. */
function evilBackend(): typeof fetch {
  const real = realBackend();
  const original = new Map<string, Quote>();
  const reply = (x: unknown) => new Response(JSON.stringify(x), {status: 200, headers: {"content-type": "application/json"}});
  const swapRecipient = (data: Hex): Hex => {
    const d = decodeFunctionData({abi: MESSENGER_ABI, data});
    const args = [...(d.args as readonly unknown[])];
    args[2] = pad(getAddress(ATTACKER), {size: 32});
    return encodeFunctionData({abi: MESSENGER_ABI, functionName: d.functionName as never, args: args as never});
  };
  return (async (url: string, init: RequestInit) => {
    const action = String(url).split("/").pop();
    if (action === "quote") {
      const q = await (await real(url, init)).json() as Quote;
      original.set(q.intentId, q);
      return reply({...q, txRequest: {...q.txRequest!, data: swapRecipient(q.txRequest!.data as Hex)}});
    }
    if (action === "build") {
      // The real build of the original quote, its calldata replaced the same way (so build === quote).
      const {quote} = JSON.parse(String(init.body)) as {quote: Quote};
      const tx = await (await real(url, {...init, body: JSON.stringify({provider: "cctp", quote: original.get(quote.intentId) ?? quote})})).json() as {data: Hex};
      return reply({...tx, data: swapRecipient(tx.data)});
    }
    return reply({});
  }) as unknown as typeof fetch;
}

function app(fetchImpl: typeof fetch) {
  const sent: Array<{to: string; data?: string}> = [];
  const account = {
    getAddress: async () => SENDER, getChainId: async () => 8453, getAllowance: async () => 0n, waitForTransaction: async () => {},
    sendTransaction: async (tx: {to: string; data?: string}) => { sent.push(tx); return {hash: `0x${String(sent.length).padStart(64, "0")}`}; },
  };
  const provider: CrossChainProvider = remoteProvider({name: "cctp", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, ...cctpPins});
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  return {sent, swap2: new P(account as never, {fromChain: "eip155:8453"} as never)};
}
const REQ = {fromToken: "USDC", toToken: ARB_USDC, toChain: 42161, recipient: RECIPIENT, fromTokenAmount: 10_000_000n, minAmountOut: 9_998_570n} as never;

describe("scan 2026-10-30 F3: remote CCTP calldata is bound to the recipient", () => {
  it("honest corridor USDC Base → Arbitrum still approves + burns to the requested recipient", async () => {
    const a = app(realBackend());
    await a.swap2.swap2(REQ);
    expect(a.sent.map((t) => t.to.toLowerCase())).toEqual([BASE_USDC.toLowerCase(), TOKEN_MESSENGER_V2.toLowerCase()]);
  });

  it("a depositForBurn to an attacker mintRecipient is refused before approve/sign", async () => {
    const a = app(evilBackend());
    let err: unknown = null;
    try { await a.swap2.swap2(REQ); } catch (e) { err = e; }
    const burns = a.sent.filter((t) => t.to.toLowerCase() === TOKEN_MESSENGER_V2.toLowerCase())
      .map((t) => getAddress(`0x${(decodeFunctionData({abi: MESSENGER_ABI, data: t.data as Hex}).args as readonly Hex[])[2]!.slice(-40)}`));
    expect(burns).toEqual([]);
    expect(a.sent).toEqual([]);
    expect(String(err)).toMatch(/fails this app's own check — the burn mints to/);
  });
});

describe("scan 2026-10-30 F3: cctpVerifyQuote", () => {
  const params = (o: Partial<QuoteParams> = {}): QuoteParams => ({
    sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: ARB_USDC, amountIn: "10000000", destAddress: RECIPIENT, dry: false, ...o,
  });
  const reencode = (q: Quote, i: number, v: unknown): Quote => {
    const d = decodeFunctionData({abi: MESSENGER_ABI, data: q.txRequest!.data as Hex});
    const args = [...(d.args as readonly unknown[])];
    args[i] = v;
    return {...q, txRequest: {...q.txRequest!, data: encodeFunctionData({abi: MESSENGER_ABI, functionName: "depositForBurn", args: args as never})}};
  };

  it("passes the real provider's Fast and Standard burns, a dry quote without a recipient, and a floor it meets", async () => {
    const fast = (await make().p.getQuote(params()))!;
    expect(fast.intentId).toBe("cctp:6:3:1000");
    expect(cctpVerifyQuote(params(), fast)).toBeNull();
    const standard = (await make({}, {mode: "standard"}).p.getQuote(params()))!;
    expect(standard.intentId).toBe("cctp:6:3:2000");
    expect(cctpVerifyQuote(params(), standard)).toBeNull();
    const dry = (await make().p.getQuote(params({destAddress: "", dry: true})))!;
    expect(cctpVerifyQuote(params({destAddress: "", dry: true}), dry)).toBeNull();
    expect(cctpVerifyQuote(params({destToken: "USDC", minAmountOut: fast.minDestAmount}), fast)).toBeNull();
    // A live quote without a recipient is not a dry one.
    expect(cctpVerifyQuote(params({destAddress: ""}), dry)).toMatch(/not an EVM address/);
  });

  it("refuses another recipient, domain, token, caller, threshold, amount, fee, target, value, approval or call", async () => {
    const q = (await make().p.getQuote(params()))!;
    const [amount, , , , , maxFee] = decodeFunctionData({abi: MESSENGER_ABI, data: q.txRequest!.data as Hex}).args as readonly unknown[] as [bigint, number, Hex, string, Hex, bigint, number];
    expect(cctpVerifyQuote(params(), reencode(q, 2, pad(ATTACKER, {size: 32})))).toMatch(/mints to/);
    expect(cctpVerifyQuote(params(), reencode(q, 1, 0))).toMatch(/domain 0/);
    expect(cctpVerifyQuote(params(), reencode(q, 3, ATTACKER))).toMatch(/not the source domain's USDC/);
    expect(cctpVerifyQuote(params(), reencode(q, 4, pad(ATTACKER, {size: 32})))).toMatch(/destination caller/);
    expect(cctpVerifyQuote(params(), reencode(q, 6, 500))).toMatch(/neither Fast nor Standard/);
    expect(cctpVerifyQuote(params(), reencode(q, 0, amount - 1n))).toMatch(/not the 10000000 input/);
    expect(cctpVerifyQuote(params(), reencode(q, 5, maxFee + 1n))).toMatch(/leaves less than/);
    expect(cctpVerifyQuote(params({minAmountOut: String(amount - maxFee + 1n)}), q)).toMatch(/leaves less than/);
    expect(cctpVerifyQuote(params(), {...q, txRequest: {...q.txRequest!, to: ATTACKER}})).toMatch(/not the TokenMessengerV2/);
    expect(cctpVerifyQuote(params(), {...q, txRequest: {...q.txRequest!, value: "1"}})).toMatch(/no value/);
    expect(cctpVerifyQuote(params(), {...q, txRequest: {...q.txRequest!, approvalAddress: ATTACKER}})).toMatch(/another spender/);
    expect(cctpVerifyQuote(params(), {...q, txRequest: {...q.txRequest!, data: encodeFunctionData({abi: MESSENGER_ABI, functionName: "localMessageTransmitter"})}})).toMatch(/is not depositForBurn/);
    expect(cctpVerifyQuote(params(), {...q, intentId: "cctp:6:3:2000"})).toMatch(/intent id/);
    expect(cctpVerifyQuote(params({destChain: "eip155:1"}), q)).toMatch(/not USDC to USDC|domain 3/);
  });
});
