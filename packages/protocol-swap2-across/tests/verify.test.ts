import {describe, expect, it} from "vitest";
import {encodeAcrossDeposit} from "../src/deposit.js";
import {ACROSS_V5_MESSAGE_PREFIX, acrossChain, acrossRouteOf} from "../src/config.js";
import {
  ACROSS_DEFAULT_MAX_FEE_BPS, ACROSS_LANDING_WINDOW_S, ACROSS_MIN_FILL_WINDOW_S, ACROSS_MIN_OPEN_FILL_S, acrossRequestOf,
  checkAcrossRequest, isAcrossSpeedUpTypedData, verifyAcrossDeposit,
} from "../src/verify.js";
import {
  ARB, ARB_USDC, ARB_USDT0, ARB_WETH, BASE, BASE_USDC, ETH_USDT, FRIEND, NOW_S, OTHER, RELAYER, USER, WETH_OP, ZERO, apiQuote,
  ethArgs, ethRequest, ethTxOf, refused, txOf, usdcArgs, usdcRequest,
} from "./fixtures.js";

const DEAD = "0x000000000000000000000000000000000000dEaD";

describe("verifyAcrossDeposit: what passes", () => {
  it("an ERC-20 deposit: the pinned SpokePool, value 0, the SpokePool approved", () => {
    const v = verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs()));
    expect(v.deposit).toEqual({to: BASE.spokePool, data: encodeAcrossDeposit(usdcArgs()), value: "0", chainId: 8453, approvalAddress: BASE.spokePool});
    expect(v.fee).toBe(9033n);
    expect(v.route.asset).toBe("USDC");
  });

  it("the native coin: wrapped native token in, value = amount, no approval; native out = the destination's wrapped native token", () => {
    const v = verifyAcrossDeposit(ethRequest(), ethTxOf(ethArgs()));
    expect(v.deposit.value).toBe("10000000000000000");
    expect(v.deposit.approvalAddress).toBeUndefined();
    expect(v.route.input).toMatchObject({token: WETH_OP, native: true});
    expect(v.route.output).toMatchObject({token: ARB_WETH, native: true});
  });

  it("WETH as an ERC-20 source to the native coin; USDT to USDT0; a recipient other than the sender; no exclusivity", () => {
    verifyAcrossDeposit(ethRequest({sourceToken: WETH_OP}), txOf(ethArgs()));
    const usdt = {sourceChain: "eip155:1", sourceToken: ETH_USDT, destToken: ARB_USDT0};
    verifyAcrossDeposit(usdcRequest(usdt), {...txOf(usdcArgs({inputToken: ETH_USDT, outputToken: ARB_USDT0})), to: acrossChain("eip155:1")!.spokePool, chainId: 1, approvalAddress: acrossChain("eip155:1")!.spokePool});
    verifyAcrossDeposit(usdcRequest({recipient: FRIEND}), txOf(usdcArgs({recipient: FRIEND})));
    verifyAcrossDeposit(usdcRequest(), txOf(usdcArgs({exclusiveRelayer: ZERO, exclusivityParameter: 0})));
  });

  it("Across's own API calldata for the same request passes once the marker is off (the numbers fit every bound)", () => {
    const q = apiQuote("base-usdc-arb-usdc");
    const req = usdcRequest({depositor: DEAD, recipient: DEAD, minAmountOut: BigInt(q.minOutputAmount!), nowMs: q.serverTimeMs});
    const tx = {to: q.tx.to, data: q.tx.data.slice(0, -6), value: "0", chainId: 8453, approvalAddress: BASE.spokePool};
    expect(verifyAcrossDeposit(req, tx).args.outputAmount).toBe(24_990_967n);
    // As handed out (marker on), it is refused: the bytes signed are the canonical call.
    refused(() => verifyAcrossDeposit(req, {...tx, data: q.tx.data}), "tx-calldata", "policy_refused");
  });

  it("and USDT → USDT0, whose exclusivity is a timestamp", () => {
    const q = apiQuote("eth-usdt-arb-usdt0");
    const req = usdcRequest({sourceChain: "eip155:1", sourceToken: ETH_USDT, destToken: ARB_USDT0, depositor: DEAD, recipient: DEAD, minAmountOut: undefined, nowMs: q.serverTimeMs});
    const spoke = acrossChain("eip155:1")!.spokePool;
    const v = verifyAcrossDeposit(req, {to: q.tx.to, data: q.tx.data.slice(0, -6), value: "0", chainId: 1, approvalAddress: spoke});
    expect(v.args.exclusivityParameter).toBeGreaterThan(31_536_000);
  });
});

