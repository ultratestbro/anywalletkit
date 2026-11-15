import {describe, expect, it} from "vitest";
import {ZEROEX_ALLOWANCE_HOLDER, ZEROEX_NATIVE, ZEROEX_PERMIT2} from "../src/chains.js";
import {ZEROEX_MAX_GAS_LIMIT, ZEROEX_MAX_PERMIT_SECONDS, ZeroExTransactionError, checkZeroExTransaction, type ZeroExExpectation, type ZeroExTransaction} from "../src/settler.js";
import {
  AMOUNT, BASIC, ME, NONCE, OTHER, PREV_SETTLER, SETTLER, USDC, WETH, ZERO,
  executeData, nativeCheckAction, nowSeconds, opaqueAction, permit2Typed, transferFromAction, uniswapV3VipAction, type Permit, type Typed,
} from "./fixtures.js";

const MIN = 396_000_000_000_000n;
const deadline = BigInt(nowSeconds() + 300);
const permit: Permit = {token: USDC, amount: AMOUNT, nonce: NONCE, deadline};

const expected = (over: Partial<ZeroExExpectation> = {}): ZeroExExpectation => ({
  chainId: 8453, settlers: [SETTLER, PREV_SETTLER], sellToken: USDC, buyToken: ZEROEX_NATIVE, sellAmount: AMOUNT, recipient: ME, minBuyAmount: MIN, ...over,
});
const tokenSale = (over: Partial<ZeroExTransaction> = {}, typed: Typed | Record<string, unknown> = permit2Typed({deadline}), first = transferFromAction(permit)): ZeroExTransaction => ({
  to: SETTLER,
  data: executeData({recipient: ME, buyToken: ZEROEX_NATIVE, min: MIN, first, firstLength: 0xffff}),
  value: "0",
  chainId: 8453,
  approvalAddress: ZEROEX_PERMIT2,
  permit2Transfer: JSON.stringify(typed),
  ...over,
});
const nativeCheck = nativeCheckAction(deadline, AMOUNT);
const nativeSale = (over: Partial<ZeroExTransaction> = {}): ZeroExTransaction => ({
  to: SETTLER, data: executeData({recipient: ME, buyToken: USDC, min: MIN, first: nativeCheck}), value: AMOUNT.toString(), chainId: 8453, ...over,
});
const nativeExpected = (over: Partial<ZeroExExpectation> = {}) => expected({sellToken: ZEROEX_NATIVE, buyToken: USDC, ...over});
const refused = (fn: () => unknown, why: RegExp) => {
  expect(fn).toThrow(ZeroExTransactionError);
  expect(fn).toThrow(why);
};
const withMessage = (change: (t: Typed) => void): Typed => {
  const t = permit2Typed({deadline});
  change(t);
  return t;
};

