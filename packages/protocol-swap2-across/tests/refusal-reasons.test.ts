// CS-13: every refusal code, raised through the real code path, with the reason it carries. The table is typed as a
// Record over AcrossRefusalCode, so a new code without a case here does not compile.
import {describe, expect, it} from "vitest";
import {SWAP2_REFUSAL_REASONS, refusalOf, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import type {UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {acrossQuoteOf, buildAcrossDeposit} from "../src/build.js";
import {decodeAcrossDeposit, encodeAcrossDeposit} from "../src/deposit.js";
import {ACROSS_V5_MESSAGE_PREFIX} from "../src/config.js";
import {acrossProvider} from "../src/provider.js";
import {acrossHttp, readAcrossV5Quote} from "../src/api.js";
import {acrossRouteOf, type AcrossRoute} from "../src/config.js";
import {acrossPlainFee} from "../src/pricing.js";
import {AcrossRefusal, type AcrossRefusalCode} from "../src/refusal.js";
import {acrossRequestOf, checkAcrossQuote, checkAcrossTxShape, verifyAcrossDeposit} from "../src/verify.js";
import {ARB, ARB_USDT0, ARB_WETH, BASE, NOW_MS, NOW_S, OTHER, ZERO, ethArgs, ethRequest, ethTxOf, txOf, usdcArgs, usdcQuote, usdcRequest} from "./fixtures.js";

const quote = () => acrossQuoteOf(usdcRequest(), usdcQuote());
const usdcRoute = acrossRouteOf("eip155:8453", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "eip155:42161", "0xaf88d065e77c8cc2239327c5edb3a432268e5831") as AcrossRoute;
const toEthereum = {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:1", destToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", amountIn: "1000000", destAddress: OTHER, sender: OTHER, dry: false};
const tx: UnsignedTx = {chain: "eip155:8453", to: BASE.spokePool, data: encodeAcrossDeposit(usdcArgs()), value: "0", chainId: 8453, approvalAddress: BASE.spokePool};

/** Each code: how it is raised, and the reason (undefined = a caller's bug, no reason). */
const CASES: Record<AcrossRefusalCode, [() => unknown, Swap2RefusalReason | undefined]> = {
  "request-invalid": [() => verifyAcrossDeposit(usdcRequest({amount: 0n}), txOf(usdcArgs())), undefined],
  "chain-unsupported": [() => verifyAcrossDeposit(usdcRequest({destChain: "eip155:56"}), txOf(usdcArgs())), "unsupported_pair"],
  "token-unsupported": [() => verifyAcrossDeposit(usdcRequest({sourceToken: OTHER}), txOf(usdcArgs())), "unsupported_pair"],
  "pair-unsupported": [() => verifyAcrossDeposit(usdcRequest({destToken: ARB_USDT0}), txOf(usdcArgs())), "unsupported_pair"],
  "native-unsupported": [() => verifyAcrossDeposit(ethRequest({sourceChain: "eip155:137"}), txOf(usdcArgs())), "unsupported_pair"],
  "wrapped-native-destination": [() => verifyAcrossDeposit(usdcRequest({destToken: ARB_WETH}), txOf(usdcArgs())), "unsupported_pair"],
  "route-unpriced": [() => acrossRequestOf(toEthereum), "unsupported_pair"],
  "quote-unavailable": [() => new AcrossRefusal("quote-unavailable", "x", "policy_refused"), "policy_refused"],
  "quote-normalized": [() => buildAcrossDeposit(usdcRequest(), usdcQuote({outputAmount: "x"})), "upstream_unavailable"],
  "tx-shape": [() => checkAcrossTxShape({...tx, memo: "x"}), "policy_refused"],
  "tx-chain": [() => verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs(), {chainId: 1})), "vault_mismatch"],
  "tx-target": [() => verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs(), {to: ARB.spokePool})), "vault_mismatch"],
  "tx-selector": [() => decodeAcrossDeposit(`0x8b15788e${"00".repeat(416)}`), "policy_refused"],
  "tx-calldata": [() => decodeAcrossDeposit(`${encodeAcrossDeposit(usdcArgs())}73c0de`), "policy_refused"],
  "tx-depositor": [() => verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs({depositor: OTHER}))), "recipient_mismatch"],
  "tx-recipient": [() => verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs({recipient: OTHER}))), "recipient_mismatch"],
  "tx-input-token": [() => verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs({inputToken: ARB_USDT0}))), "policy_refused"],
  "tx-output-token": [() => verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs({outputToken: ARB_USDT0}))), "price_check_failed"],
  "tx-input-amount": [() => verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs({inputAmount: 1n, outputAmount: 1n}))), "policy_refused"],
  "tx-output-amount": [() => verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs({outputAmount: 1n}))), "price_check_failed"],
  "tx-fee": [() => verifyAcrossDeposit(usdcRequest({minAmountOut: undefined, maxFeeBps: 0}), txOf(usdcArgs())), "price_check_failed"],
  "tx-destination": [() => verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs({destinationChainId: 10n}))), "recipient_mismatch"],
  "tx-message": [() => verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs({message: "0x01"}))), "policy_refused"],
  "tx-message-v5": [() => verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs({message: ACROSS_V5_MESSAGE_PREFIX as `0x${string}`}))), "policy_refused"],
  "tx-exclusivity": [() => verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs({exclusiveRelayer: ZERO}))), "policy_refused"],
  "tx-quote-time": [() => verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs({quoteTimestamp: NOW_S - 3500}))), "quote_expired"],
  "tx-fill-deadline": [() => verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs({fillDeadline: NOW_S + 30_000}))), "policy_refused"],
  "tx-value": [() => verifyAcrossDeposit(ethRequest(), ethTxOf(ethArgs(), {value: "0"})), "policy_refused"],
  "tx-approval": [() => verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs(), {approvalAddress: OTHER})), "vault_mismatch"],
  "speed-up": [() => checkAcrossTxShape({...tx, typedData: JSON.stringify({primaryType: "UpdateDepositDetails"})}), "policy_refused"],
  "quote-shape": [() => checkAcrossQuote(usdcRequest(), {...quote(), depositAddress: OTHER}), "vault_mismatch"],
  "quote-amounts": [() => checkAcrossQuote(usdcRequest(), {...quote(), destAmount: "1"}), "price_check_failed"],
  "quote-expiry": [() => checkAcrossQuote(usdcRequest(), {...quote(), validUntilMs: NOW_MS + 3_600_000}), "policy_refused"],
  "quote-gas": [() => checkAcrossQuote(usdcRequest(), {...quote(), txRequest: {...quote().txRequest!, gasLimit: "1"}}), "policy_refused"],
  "quote-intent": [() => checkAcrossQuote(usdcRequest(), {...quote(), intentId: "across:1:2:" + "0".repeat(32)}), "policy_refused"],
  "api-error": [() => new AcrossRefusal("api-error", "x", "upstream_unavailable"), "upstream_unavailable"],
  "api-answer": [() => readAcrossV5Quote(usdcRequest(), usdcRoute, null), "upstream_unavailable"],
  "relayer-price": [() => acrossPlainFee(100n, {totalFee: 100n, originGas: 0n}, 100n), "amount_too_small"],
};