describe("verifyAcrossDeposit: the request", () => {
  const tx = txOf(usdcArgs());
  it("unserved routes", () => {
    refused(() => verifyAcrossDeposit(usdcRequest({sourceChain: "eip155:56"}), tx), "chain-unsupported", "unsupported_pair");
    refused(() => verifyAcrossDeposit(usdcRequest({destChain: "eip155:534352"}), tx), "chain-unsupported", "unsupported_pair");
    refused(() => verifyAcrossDeposit(usdcRequest({destChain: "eip155:8453", destToken: BASE_USDC}), tx), "chain-unsupported", "unsupported_pair");
    refused(() => verifyAcrossDeposit(usdcRequest({sourceToken: OTHER}), tx), "token-unsupported", "unsupported_pair");
    refused(() => verifyAcrossDeposit(usdcRequest({destToken: OTHER}), tx), "token-unsupported", "unsupported_pair");
    refused(() => verifyAcrossDeposit(usdcRequest({destToken: ARB_USDT0}), tx), "pair-unsupported", "unsupported_pair");
    refused(() => verifyAcrossDeposit(usdcRequest({destToken: ZERO}), tx), "pair-unsupported", "unsupported_pair");
    refused(() => verifyAcrossDeposit(usdcRequest({destToken: ARB_WETH}), tx), "wrapped-native-destination", "unsupported_pair");
    refused(() => verifyAcrossDeposit(ethRequest({sourceChain: "eip155:137"}), tx), "native-unsupported", "unsupported_pair");
    refused(() => verifyAcrossDeposit(ethRequest({destChain: "eip155:43114"}), tx), "native-unsupported", "unsupported_pair");
    // Arc's gas coin is not bridged as a native coin (no wrapped native token on its SpokePool).
    refused(() => verifyAcrossDeposit(usdcRequest({destChain: "eip155:5042", destToken: ZERO}), tx), "native-unsupported", "unsupported_pair");
  });

  it("parties and numbers", () => {
    refused(() => verifyAcrossDeposit(usdcRequest({depositor: ZERO}), tx), "request-invalid", "recipient_mismatch");
    refused(() => verifyAcrossDeposit(usdcRequest({recipient: ZERO}), tx), "request-invalid", "recipient_mismatch");
    refused(() => verifyAcrossDeposit(usdcRequest({maxFeeBps: 5001}), tx), "request-invalid", "policy_refused");
    // The caller's own bugs carry no reason.
    refused(() => verifyAcrossDeposit(usdcRequest({depositor: "0x12"}), tx), "request-invalid");
    refused(() => verifyAcrossDeposit(usdcRequest({amount: 0n}), tx), "request-invalid");
    refused(() => verifyAcrossDeposit(usdcRequest({minAmountOut: -1n}), tx), "request-invalid");
    refused(() => verifyAcrossDeposit(usdcRequest({nowMs: Number.NaN}), tx), "request-invalid");
    refused(() => verifyAcrossDeposit(null as never, tx), "request-invalid");
  });
});

