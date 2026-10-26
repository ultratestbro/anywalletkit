import {describe, expect, it} from "vitest";
import {Swap2MaybeSentError} from "../src/errors.js";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "../src/types.js";

// Audit 2026-10-25 round 3, M12 (swap2 part): the engine reported a possibly-broadcast deposit only
// when the error said `maybeSent: true` or its top-level message looked like a lost socket. A
// `fetch failed` (undici, code UND_ERR_* on its cause), React Native's `Network request failed`, a
// code only on the cause, all read as a clean failure: the approval was revoked and a retry sent a
// second deposit. A node's explicit refusal that mentions a timeout read as "maybe sent" instead.

const SELF = "0x4444444444444444444444444444444444444444";
const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const txRequest = {to: DIAMOND, data: "0xdeadbeef", value: "0", chainId: 1, gasLimit: "21000", approvalAddress: DIAMOND};
const options = {fromToken: "USDC", toToken: "0xFd086bC7CD5C481DCC9C85EBE478A1C0b69FCbb9", toChain: 42161, recipient: SELF, fromTokenAmount: 1_000_000n, minAmountOut: 980_000n};

const quote = (params: QuoteParams): Quote => ({
  provider: "edge", intentId: `intent-${Math.random()}`, depositAddress: "", depositMemo: null, txRequest,
  sourceAmount: params.amountIn, destAmount: "990000", minDestAmount: "980000", feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
}) as Quote;
const provider: CrossChainProvider = {
  name: "edge", enabled: () => true, supportsRoute: () => true, getQuote: async (p) => quote(p),
  buildDeposit: async (q): Promise<UnsignedTx> => { const {nativeFee: _f, ...tx} = q.txRequest!; return {...tx, chain: "eip155:1", to: tx.to!, value: tx.value ?? "0"}; },
  trackIntent: async () => ({state: "pending"}),
};
/** An account whose deposit fails with `error` (the approval goes through). */
function account(error: unknown, log: string[]) {
  return {
    getAddress: async () => SELF, getChainId: async () => 1, waitForTransaction: async () => {},
    sendTransaction: async (tx: {data?: string}) => {
      const approval = tx.data?.startsWith("0x095ea7b3");
      log.push(approval ? (tx.data!.endsWith("0".repeat(64)) ? "revoke" : "approve") : "deposit");
      if (!approval) throw error;
      return {hash: "0x1"};
    },
  };
}
function engine(acc: unknown) {
  class P extends SingleProviderSwap2 {
    protected readonly provider = provider;
    protected chainSupported(): boolean { return true; }
  }
  return new P(acc as never, {fromChain: "eip155:1"});
}
const outcome = async (error: unknown) => {
  const log: string[] = [];
  const e = await engine(account(error, log)).swap2(options).catch((x: unknown) => x);
  return {maybe: e instanceof Swap2MaybeSentError, hash: (e as Swap2MaybeSentError).hash, revoked: log.includes("revoke")};
};

describe("swap2: a lost deposit answer is 'maybe sent' whatever shape it has", () => {
  it("a chain package's BroadcastUnknownError, wrapped: maybe sent with its hash", async () => {
    const inner = Object.assign(new Error("Broadcast outcome unknown"), {name: "BroadcastUnknownError", maybeSent: true, hash: "abc123"});
    expect(await outcome(new Error("transfer failed", {cause: inner}))).toEqual({maybe: true, hash: "abc123", revoked: false});
  });

  for (const [name, error] of [
    ["undici 'fetch failed' (UND_ERR_SOCKET on the cause)", new TypeError("fetch failed", {cause: Object.assign(new Error("other side closed"), {code: "UND_ERR_SOCKET"})})],
    ["React Native 'Network request failed'", new TypeError("Network request failed")],
    ["a code only on the cause (ECONNRESET)", new Error("send failed", {cause: Object.assign(new Error("read"), {code: "ECONNRESET"})})],
    ["a TimeoutError from AbortSignal.timeout", Object.assign(new Error("The operation was aborted due to timeout"), {name: "TimeoutError"})],
  ] as const) {
    it(`${name}: maybe sent, the approval is not revoked`, async () => {
      expect(await outcome(error)).toMatchObject({maybe: true, revoked: false});
    });
  }

  it("a node's explicit refusal (answered) is a clean failure even when it mentions a timeout", async () => {
    const refusal = Object.assign(new Error("RPC error: request timed out waiting for the mempool slot"), {answered: true});
    expect(await outcome(refusal)).toMatchObject({maybe: false, revoked: true});
    expect(await outcome(new Error("insufficient funds for gas"))).toMatchObject({maybe: false, revoked: true});
  });
});