describe("refusal reasons (CS-13)", () => {
  for (const [code, [raise, reason]] of Object.entries(CASES) as [AcrossRefusalCode, [() => unknown, Swap2RefusalReason | undefined]][]) {
    it(`${code} → ${reason ?? "(none)"}`, () => {
      let err: unknown;
      try {
        const out = raise();
        if (out instanceof AcrossRefusal) err = out;
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AcrossRefusal);
      expect((err as AcrossRefusal).code).toBe(code);
      expect((err as AcrossRefusal).message).toMatch(new RegExp(`^across: .+ \\[${code}\\]$`));
      expect(refusalOf(err)?.reason).toBe(reason);
    });
  }

  it("every reason used is one of the core's", () => {
    for (const [, reason] of Object.values(CASES)) if (reason) expect(SWAP2_REFUSAL_REASONS).toContain(reason);
  });

  it("the provider's own refusals reach onRefusal with their reason: no key, an unpriced route", async () => {
    const reasons: unknown[] = [];
    await acrossProvider().getQuote({sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", amountIn: "1000000", destAddress: OTHER, refundAddress: OTHER, onRefusal: (_t, i) => reasons.push(i)});
    await acrossProvider({apiKey: "k"}).getQuote({...toEthereum, onRefusal: (_t, i) => reasons.push(i)});
    expect(reasons).toEqual([{reason: "key_rejected"}, {reason: "unsupported_pair"}]);
  });

  it("the HTTP paths: a redirect is policy_refused, no answer upstream_unavailable", async () => {
    const redirected = (async () => Object.defineProperty(new Response("{}"), "redirected", {value: true})) as unknown as typeof fetch;
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const at = (fetchImpl: typeof fetch) => acrossHttp("https://api.across.to/v1/quotes", {method: "POST", headers: {}}, {fetchImpl, timeoutMs: 1000, what: "Across API V5"}).catch((e: unknown) => e);
    expect(refusalOf(await at(redirected))?.reason).toBe("policy_refused");
    expect(refusalOf(await at(down))?.reason).toBe("upstream_unavailable");
  });
});
