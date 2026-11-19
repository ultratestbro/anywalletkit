// Review 2026-11-15 (0x round 2), core side:
//  - a provider that declares `ownGasEstimate` (0x) has its plain EVM calls — native sales — dry-run from the account
//    right before broadcast and sent with the account's own estimate, never the quoted gas limit (as a Permit2 call);
//  - the dry run tells a revert (simulation_failed) from the account's RPC failing (retried once, then
//    upstream_unavailable), and still takes back the allowance it created;
//  - a Permit2 transfer never rides with native value (policy_refused), at the quote and at the build.
// Mocked provider and account only — no network, no keys.
import {describe, expect, it} from "vitest";
import {refusalOf} from "../src/errors.js";
import {PERMIT2_ADDRESS} from "../src/permit2.js";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {Swap2ExecutionPlan} from "../src/swap2/base.js";
import type {CrossChainProvider, Quote, QuoteParams, TxRequest} from "../src/types.js";
import {quoteRejection} from "../src/validate.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base
const ROUTER = "0x1035029091415555555555555555555555550001";
const ME = "0x4444444444444444444444444444444444444444";
const ETH = "0x0000000000000000000000000000000000000000";
const AMOUNT = 1_000_000n;
const WEI = 10n ** 15n;
const DATA = `0x1fff991f${"00".repeat(96)}`;
const SIG = `0x${"cd".repeat(65)}`;
const now = () => Math.floor(Date.now() / 1000);

function permit(deadline = now() + 300): string {
  return JSON.stringify({
    domain: {name: "Permit2", chainId: 8453, verifyingContract: PERMIT2_ADDRESS},
    types: {
      PermitTransferFrom: [{name: "permitted", type: "TokenPermissions"}, {name: "spender", type: "address"}, {name: "nonce", type: "uint256"}, {name: "deadline", type: "uint256"}],
      TokenPermissions: [{name: "token", type: "address"}, {name: "amount", type: "uint256"}],
    },
    primaryType: "PermitTransferFrom",
    message: {permitted: {token: USDC.toLowerCase(), amount: AMOUNT.toString()}, spender: ROUTER, nonce: "7", deadline: String(deadline)},
  });
}
const nativeTx = (over: Partial<TxRequest> = {}): TxRequest => ({to: ROUTER, data: DATA, value: WEI.toString(), chainId: 8453, gasLimit: "21000", ...over});
const permitTx = (over: Partial<TxRequest> = {}): TxRequest => ({to: ROUTER, data: DATA, value: "0", chainId: 8453, gasLimit: "400000", approvalAddress: PERMIT2_ADDRESS, permit2Transfer: permit(), ...over});

function provider(request: TxRequest, over: Partial<CrossChainProvider> = {}): CrossChainProvider {
  return {
    name: "venue", enabled: () => true, supportsRoute: () => true, supportsSameChain: true,
    getQuote: async (params) => ({
      provider: "venue", intentId: "intent", depositAddress: "", depositMemo: null, txRequest: request,
      sourceAmount: params.amountIn, destAmount: "2500000", minDestAmount: "2487500", feeUsd: 0, etaSeconds: 15, reliability: 1, validUntilMs: Date.now() + 30_000,
    }),
    buildDeposit: async (q) => ({chain: "", to: q.txRequest!.to!, value: q.txRequest!.value ?? "0", ...(({to: _to, value: _value, ...rest}) => rest)(q.txRequest!)}),
    trackIntent: async () => ({state: "pending"}),
    ...over,
  };
}
const nativeSale = {fromToken: "ETH", toToken: USDC, toChain: 8453, recipient: ME, fromTokenAmount: WEI, minAmountOut: 2_487_500n};
const tokenSale = {fromToken: "USDC", toToken: ETH, toChain: 8453, recipient: ME, fromTokenAmount: AMOUNT, minAmountOut: 2_487_500n};

