// Elysium's WHYPE is an aeWETH: it emits Transfer mint / burn, not WETH9's Deposit / Withdrawal. Recognition reads the
// call (contract + selector) and the assets come from the transfers: native in / Transfer from 0x0 on deposit(),
// Transfer to 0x0 / internal native credit on withdraw(uint256).
import {describe, expect, it} from "vitest";
import type {ChainTx} from "@anywalletkit/core";
import {describeWrapActivity, WETH_DEPOSIT, WETH_WITHDRAW} from "../src/activity.js";

const WHYPE = "0xba876237b0f021a6c6d852d6c26e107997cc5e81";
const ZERO = "0x0000000000000000000000000000000000000000";
const ME = "0x64c1442f63a85cd6eb443f086413422aa27ba1a4";
const own = new Set([ME]);
const AMOUNT = 303_930_000_000_000_000n;

function tx(selector: string, data: string, nativeValue: bigint, transfers: ChainTx["transfers"]): ChainTx {
  return {chain: "eip155:99901", hash: "0x7c7c", time: 1, status: "confirmed", address: ME, from: ME, to: WHYPE, nativeValue, transfers, call: {to: WHYPE, selector, data}};
}

describe("describeWrapActivity on Elysium (99901)", () => {
  it("deposit() with value → wrap, HYPE out, WHYPE in (Transfer from 0x0)", () => {
    const item = describeWrapActivity(
      tx(WETH_DEPOSIT, WETH_DEPOSIT, AMOUNT, [
        {token: null, from: ME, to: WHYPE, amount: AMOUNT},
        {token: WHYPE, from: ZERO, to: ME, amount: AMOUNT, standard: "erc20"},
      ]),
      {own},
    )!;
    expect(item).toMatchObject({kind: "wrap", title: "Wrapped HYPE", subtitle: "WHYPE"});
    expect(item.assetsOut).toEqual([{token: null, amount: AMOUNT, symbol: "HYPE", decimals: 18}]);
    expect(item.assetsIn).toEqual([{token: WHYPE, amount: AMOUNT, symbol: "WHYPE", decimals: 18}]);
  });
  it("withdraw(uint256) → unwrap, WHYPE out (Transfer to 0x0), HYPE in (internal native credit)", () => {
    const data = WETH_WITHDRAW + AMOUNT.toString(16).padStart(64, "0");
    const item = describeWrapActivity(
      tx(WETH_WITHDRAW, data, 0n, [
        {token: WHYPE, from: ME, to: ZERO, amount: AMOUNT, standard: "erc20"},
        {token: null, from: WHYPE, to: ME, amount: AMOUNT},
      ]),
      {own},
    )!;
    expect(item).toMatchObject({kind: "unwrap", title: "Unwrapped WHYPE", subtitle: "WHYPE"});
    expect(item.assetsOut).toEqual([{token: WHYPE, amount: AMOUNT, symbol: "WHYPE", decimals: 18}]);
    expect(item.assetsIn).toEqual([{token: null, amount: AMOUNT, symbol: "HYPE", decimals: 18}]);
  });
  it("another selector on WHYPE, or deposit() on another contract, is not a wrap", () => {
    expect(describeWrapActivity(tx("0xa9059cbb", "0xa9059cbb", 0n, [{token: WHYPE, from: ME, to: ZERO, amount: 1n, standard: "erc20"}]), {own})).toBeNull();
    const elsewhere = {...tx(WETH_DEPOSIT, WETH_DEPOSIT, AMOUNT, [{token: null, from: ME, to: ZERO, amount: AMOUNT}]), to: ZERO, call: {to: ZERO, selector: WETH_DEPOSIT, data: WETH_DEPOSIT}};
    expect(describeWrapActivity(elsewhere, {own})).toBeNull();
  });
});
