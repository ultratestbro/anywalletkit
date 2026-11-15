// Review of 2026-11-15: each case below was a hostile quote, a caller's input or a node's answer the module let
// through before the fix (written first, seen failing, then fixed).
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {acrossQuoteOf, buildAcrossDeposit} from "../src/build.js";
import {acrossProvider} from "../src/provider.js";
import {trackAcrossDeposit, type AcrossRpc} from "../src/status.js";
import {
  ACROSS_MAX_FILL_WINDOW_S, ACROSS_MIN_FEE_PPM, acrossIntentId, acrossPins, acrossPinsWith, acrossRequestOf, acrossVerifyQuote,
  verifyAcrossDeposit,
} from "../src/verify.js";
import {
  ARB, ARB_USDC, BASE, NOW_MS, NOW_S, OTHER, USER, ZERO, ethRequest, merged, recordedIntentId, refused, rpcFrom, statusFixture, txOf, usdcArgs,
  usdcQuote, usdcRequest, type Loose, type StatusFixture,
} from "./fixtures.js";

// The pins and the provider judge deadlines by the clock; the fixtures' requests carry their own.
beforeEach(() => { vi.useFakeTimers({toFake: ["Date"], now: NOW_MS}); });
afterEach(() => { vi.useRealTimers(); });

const noExclusivity = {exclusiveRelayer: ZERO, exclusivityParameter: 0} as const;

describe("a deposit nobody fills is not signed, and an unfilled one is not held for hours", () => {
  it("a zero fee is refused (relayers lose money on the fill, the funds wait for the refund)", () => {
    expect(refused(() => acrossQuoteOf(usdcRequest({minAmountOut: undefined}), usdcQuote({outputAmount: "25000000", fees: undefined})), "tx-fee", "price_check_failed")).toMatch(/no fee/);
  });

  it("a dust fee under the floor is refused; the floor itself passes", () => {
    const floor = (25_000_000n * BigInt(ACROSS_MIN_FEE_PPM.stable)) / 1_000_000n;
    const req = usdcRequest({minAmountOut: undefined});
    verifyAcrossDeposit(req, txOf(usdcArgs({outputAmount: 25_000_000n - floor})));
    expect(refused(() => verifyAcrossDeposit(req, txOf(usdcArgs({outputAmount: 25_000_000n - floor + 1n}))), "tx-fee", "price_check_failed")).toMatch(/floor/);
    refused(() => verifyAcrossDeposit(req, txOf(usdcArgs({outputAmount: 24_999_999n}))), "tx-fee", "price_check_failed");
  });

  it("a fill deadline past what an Across quote gives (two hours from the quote time, ten minutes of margin) is refused", () => {
    // The reviewer's case: no fee left out, the deadline pushed to the SpokePool's own 6 h limit.
    refused(() => acrossQuoteOf(usdcRequest(), usdcQuote({...noExclusivity, quoteTimestamp: NOW_S, fillDeadline: NOW_S + 21_400})), "tx-fill-deadline", "policy_refused");
    const qt = NOW_S - 60;
    verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs({quoteTimestamp: qt, fillDeadline: qt + ACROSS_MAX_FILL_WINDOW_S})));
    expect(refused(() => verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs({quoteTimestamp: qt, fillDeadline: qt + ACROSS_MAX_FILL_WINDOW_S + 1}))), "tx-fill-deadline", "policy_refused")).toMatch(/after the quote time/);
  });
});

describe("deadlines hold for a deposit that lands as late as the SpokePool still takes it (quote time + 3600 s)", () => {
  it("a fill deadline the deposit could land after is refused", () => {
    // The reviewer's case B: valid on chain until now + 3600, expired from now + 1800.
    refused(() => buildAcrossDeposit(usdcRequest(), usdcQuote({...noExclusivity, quoteTimestamp: NOW_S, fillDeadline: NOW_S + 1800})), "tx-fill-deadline", "policy_refused");
    // A relayer keeps 1800 s even after the last landing.
    const qt = NOW_S - 60;
    verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs({...noExclusivity, quoteTimestamp: qt, fillDeadline: qt + 3600 + 1800})));
    expect(refused(() => verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs({...noExclusivity, quoteTimestamp: qt, fillDeadline: qt + 3600 + 1799}))), "tx-fill-deadline", "policy_refused")).toMatch(/land/);
  });

  it("an exclusivity offset is refused (since the quoting review: no exclusivity at all)", () => {
    // The reviewer's case C: offset 3600 with a deadline the check let through.
    refused(() => buildAcrossDeposit(usdcRequest(), usdcQuote({quoteTimestamp: NOW_S, fillDeadline: NOW_S + 4500, exclusiveRelayer: OTHER, exclusivityParameter: 3600})), "tx-exclusivity", "policy_refused");
    const qt = NOW_S - 60;
    const fd = qt + 3600 + 1800;
    refused(() => verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs({quoteTimestamp: qt, fillDeadline: fd, exclusiveRelayer: OTHER, exclusivityParameter: 1200}))), "tx-exclusivity", "policy_refused");
    verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs({quoteTimestamp: qt, fillDeadline: fd, ...noExclusivity})));
  });
});