describe("verifyAcrossDeposit: a negative for every field", () => {
  const req = usdcRequest();
  const ok = usdcArgs();

  it("target and chain", () => {
    refused(() => verifyAcrossDeposit(req, txOf(ok, {to: ARB.spokePool})), "tx-target", "vault_mismatch");
    refused(() => verifyAcrossDeposit(req, txOf(ok, {to: "0x97ccdbea4632140639ad5ea9b944aa034eb15fd4"})), "tx-target", "vault_mismatch");
    refused(() => verifyAcrossDeposit(req, txOf(ok, {to: undefined})), "tx-target", "vault_mismatch");
    refused(() => verifyAcrossDeposit(req, txOf(ok, {chainId: 42161})), "tx-chain", "vault_mismatch");
    refused(() => verifyAcrossDeposit(req, txOf(ok, {chainId: "8453"})), "tx-chain", "vault_mismatch");
    refused(() => verifyAcrossDeposit(req, null as never), "tx-shape", "policy_refused");
  });

  it("the target is checked before the calldata is read", () => {
    refused(() => verifyAcrossDeposit(req, {to: OTHER, data: "0xnothex", value: "0", chainId: 8453}), "tx-target", "vault_mismatch");
  });

  it("depositor, recipient, destination", () => {
    refused(() => verifyAcrossDeposit(req, txOf({...ok, depositor: OTHER})), "tx-depositor", "recipient_mismatch");
    refused(() => verifyAcrossDeposit(req, txOf({...ok, recipient: OTHER})), "tx-recipient", "recipient_mismatch");
    refused(() => verifyAcrossDeposit(req, txOf({...ok, destinationChainId: 10n})), "tx-destination", "recipient_mismatch");
    refused(() => verifyAcrossDeposit(req, txOf({...ok, destinationChainId: 8453n})), "tx-destination", "recipient_mismatch");
  });

  it("input token and amount", () => {
    refused(() => verifyAcrossDeposit(req, txOf({...ok, inputToken: ARB_USDC})), "tx-input-token", "policy_refused");
    refused(() => verifyAcrossDeposit(req, txOf({...ok, inputAmount: 25_000_001n, outputAmount: 24_990_967n})), "tx-input-amount", "policy_refused");
    refused(() => verifyAcrossDeposit(req, txOf({...ok, inputAmount: 24_999_999n})), "tx-input-amount", "policy_refused");
  });

  it("output token, amount, floor and fee", () => {
    refused(() => verifyAcrossDeposit(req, txOf({...ok, outputToken: ARB_USDT0})), "tx-output-token", "price_check_failed");
    refused(() => verifyAcrossDeposit(req, txOf({...ok, outputToken: OTHER})), "tx-output-token", "price_check_failed");
    refused(() => verifyAcrossDeposit(usdcRequest({minAmountOut: undefined}), txOf({...ok, outputAmount: 0n})), "tx-output-amount", "price_check_failed");
    expect(refused(() => verifyAcrossDeposit(req, txOf({...ok, outputAmount: 24_899_999n})), "tx-output-amount", "price_check_failed")).toMatch(/floor/);
    expect(refused(() => verifyAcrossDeposit(req, txOf({...ok, outputAmount: 25_000_001n})), "tx-output-amount", "price_check_failed")).toMatch(/more than its/);
    // No floor from the caller: the fee cap (10 % by default) still binds.
    const cap = (25_000_000n * BigInt(ACROSS_DEFAULT_MAX_FEE_BPS)) / 10_000n;
    verifyAcrossDeposit(usdcRequest({minAmountOut: undefined}), txOf({...ok, outputAmount: 25_000_000n - cap}));
    refused(() => verifyAcrossDeposit(usdcRequest({minAmountOut: undefined}), txOf({...ok, outputAmount: 25_000_000n - cap - 1n})), "tx-fee", "price_check_failed");
    refused(() => verifyAcrossDeposit(usdcRequest({minAmountOut: undefined, maxFeeBps: 1}), txOf(ok)), "tx-fee", "price_check_failed");
    // A zero fee is not refused (a deposit nobody fills is refunded).
    verifyAcrossDeposit(req, txOf({...ok, outputAmount: 25_000_000n}));
  });

  it("the message: empty only, the V5 witness prefix by name", () => {
    expect(refused(() => verifyAcrossDeposit(req, txOf({...ok, message: "0xdeadbeef"})), "tx-message", "policy_refused")).toMatch(/4-byte message/);
    refused(() => verifyAcrossDeposit(req, txOf({...ok, message: `${ACROSS_V5_MESSAGE_PREFIX}${"11".repeat(32)}` as `0x${string}`})), "tx-message-v5", "policy_refused");
    refused(() => verifyAcrossDeposit(req, txOf({...ok, message: ACROSS_V5_MESSAGE_PREFIX as `0x${string}`})), "tx-message-v5", "policy_refused");
    // 31 bytes of the prefix is not the prefix, but still a message.
    refused(() => verifyAcrossDeposit(req, txOf({...ok, message: ACROSS_V5_MESSAGE_PREFIX.slice(0, 64) as `0x${string}`})), "tx-message", "policy_refused");
  });

  it("exclusivity", () => {
    refused(() => verifyAcrossDeposit(req, txOf({...ok, exclusivityParameter: 0})), "tx-exclusivity", "policy_refused");
    refused(() => verifyAcrossDeposit(req, txOf({...ok, exclusiveRelayer: ZERO})), "tx-exclusivity", "policy_refused");
    // An offset of an hour passes, one beyond it does not.
    verifyAcrossDeposit(req, txOf({...ok, exclusivityParameter: 3600}));
    refused(() => verifyAcrossDeposit(req, txOf({...ok, exclusivityParameter: 3601})), "tx-exclusivity", "policy_refused");
    // A timestamp: past is no exclusivity; too close to the fill deadline is refused.
    verifyAcrossDeposit(req, txOf({...ok, exclusivityParameter: NOW_S - 600}));
    verifyAcrossDeposit(req, txOf({...ok, fillDeadline: NOW_S + 3000, exclusivityParameter: NOW_S + 3000 - ACROSS_MIN_OPEN_FILL_S}));
    expect(refused(() => verifyAcrossDeposit(req, txOf({...ok, fillDeadline: NOW_S + 3000, exclusivityParameter: NOW_S + 3000 - ACROSS_MIN_OPEN_FILL_S + 1})), "tx-exclusivity", "policy_refused")).toMatch(/before the fill deadline/);
    // A timestamp more than an hour out.
    expect(refused(() => verifyAcrossDeposit(req, txOf({...ok, exclusivityParameter: NOW_S + 3600 + ACROSS_LANDING_WINDOW_S + 1})), "tx-exclusivity", "policy_refused")).toMatch(/alone/);
    // An offset that would run into the fill deadline.
    const fd = NOW_S + ACROSS_MIN_FILL_WINDOW_S;
    refused(() => verifyAcrossDeposit(req, txOf({...ok, fillDeadline: fd, exclusivityParameter: fd - NOW_S - ACROSS_MIN_OPEN_FILL_S - ACROSS_LANDING_WINDOW_S + 1})), "tx-exclusivity", "policy_refused");
  });

  it("quote time", () => {
    verifyAcrossDeposit(req, txOf({...ok, quoteTimestamp: NOW_S + 120}));
    refused(() => verifyAcrossDeposit(req, txOf({...ok, quoteTimestamp: NOW_S + 121})), "tx-quote-time", "policy_refused");
    verifyAcrossDeposit(req, txOf({...ok, quoteTimestamp: NOW_S - 3300}));
    refused(() => verifyAcrossDeposit(req, txOf({...ok, quoteTimestamp: NOW_S - 3301})), "tx-quote-time", "quote_expired");
  });

  it("fill deadline", () => {
    verifyAcrossDeposit(req, txOf({...ok, fillDeadline: NOW_S + ACROSS_MIN_FILL_WINDOW_S}));
    refused(() => verifyAcrossDeposit(req, txOf({...ok, fillDeadline: NOW_S + ACROSS_MIN_FILL_WINDOW_S - 1, exclusiveRelayer: ZERO, exclusivityParameter: 0})), "tx-fill-deadline", "quote_expired");
    refused(() => verifyAcrossDeposit(req, txOf({...ok, fillDeadline: NOW_S - 1, exclusiveRelayer: ZERO, exclusivityParameter: 0})), "tx-fill-deadline", "quote_expired");
    verifyAcrossDeposit(req, txOf({...ok, fillDeadline: NOW_S + 21_600 - 120}));
    refused(() => verifyAcrossDeposit(req, txOf({...ok, fillDeadline: NOW_S + 21_600 - 119})), "tx-fill-deadline", "policy_refused");
  });

  it("value and approval", () => {
    refused(() => verifyAcrossDeposit(req, txOf(ok, {value: "1"})), "tx-value", "policy_refused");
    refused(() => verifyAcrossDeposit(req, txOf(ok, {value: undefined})), "tx-value", "policy_refused");
    refused(() => verifyAcrossDeposit(req, txOf(ok, {value: "00"})), "tx-value", "policy_refused");
    refused(() => verifyAcrossDeposit(req, txOf(ok, {approvalAddress: undefined})), "tx-approval", "vault_mismatch");
    refused(() => verifyAcrossDeposit(req, txOf(ok, {approvalAddress: OTHER})), "tx-approval", "vault_mismatch");
    const native = ethRequest();
    refused(() => verifyAcrossDeposit(native, ethTxOf(ethArgs(), {value: "0"})), "tx-value", "policy_refused");
    refused(() => verifyAcrossDeposit(native, ethTxOf(ethArgs(), {value: "10000000000000001"})), "tx-value", "policy_refused");
    refused(() => verifyAcrossDeposit(native, ethTxOf(ethArgs(), {approvalAddress: BASE.spokePool})), "tx-approval", "vault_mismatch");
    // WETH sent as an ERC-20 carries no value.
    refused(() => verifyAcrossDeposit(ethRequest({sourceToken: WETH_OP}), ethTxOf(ethArgs())), "tx-value", "policy_refused");
  });
});