type Call = {to?: string; data?: string; value?: bigint; gasLimit?: bigint};
interface Log { sent: Call[]; estimated: Call[] }
const fresh = (): Log => ({sent: [], estimated: []});
function account(log: Log, estimate?: (t: Call, attempt: number) => void) {
  let attempts = 0;
  return {
    getAddress: async () => ME,
    getChainId: async () => 8453,
    getBalance: async () => 10n ** 18n,
    getAllowance: async () => 0n,
    quoteSendTransaction: async (t: Call) => {
      log.estimated.push(t);
      // Only the dry run of the exact call (no gas limit, the input as value / the signature appended) is scripted.
      if (estimate && t.to === ROUTER && t.gasLimit === undefined) estimate(t, attempts++);
      return {fee: 1n};
    },
    sendTransaction: async (t: Call) => { log.sent.push(t); return {hash: `0x${log.sent.length}`}; },
    waitForTransaction: async () => {},
    signTypedData: async () => SIG,
  };
}
function protocol(p: CrossChainProvider, acc: unknown, review?: (plan: Swap2ExecutionPlan) => unknown) {
  class P extends SingleProviderSwap2 {
    protected readonly provider = p;
    protected chainSupported(): boolean { return true; }
  }
  return new P(acc as never, {fromChain: "eip155:8453", ...(review ? {reviewExecution: review as never} : {})});
}
const APPROVE = (amount: bigint) => `0x095ea7b3${PERMIT2_ADDRESS.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
/** A node's revert as viem reports it from eth_estimateGas: the revert sits in the cause chain. */
const reverted = () => { const cause = Object.assign(new Error("execution reverted: TooMuchSlippage"), {name: "ExecutionRevertedError", code: 3}); return Object.assign(new Error("Execution reverted for an unknown reason.", {cause}), {name: "EstimateGasExecutionError"}); };
/** The reviewer's transport failure: a dead RPC behind fetch (undici). */
const fetchFailed = () => Object.assign(new TypeError("fetch failed"), {cause: Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:443"), {code: "UND_ERR_CONNECT_TIMEOUT"})});
const rateLimited = () => Object.assign(new Error("HTTP request failed.\n\nStatus: 429"), {name: "HttpRequestError", status: 429});

describe("ownGasEstimate: a native sale is dry-run and sent with the account's own estimate", () => {
  it("dry-runs the exact call from the account (no gas limit) and broadcasts without the quoted limit", async () => {
    const log = fresh();
    let plan: Swap2ExecutionPlan | undefined;
    const result = await protocol(provider(nativeTx(), {ownGasEstimate: true}), account(log), (p) => { plan = p; }).swap2(nativeSale);
    expect(log.estimated.filter((e) => e.gasLimit === undefined)).toEqual([expect.objectContaining({to: ROUTER, data: DATA, value: WEI})]);
    expect(log.sent).toHaveLength(1);
    expect(log.sent[0]).toMatchObject({to: ROUTER, data: DATA, value: WEI});
    expect(log.sent[0]!.gasLimit).toBeUndefined();
    expect((plan!.source as {gasLimit?: bigint}).gasLimit).toBeUndefined();
    expect(result.hash).toBe("0x1");
  });

  it("a native sale that reverts in the dry run is not sent (simulation_failed)", async () => {
    const log = fresh();
    const err = await protocol(provider(nativeTx(), {ownGasEstimate: true}), account(log, () => { throw reverted(); })).swap2(nativeSale).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/^swap2: the swap does not simulate from this account \(Execution reverted for an unknown reason\.\) — nothing was sent$/);
    expect(refusalOf(err)?.reason).toBe("simulation_failed");
    expect(log.sent).toEqual([]);
  });

  it("a provider that does not declare it keeps its quoted gas limit (nothing changes for other venues)", async () => {
    const log = fresh();
    let plan: Swap2ExecutionPlan | undefined;
    await protocol(provider(nativeTx()), account(log, () => { throw reverted(); }), (p) => { plan = p; }).swap2(nativeSale);
    expect(log.sent[0]!.gasLimit).toBe(21000n);
    expect((plan!.source as {gasLimit?: bigint}).gasLimit).toBe(21000n);
    expect(log.estimated.every((e) => e.gasLimit !== undefined)).toBe(true);
  });
});

describe("the dry run tells a revert from the account's RPC failing", () => {
  it("a transport failure is retried once: the swap goes out when the second try answers", async () => {
    const log = fresh();
    const acc = account(log, (_t, attempt) => { if (attempt === 0) throw fetchFailed(); });
    await protocol(provider(nativeTx(), {ownGasEstimate: true}), acc).swap2(nativeSale);
    expect(log.estimated.filter((e) => e.gasLimit === undefined)).toHaveLength(2);
    expect(log.sent).toHaveLength(1);
  });

  it("a Permit2 dry run whose RPC stays down is upstream_unavailable, not simulation_failed, and is not re-quoted", async () => {
    const log = fresh();
    const err = await protocol(provider(permitTx()), account(log, () => { throw fetchFailed(); })).swap2(tokenSale).catch((e: unknown) => e);
    expect((err as Error).message).toBe("swap2: the signed swap could not be dry-run: the account's RPC did not answer (fetch failed) — nothing was sent");
    expect(refusalOf(err)?.reason).toBe("upstream_unavailable");
    expect(log.estimated.filter((e) => e.to === ROUTER && e.gasLimit === undefined)).toHaveLength(2);
    // A signature transfer: the Permit2 allowance stays (it moves nothing without a new signature).
    expect(log.sent.map((s) => s.data)).toEqual([APPROVE(AMOUNT)]);
  });

  it("a 429 from the RPC and a timeout are transport failures too", async () => {
    for (const fail of [rateLimited, () => Object.assign(new Error("The request took too long to respond."), {name: "TimeoutError"})]) {
      const log = fresh();
      const err = await protocol(provider(nativeTx(), {ownGasEstimate: true}), account(log, () => { throw fail(); })).swap2(nativeSale).catch((e: unknown) => e);
      expect(refusalOf(err)?.reason).toBe("upstream_unavailable");
      expect((err as Error).message).toMatch(/^swap2: the swap could not be dry-run: the account's RPC did not answer \(/);
      expect(log.sent).toEqual([]);
    }
  });

  it("a revert is not retried within a pass: after the approval it is quoted once more, and the Permit2 allowance stays", async () => {
    const log = fresh();
    const err = await protocol(provider(permitTx()), account(log, () => { throw reverted(); })).swap2(tokenSale).catch((e: unknown) => e);
    expect((err as Error).message).toBe("swap2: the signed swap does not simulate from this account (Execution reverted for an unknown reason.) — nothing was sent");
    expect(refusalOf(err)?.reason).toBe("simulation_failed");
    // One dry run in the first pass, one in the re-quote pass.
    expect(log.estimated.filter((e) => e.to === ROUTER && e.gasLimit === undefined)).toHaveLength(2);
    expect(log.sent.map((s) => s.data)).toEqual([APPROVE(AMOUNT)]);
  });

  it("a transport failure followed by a revert is a revert", async () => {
    const log = fresh();
    const err = await protocol(provider(nativeTx(), {ownGasEstimate: true}), account(log, (_t, attempt) => { throw attempt === 0 ? fetchFailed() : reverted(); })).swap2(nativeSale).catch((e: unknown) => e);
    expect(refusalOf(err)?.reason).toBe("simulation_failed");
  });
});

describe("a Permit2 transfer never rides with native value", () => {
  const params: QuoteParams = {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:8453", destToken: ETH, amountIn: AMOUNT.toString(), destAddress: ME, refundAddress: ME};
  const quote = (tx: TxRequest): Quote => ({provider: "venue", intentId: "i", depositAddress: "", depositMemo: null, txRequest: tx, sourceAmount: AMOUNT.toString(), destAmount: "2500000", minDestAmount: "2487500", feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 10_000});

  it("a quote with a Permit2 payload and a value or a native fee is refused (policy_refused)", () => {
    expect(quoteRejection(quote(permitTx()), params, "venue")).toBeNull();
    expect(quoteRejection(quote(permitTx({value: "1"})), params, "venue")).toEqual({reason: "policy_refused"});
    expect(quoteRejection(quote(permitTx({value: "1", nativeFee: "1"})), params, "venue")).toEqual({reason: "policy_refused"});
    expect(quoteRejection(quote(permitTx({nativeFee: "1"})), params, "venue")).toEqual({reason: "policy_refused"});
    expect(quoteRejection(quote(permitTx({value: "0", nativeFee: "0"})), params, "venue")).toBeNull();
  });

  it("the engine refuses such a swap before anything is approved or signed", async () => {
    const log = fresh();
    const err = await protocol(provider(permitTx({value: "1000", nativeFee: "1000"})), account(log)).swap2(tokenSale).catch((e: unknown) => e);
    expect(refusalOf(err)?.reason).toBe("policy_refused");
    expect(log.sent).toEqual([]);
    expect(log.estimated).toEqual([]);
  });
});