describe("the depositor is the account that signs, never a refund address the caller names", () => {
  const params = (over: Loose<QuoteParams> = {}): QuoteParams => merged<QuoteParams>({
    sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: ARB_USDC, amountIn: "25000000",
    destAddress: USER, refundAddress: USER, sender: USER, dry: false,
  }, over);

  it("a refund address other than the signer is refused (it could re-point the output with a speed-up signature)", () => {
    expect(refused(() => acrossRequestOf(params({refundAddress: OTHER})), "request-invalid", "recipient_mismatch")).toMatch(/speed-up/);
    // The signer itself, in any casing, is fine; so is no refund address at all.
    expect(acrossRequestOf(params({refundAddress: USER.toUpperCase().replace("0X", "0x")})).depositor).toBe(USER);
    expect(acrossRequestOf(params({refundAddress: undefined})).depositor).toBe(USER);
  });

  it("a live request names its signer: a refund address alone is not one", () => {
    expect(refused(() => acrossRequestOf(params({sender: undefined})), "request-invalid")).toMatch(/sign/);
    refused(() => acrossRequestOf(params({sender: "0x12"})), "request-invalid");
  });

  it("a dry quote is priced for whatever address there is (never built)", () => {
    expect(acrossRequestOf(params({sender: undefined, dry: true}), {placeholder: OTHER}).depositor).toBe(USER);
    expect(acrossRequestOf(params({sender: undefined, refundAddress: undefined, dry: true}), {placeholder: OTHER}).depositor).toBe(OTHER);
    refused(() => acrossRequestOf(params({refundAddress: OTHER, dry: true}), {placeholder: OTHER}), "request-invalid", "recipient_mismatch");
  });

  it("the remote pins refuse a quote whose depositor is the named refund address", () => {
    const attacker = "0x000000000000000000000000000000000000beef";
    const quote = acrossQuoteOf(usdcRequest({depositor: attacker, minAmountOut: undefined}), usdcQuote());
    const text = acrossVerifyQuote(params({refundAddress: attacker}), quote);
    expect(text).toMatch(/\[request-invalid\]$/);
    expect(acrossPins.reasonOf!(text!)).toEqual({reason: "recipient_mismatch"});
    // With the signer as the depositor the same numbers verify.
    expect(acrossVerifyQuote(params(), acrossQuoteOf(usdcRequest({minAmountOut: undefined}), usdcQuote()))).toBeNull();
  });
});

describe("the remote pins take the app's fee cap", () => {
  const params: QuoteParams = {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: ARB_USDC, amountIn: "25000000", destAddress: USER, refundAddress: USER, sender: USER, dry: false};
  const withFee = (bps: number) => {
    const out = 25_000_000n - (25_000_000n * BigInt(bps)) / 10_000n;
    return acrossQuoteOf(usdcRequest({minAmountOut: undefined, maxFeeBps: 5000}), usdcQuote({outputAmount: out.toString(10), fees: undefined}));
  };

  it("a stricter cap refuses what the default 10 % lets through", () => {
    expect(acrossPins.verifyQuote!(params, withFee(300))).toBeNull();
    const strict = acrossPinsWith({maxFeeBps: 50});
    expect(strict.verifyQuote!(params, withFee(300))).toMatch(/\[tx-fee\]$/);
    expect(strict.reasonOf!(strict.verifyQuote!(params, withFee(300))!)).toEqual({reason: "price_check_failed"});
    const q = withFee(300);
    const tx = {chain: "eip155:8453", to: q.txRequest!.to!, data: q.txRequest!.data!, value: "0", chainId: 8453, approvalAddress: BASE.spokePool};
    expect(acrossPins.verifyBuild!(q, tx, params)).toBeNull();
    expect(strict.verifyBuild!(q, tx, params)).toMatch(/\[tx-fee\]$/);
  });

  it("a wider cap matches a server that runs one", () => {
    expect(acrossPins.verifyQuote!(params, withFee(1500))).toMatch(/\[tx-fee\]$/);
    expect(acrossPinsWith({maxFeeBps: 3000}).verifyQuote!(params, withFee(1500))).toBeNull();
  });

  it("the cap is validated like the provider's", () => {
    expect(() => acrossPinsWith({maxFeeBps: 5001})).toThrow(/maxFeeBps/);
    expect(() => acrossPinsWith({maxFeeBps: -1})).toThrow(/maxFeeBps/);
    expect(() => acrossPinsWith({maxFeeBps: 1.5})).toThrow(/maxFeeBps/);
  });
});