describe("verifyAcrossDeposit: what Across's API hands out is refused by name", () => {
  const at = (name: string) => apiQuote(name);
  it("a refund address written as the depositor", () => {
    const q = at("base-usdc-arb-usdc-refundaddr");
    const req = usdcRequest({depositor: DEAD, recipient: DEAD, minAmountOut: undefined, nowMs: q.serverTimeMs});
    refused(() => verifyAcrossDeposit(req, {to: q.tx.to, data: q.tx.data.slice(0, -6), value: "0", chainId: 8453, approvalAddress: BASE.spokePool}), "tx-depositor", "recipient_mismatch");
  });
  it("bridge-only and destination-swap quotes that pay the MulticallHandler with a message", () => {
    const weth = at("arb-weth-op-weth");
    const req = {sourceChain: "eip155:42161", destChain: "eip155:10", sourceToken: ARB_WETH, destToken: ZERO, amount: 10n ** 16n, depositor: DEAD, recipient: DEAD, nowMs: weth.serverTimeMs};
    refused(() => verifyAcrossDeposit(req, {to: weth.tx.to, data: weth.tx.data.slice(0, -6), value: "0", chainId: 42161, approvalAddress: ARB.spokePool}), "tx-recipient", "recipient_mismatch");
    const swap = at("base-usdc-arb-arb");
    refused(() => verifyAcrossDeposit(usdcRequest({depositor: DEAD, recipient: DEAD, minAmountOut: undefined, nowMs: swap.serverTimeMs}), {to: swap.tx.to, data: swap.tx.data.slice(0, -6), value: "0", chainId: 8453, approvalAddress: BASE.spokePool}), "tx-recipient", "recipient_mismatch");
  });
  it("periphery and CCTP targets", () => {
    const n = at("eth-eth-base-eth");
    refused(() => verifyAcrossDeposit(ethRequest({sourceChain: "eip155:1", destChain: "eip155:8453", depositor: DEAD, recipient: DEAD, nowMs: n.serverTimeMs}), {to: n.tx.to, data: n.tx.data, value: n.tx.value, chainId: 1}), "tx-target", "vault_mismatch");
    const s = at("arb-usdc-base-usdt");
    refused(() => verifyAcrossDeposit(usdcRequest({sourceChain: "eip155:42161", destChain: "eip155:8453", sourceToken: ARB_USDC, destToken: BASE_USDC, depositor: DEAD, recipient: DEAD, nowMs: s.serverTimeMs}), {to: s.tx.to, data: s.tx.data, value: "0", chainId: 42161, approvalAddress: s.tx.to}), "tx-target", "vault_mismatch");
    const c = at("base-usdc-sol-usdc");
    refused(() => verifyAcrossDeposit(usdcRequest({depositor: DEAD, recipient: DEAD, nowMs: c.serverTimeMs}), {to: c.tx.to, data: c.tx.data, value: "0", chainId: 8453, approvalAddress: c.tx.to}), "tx-target", "vault_mismatch");
  });
});

