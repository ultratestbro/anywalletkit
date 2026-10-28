// 2026-10-27 modules scan: the exploit inputs from the report against the engine's own gates. Mocked
// provider + account only — no network, no keys; every refusal asserts that nothing was sent.
import {describe, expect, it} from "vitest";
import {Swap2ValidationError} from "../src/errors.js";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {Swap2EngineConfig} from "../src/swap2/base.js";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "../src/types.js";

const SELF = "0x4444444444444444444444444444444444444444";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const word = (v: string | bigint) => (typeof v === "bigint" ? v.toString(16) : v.replace(/^0x/, "")).padStart(64, "0");
const options = {fromToken: "USDC", toToken: "0xFd086bC7CD5C481DCC9C85EBE478A1C0b69FCbb9", toChain: 42161, recipient: RECIPIENT, fromTokenAmount: 1_000_000n, minAmountOut: 980_000n};

function harness(txRequest: Record<string, unknown>) {
  const sent: unknown[] = [];
  const quote = (params: QuoteParams): Quote => ({
    provider: "scan", intentId: `intent-${Math.random()}`, depositAddress: "", depositMemo: null, txRequest,
    sourceAmount: params.amountIn, destAmount: "990000", minDestAmount: "980000", feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
  } as Quote);
  const provider: CrossChainProvider = {
    name: "scan", enabled: () => true, supportsRoute: () => true,
    getQuote: async (params) => quote(params),
    buildDeposit: async (q) => ({...(q.txRequest as object), chain: "eip155:1", to: q.txRequest!.to!, value: q.txRequest!.value ?? "0"}) as UnsignedTx,
    trackIntent: async () => ({state: "pending"}),
  };
  const account = {getAddress: async () => SELF, getChainId: async () => 1, sendTransaction: async (tx: unknown) => { sent.push(tx); return {hash: "0x1"}; }, waitForTransaction: async () => {}};
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  return {sent, swap: () => new P(account as never, {fromChain: "eip155:1"} as Partial<Swap2EngineConfig> as never).swap2(options)};
}

describe("scan 2026-10-27 modules G1 (F3): the quote-calldata gate reads selectors in any case and refuses undecodable calldata", () => {
  it("an uppercase approve(attacker, max) as the swap call is refused; nothing is sent", async () => {
    const h = harness({to: USDC, data: "0x095EA7B3" + word(ATTACKER) + "F".repeat(64), value: "0", chainId: 1, gasLimit: "60000"});
    await expect(h.swap()).rejects.toBeInstanceOf(Swap2ValidationError);
    expect(h.sent).toHaveLength(0);
  });
  it("calldata that is not hex bytes is refused before anything is sent", async () => {
    const h = harness({to: USDC, data: "0x095ea7b" + word(ATTACKER), value: "0", chainId: 1, gasLimit: "60000"});
    await expect(h.swap()).rejects.toBeInstanceOf(Swap2ValidationError);
    expect(h.sent).toHaveLength(0);
  });
});