describe("checkZeroExTransaction — token sale (Permit2)", () => {
  it("accepts the honest transaction and returns what was read", () => {
    const checked = checkZeroExTransaction(tokenSale(), expected());
    expect(checked.permitAction).toBe("TRANSFER_FROM");
    expect(checked.permit2).toMatchObject({nonce: NONCE, deadline});
    expect(checked.execute).toMatchObject({recipient: ME, buyToken: ZEROEX_NATIVE, minAmountOut: MIN});
  });

  it("accepts the previous Settler of the registry, and a VIP first action", () => {
    expect(checkZeroExTransaction(tokenSale({to: PREV_SETTLER}, permit2Typed({deadline, spender: PREV_SETTLER})), expected()).permitAction).toBe("TRANSFER_FROM");
    expect(checkZeroExTransaction(tokenSale({}, permit2Typed({deadline}), uniswapV3VipAction(permit)), expected()).permitAction).toBe("UNISWAPV3_VIP");
  });

  it("accepts a token → token sale and the zero address as the native buy token of the request", () => {
    const data = executeData({recipient: ME, buyToken: WETH, min: MIN, first: transferFromAction(permit), firstLength: 0xffff});
    expect(checkZeroExTransaction(tokenSale({data}), expected({buyToken: WETH})).execute.buyToken).toBe(WETH);
    expect(checkZeroExTransaction(tokenSale(), expected({buyToken: ZERO})).execute.buyToken).toBe(ZEROEX_NATIVE);
  });

  describe("Permit2 typed data", () => {
    const cases: [string, Typed | Record<string, unknown>, RegExp][] = [
      ["another token", permit2Typed({deadline, token: WETH}), /permitted token is not the source token/],
      ["a larger amount", permit2Typed({deadline, amount: AMOUNT + 1n}), /permitted amount is not the swap's/],
      ["an unlimited amount", permit2Typed({deadline, amount: 2n ** 256n - 1n}), /permitted amount is not the swap's/],
      ["a smaller amount", permit2Typed({deadline, amount: AMOUNT - 1n}), /permitted amount is not the swap's/],
      ["another spender", permit2Typed({deadline, spender: OTHER}), /spender is not the contract the swap calls/],
      ["the other registry Settler as spender", permit2Typed({deadline, spender: PREV_SETTLER}), /spender is not the contract the swap calls/],
      ["AllowanceHolder as spender", permit2Typed({deadline, spender: ZEROEX_ALLOWANCE_HOLDER}), /spender is not the contract the swap calls/],
      ["another chain", permit2Typed({deadline, chainId: 1}), /domain chainId is not the source chain 8453/],
      ["another domain name", withMessage((t) => { t.domain.name = "Permit3"; }), /domain name is not Permit2/],
      ["another verifying contract", withMessage((t) => { t.domain.verifyingContract = OTHER; }), /verifying contract is not Permit2/],
      ["a passed deadline", permit2Typed({deadline: BigInt(nowSeconds() - 5)}), /deadline has passed/],
      ["a deadline far away", permit2Typed({deadline: BigInt(nowSeconds() + 86_400)}), /deadline is more than 3600 s away/],
      // 0x signs five minutes ahead: a permit valid for longer than ZEROEX_MAX_PERMIT_SECONDS is refused here, though the core reader allows an hour.
      ["a deadline the core reader allows but 0x never asks for", permit2Typed({deadline: BigInt(nowSeconds() + ZEROEX_MAX_PERMIT_SECONDS + 60)}), /the Permit2 deadline is more than 600 s away/],
      ["an allowance-style permit", withMessage((t) => { (t as {primaryType: string}).primaryType = "PermitSingle"; }), /primaryType PermitSingle is not PermitTransferFrom/],
      ["an extra type", withMessage((t) => { (t.types as Record<string, unknown>).Witness = [{name: "x", type: "uint256"}]; }), /unexpected type Witness/],
    ];
    for (const [name, typed, why] of cases) it(`refuses ${name}`, () => refused(() => checkZeroExTransaction(tokenSale({}, typed), expected()), why));

    it("refuses a missing payload, text that is not JSON, and a raw hash in its place", () => {
      const {permit2Transfer: _, ...without} = tokenSale();
      refused(() => checkZeroExTransaction(without, expected()), /a token sale carries no Permit2 payload to sign/);
      expect(() => checkZeroExTransaction(tokenSale({permit2Transfer: "{"}), expected())).toThrow(ZeroExTransactionError);
      expect(() => checkZeroExTransaction(tokenSale({permit2Transfer: JSON.stringify(`0x${"ab".repeat(32)}`)}), expected())).toThrow(ZeroExTransactionError);
    });

    it("judges the deadline against the caller's clock when one is given", () => {
      expect(() => checkZeroExTransaction(tokenSale(), expected({nowMs: Number(deadline) * 1000 + 1000}))).toThrow(/deadline has passed/);
    });
  });

  describe("transaction", () => {
    const data = (over: Partial<Parameters<typeof executeData>[0]>) => executeData({recipient: ME, buyToken: ZEROEX_NATIVE, min: MIN, first: transferFromAction(permit), firstLength: 0xffff, ...over});
    const cases: [string, Partial<ZeroExTransaction>, RegExp][] = [
      ["a target outside the registry", {to: OTHER}, /is not a 0x Settler from the on-chain registry/],
      ["AllowanceHolder as the target", {to: ZEROEX_ALLOWANCE_HOLDER}, /is not a 0x Settler from the on-chain registry/],
      ["Permit2 as the target", {to: ZEROEX_PERMIT2}, /is not a 0x Settler from the on-chain registry/],
      ["no target", {to: "0x12"}, /has no target/],
      ["another chain", {chainId: 1}, /the transaction is for chain 1, not 8453/],
      ["native coin sent with a token sale", {value: "1"}, /sends native coin with a token sale/],
      ["a hex value", {value: "0x0"}, /value is not a decimal amount/],
      ["a gas limit above the ceiling", {gasLimit: (ZEROEX_MAX_GAS_LIMIT + 1n).toString()}, /more gas than any 0x swap needs/],
      ["a zero gas limit", {gasLimit: "0"}, /more gas than any 0x swap needs/],
      ["another recipient", {data: data({recipient: OTHER})}, /the swap pays 0x9999999999999999999999999999999999999999, not the recipient of this swap/],
      ["the Settler as recipient", {data: data({recipient: SETTLER})}, /not the recipient of this swap/],
      ["another buy token", {data: data({buyToken: WETH})}, /the swap delivers 0x4200000000000000000000000000000000000006, not the token asked for/],
      ["a lower minimum", {data: data({min: MIN - 1n})}, /the swap enforces a minimum of 395999999999999, not the quoted 396000000000000/],
      ["a zero minimum", {data: data({min: 0n})}, /enforces a minimum of 0/],
      ["a higher minimum than quoted", {data: data({min: MIN + 1n})}, /enforces a minimum of/],
      ["another method", {data: `0x095ea7b3${data({}).slice(10)}`}, /does not call Settler\.execute/],
      ["an allowance target that is not Permit2", {approvalAddress: SETTLER}, /allowance target is not canonical Permit2/],
      ["AllowanceHolder as the allowance target", {approvalAddress: ZEROEX_ALLOWANCE_HOLDER}, /allowance target is not canonical Permit2/],
      ["a first action that is not a Permit2 payment", {data: data({first: opaqueAction(BASIC, 6), firstLength: 4 + 32 * 6})}, /first action 0x38c9c147 is not a Permit2 payment this module knows/],
      ["a payment of another token", {data: data({first: transferFromAction({...permit, token: WETH})})}, /TRANSFER_FROM pulls a token other than the one being sold/],
      ["a payment of a larger amount", {data: data({first: transferFromAction({...permit, amount: AMOUNT * 2n})})}, /TRANSFER_FROM pulls an amount other than the input/],
      ["a payment with another nonce", {data: data({first: transferFromAction({...permit, nonce: NONCE + 1n})})}, /TRANSFER_FROM carries a different permit than the one to be signed/],
      ["a payment with another deadline", {data: data({first: transferFromAction({...permit, deadline: deadline + 1n})})}, /TRANSFER_FROM carries a different permit than the one to be signed/],
      ["a signature slot before the end of the data", {data: data({first: transferFromAction(permit, {sigOffset: 0xa0})})}, /TRANSFER_FROM does not read its signature from the end of the data/],
      ["a signature slot past the end of the data", {data: data({first: transferFromAction(permit, {sigOffset: 0xe0})})}, /TRANSFER_FROM does not read its signature from the end of the data/],
      ["data that already carries something after the slot", {data: `${data({})}${"00".repeat(32)}`}, /does not read its signature from the end of the data/],
    ];
    for (const [name, over, why] of cases) it(`refuses ${name}`, () => refused(() => checkZeroExTransaction(tokenSale(over), expected()), why));

    it("refuses when the allowance target is missing or no Settler is resolved", () => {
      const {approvalAddress: _, ...without} = tokenSale();
      refused(() => checkZeroExTransaction(without, expected()), /allowance target is not canonical Permit2/);
      refused(() => checkZeroExTransaction(tokenSale(), expected({settlers: []})), /the 0x Settler for chain 8453 is not resolved/);
    });

    it("refuses a request it cannot hold a transaction to", () => {
      refused(() => checkZeroExTransaction(tokenSale(), expected({recipient: ZERO})), /names no recipient/);
      refused(() => checkZeroExTransaction(tokenSale(), expected({sellAmount: 0n})), /no input or no minimum output/);
      refused(() => checkZeroExTransaction(tokenSale(), expected({minBuyAmount: 0n})), /no input or no minimum output/);
      refused(() => checkZeroExTransaction(tokenSale(), expected({buyToken: USDC})), /sells and buys the same token/);
      refused(() => checkZeroExTransaction(tokenSale(), expected({chainId: 0})), /names no EVM chain/);
    });
  });
});

describe("checkZeroExTransaction — native sale", () => {
  it("accepts value = the amount sold, with no allowance and no signature request", () => {
    const checked = checkZeroExTransaction(nativeSale(), nativeExpected());
    expect(checked.permit2).toBeUndefined();
    expect(checked.permitAction).toBeUndefined();
    expect(checked.execute.buyToken).toBe(USDC);
  });
  const cases: [string, Partial<ZeroExTransaction>, RegExp][] = [
    ["more value than the amount sold", {value: (AMOUNT + 1n).toString()}, /value is not the amount being sold/],
    ["less value than the amount sold", {value: (AMOUNT - 1n).toString()}, /value is not the amount being sold/],
    ["no value", {value: "0"}, /value is not the amount being sold/],
    ["a token allowance", {approvalAddress: ZEROEX_PERMIT2}, /a native-coin sale asks for a token allowance/],
    ["a Permit2 signature request", {permit2Transfer: JSON.stringify(permit2Typed({deadline}))}, /a native-coin sale carries a Permit2 signature request/],
    ["another recipient", {data: executeData({recipient: OTHER, buyToken: USDC, min: MIN, first: nativeCheck})}, /not the recipient of this swap/],
    ["a lower minimum", {data: executeData({recipient: ME, buyToken: USDC, min: 1n, first: nativeCheck})}, /enforces a minimum of 1,/],
    ["a target outside the registry", {to: OTHER}, /is not a 0x Settler from the on-chain registry/],
    // Action 0 is where Settler spends a Permit2 signature: an earlier, unspent permit of this account must not ride along.
    ["a Permit2 payment as its first action (an earlier, unspent permit)", {data: executeData({recipient: ME, buyToken: USDC, min: MIN, first: transferFromAction(permit, {recipient: OTHER}), firstLength: 0xffff})}, /first action 0xc1fb425e is not the native-value check a native-coin sale opens with/],
    ["a VIP swap as its first action", {data: executeData({recipient: ME, buyToken: USDC, min: MIN, first: uniswapV3VipAction(permit), firstLength: 0xffff})}, /first action 0x3036d6a6 is not the native-value check/],
    ["any other first action", {data: executeData({recipient: ME, buyToken: USDC, min: MIN, first: opaqueAction(BASIC, 5)})}, /first action 0x38c9c147 is not the native-value check/],
  ];
  for (const [name, over, why] of cases) it(`refuses ${name}`, () => refused(() => checkZeroExTransaction(nativeSale(over), nativeExpected()), why));
  it("refuses native for native", () => refused(() => checkZeroExTransaction(nativeSale(), nativeExpected({buyToken: ZERO})), /sells and buys the same token/));
});