describe("routes and requests", () => {
  it("acrossRouteOf maps the native coin to the wrapped native token on both sides", () => {
    const r = acrossRouteOf("eip155:1", ZERO, "eip155:324", ZERO);
    expect("code" in r).toBe(false);
    if (!("code" in r)) {
      expect(r.input.token).toBe(acrossChain("eip155:1")!.wrappedNative);
      expect(r.output.token).toBe("0x5aea5775959fbc2557cc8789bc1bf90a239d9a91");
    }
    expect(checkAcrossRequest(usdcRequest()).maxFeeBps).toBe(ACROSS_DEFAULT_MAX_FEE_BPS);
  });

  it("acrossRequestOf: symbols resolve through the catalog, a dry quote is priced with a placeholder, a live one needs addresses", () => {
    const params = {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: ARB_USDC, amountIn: "25000000", destAddress: USER, refundAddress: USER};
    expect(acrossRequestOf(params)).toMatchObject({sourceToken: BASE_USDC, destToken: ARB_USDC, amount: 25_000_000n, depositor: USER, recipient: USER});
    expect(acrossRequestOf({...params, sourceToken: "ETH", destToken: ZERO}).sourceToken).toBe(ZERO);
    const {refundAddress: _sender, ...noSender} = params;
    expect(acrossRequestOf({...noSender, destAddress: ""}, {placeholder: OTHER})).toMatchObject({depositor: OTHER, recipient: OTHER});
    refused(() => acrossRequestOf({...params, destAddress: ""}), "request-invalid");
    refused(() => acrossRequestOf(noSender), "request-invalid");
    refused(() => acrossRequestOf({...params, flex: true}), "request-invalid", "unsupported_pair");
    refused(() => acrossRequestOf({...params, sourceChain: "eip155:100"}), "chain-unsupported", "unsupported_pair");
    refused(() => acrossRequestOf({...params, destChain: "eip155:8453"}), "chain-unsupported", "unsupported_pair");
    refused(() => acrossRequestOf({...params, sourceToken: "DAI"}), "token-unsupported", "unsupported_pair");
    refused(() => acrossRequestOf({...params, sourceToken: "NOPE"}), "request-invalid", "unsupported_pair");
    refused(() => acrossRequestOf({...params, destToken: "USDC"}), "request-invalid", "unsupported_pair");
    refused(() => acrossRequestOf({...params, amountIn: "0"}), "request-invalid");
    refused(() => acrossRequestOf({...params, minAmountOut: "-1"}), "request-invalid");
  });

  it("speed-up typed data is recognised", () => {
    expect(isAcrossSpeedUpTypedData({primaryType: "UpdateDepositDetails"})).toBe(true);
    expect(isAcrossSpeedUpTypedData(JSON.stringify({domain: {name: "ACROSS-V2", version: "1.0.0", chainId: 8453}, types: {}, primaryType: "X"}))).toBe(true);
    expect(isAcrossSpeedUpTypedData({types: {UpdateDepositDetails: []}})).toBe(true);
    expect(isAcrossSpeedUpTypedData("not json with UpdateDepositDetails")).toBe(true);
    expect(isAcrossSpeedUpTypedData({primaryType: "Permit", domain: {name: "USD Coin"}})).toBe(false);
    expect(isAcrossSpeedUpTypedData(null)).toBe(false);
    void RELAYER;
  });
});