describe("display numbers are the deposit's, not the quote source's", () => {
  it("an expected output above what the deposit asks relayers for is refused", () => {
    refused(() => acrossQuoteOf(usdcRequest(), usdcQuote({expectedOutputAmount: "24990968"})), "quote-normalized", "price_check_failed");
    expect(acrossQuoteOf(usdcRequest(), usdcQuote({expectedOutputAmount: "24990967"})).providerData!.expectedOutputAmount).toBe("24990967");
  });

  it("feeUsd is the verified fee of a dollar stablecoin, never the source's price; 0 where no price is known", () => {
    const fees = {total: "9033", totalUsd: 0};
    expect(acrossQuoteOf(usdcRequest(), usdcQuote({fees})).feeUsd).toBeCloseTo(0.009033, 9);
    expect(acrossQuoteOf(usdcRequest(), usdcQuote({fees: {total: "9033", totalUsd: 500}})).feeUsd).toBeCloseTo(0.009033, 9);
    const eth = acrossQuoteOf(ethRequest(), {
      sourceChainId: 8453, destinationChainId: 42161, inputToken: ZERO, outputToken: ZERO, inputAmount: "10000000000000000", outputAmount: "9994000000000000",
      quoteTimestamp: NOW_S - 60, fillDeadline: NOW_S - 60 + 7200, exclusiveRelayer: ZERO, exclusivityParameter: 0, expectedFillTimeSec: 2,
      fees: {total: "6000000000000", totalUsd: 123},
    });
    expect(eth.feeUsd).toBe(0);
    expect(eth.fees).toEqual([{type: "protocol", amount: "6000000000000", token: ZERO, included: true, description: "Across relayer and LP fee"}]);
  });
});

describe("tracking is tied to the intent's own deposit", () => {
  const USDC_DEPOSIT = statusFixture("base-arb-usdc-deposit");
  const WETH_DEPOSIT = statusFixture("base-arb-weth-depositv3");
  const EXPIRED = statusFixture("base-arb-expired");
  const rpcs = {"eip155:8453": "https://base.example", "eip155:42161": "https://arb.example"};

  it("an unrelated filled deposit's transaction does not complete another intent", async () => {
    const mine = buildAcrossDeposit(usdcRequest({nowMs: NOW_MS}), usdcQuote());
    const intentId = acrossIntentId(8453, 42161, mine.deposit.data);
    const p = acrossProvider({rpcUrls: rpcs, fetchImpl: rpcFrom(WETH_DEPOSIT, 1)});
    expect(await p.trackIntent({intentId, sourceTxHash: WETH_DEPOSIT.source.txHash})).toEqual({state: "pending"});
  });

  it("the intent's own deposit is found: from its event, the offset exclusivity resolved against the source block", async () => {
    for (const [f, read, state] of [[WETH_DEPOSIT, 1, "completed"], [WETH_DEPOSIT, 0, "pending"], [USDC_DEPOSIT, 0, "completed"]] as [StatusFixture, number, string][]) {
      const p = acrossProvider({rpcUrls: rpcs, fetchImpl: rpcFrom(f, read)});
      expect(await p.trackIntent({intentId: recordedIntentId(f), sourceTxHash: f.source.txHash})).toEqual({state, depositReceived: true});
    }
  });

  it("a successful receipt with no deposit of this intent, or two, stays pending — never a terminal failure", async () => {
    const digest = recordedIntentId(USDC_DEPOSIT).split(":")[3]!;
    const log = USDC_DEPOSIT.source.receipt.logs.find((l) => l.address.toLowerCase() === BASE.spokePool)!;
    const block: AcrossRpc = async (m) => (m === "eth_getBlockByNumber" ? USDC_DEPOSIT.source.block : null);
    const answering = (receipt: unknown): AcrossRpc => async (m, ps) => (m === "eth_getTransactionReceipt" ? receipt : block(m, ps));
    const track = (receipt: unknown) => trackAcrossDeposit({sourceTxHash: USDC_DEPOSIT.source.txHash, intentDigest: digest, source: BASE, dest: ARB, sourceRpc: answering(receipt)});
    expect((await track({...USDC_DEPOSIT.source.receipt, logs: []})).status).toEqual({state: "pending"});
    expect((await track({...USDC_DEPOSIT.source.receipt, logs: [log, {...log, logIndex: "0x999"}]})).status).toEqual({state: "pending"});
    expect((await track(USDC_DEPOSIT.source.receipt)).status).toEqual({state: "pending", depositReceived: true});
  });

  it("past its fill deadline unfilled: expired, a terminal state (the refund is Across's, and not watched here)", async () => {
    const p = acrossProvider({rpcUrls: rpcs, fetchImpl: rpcFrom(EXPIRED, 0)});
    expect(await p.trackIntent({intentId: recordedIntentId(EXPIRED), sourceTxHash: EXPIRED.source.txHash})).toEqual({state: "expired", depositReceived: true});
  });
});
