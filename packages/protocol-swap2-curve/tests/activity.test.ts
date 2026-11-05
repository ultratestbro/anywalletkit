// describeActivity beyond the recorded fixtures (conformance.test.ts runs those): the older Ethereum routers are
// recognized for history, a receiver that is not the owner is said out loud, other contracts / selectors are not Curve.
import {describe, expect, it} from "vitest";
import type {ChainTx} from "@anywalletkit/core";
import {getAddress, type Hex} from "viem";
import {describeCurveActivity} from "../src/activity.js";
import {encodeExchange} from "../src/abi.js";
import {CURVE_DEPLOYMENTS, CURVE_LEGACY_ROUTERS} from "../src/deployments.js";
import {routeArgs} from "../src/routes.js";
import {ME, OTHER, POOLS, TRIPOOL, USDC, USDT} from "./fixtures.js";

const pool = POOLS[1]!.pools.find((p) => p.address === TRIPOOL)!;
const args = routeArgs("ng5", {label: "", steps: [{kind: "pool", pool, swapType: 1, i: 1, j: 2, tokenIn: getAddress(USDC) as Hex, tokenOut: getAddress(USDT) as Hex}]});
const own = new Set([ME.toLowerCase()]);
function tx(to: string, data: string, receiverGetsOutput: string): ChainTx {
  return {
    chain: "eip155:1", hash: "0xabc", time: 1, status: "confirmed", address: ME, from: ME, to, nativeValue: 0n,
    transfers: [
      {token: USDC.toLowerCase(), from: ME, to, amount: 1_000_000n, standard: "erc20"},
      {token: USDT.toLowerCase(), from: to, to: receiverGetsOutput, amount: 999_000n, standard: "erc20"},
    ],
    call: {to, selector: data.slice(0, 10), data},
  };
}

describe("describeCurveActivity", () => {
  it("a swap through the pinned router, paid to the owner", () => {
    const r = CURVE_DEPLOYMENTS[1]!.router;
    const item = describeCurveActivity(tx(r, encodeExchange("ng5", args, 1_000_000n, 990_000n, ME), ME), {own})!;
    expect(item).toMatchObject({kind: "swap", title: "Swapped USDC → USDT", subtitle: "Curve · Ethereum", counterparty: r});
  });
  it("a receiver that is not the owner: subtitle says so and the receiver is the counterparty", () => {
    const r = CURVE_DEPLOYMENTS[1]!.router;
    const item = describeCurveActivity(tx(r, encodeExchange("ng5", args, 1_000_000n, 990_000n, OTHER as Hex), OTHER), {own})!;
    expect(item.subtitle).toBe("Curve · Ethereum · paid to 0x9999…9999");
    expect(item.counterparty).toBe(OTHER.toLowerCase());
    expect(item.title).toBe("Swapped USDC");
  });
  it("Ethereum's older routers (v1.1, v1.0) are recognized for history", () => {
    for (const {router} of CURVE_LEGACY_ROUTERS[1]!) {
      expect(describeCurveActivity(tx(router, encodeExchange("ng5", args, 1_000_000n, 990_000n, ME), ME), {own})?.subtitle).toBe("Curve · Ethereum");
    }
  });
  it("not Curve: another contract, another selector, a router address on a chain where it is something else", () => {
    const r = CURVE_DEPLOYMENTS[1]!.router;
    expect(describeCurveActivity(tx(OTHER, encodeExchange("ng5", args, 1n, 1n, ME), ME), {own})).toBeNull();
    expect(describeCurveActivity(tx(r, "0x095ea7b3" + "00".repeat(64), ME), {own})).toBeNull();
    // 0xA72C…51CC is the BSC router, but on Ethereum it is a calc contract.
    expect(describeCurveActivity(tx(CURVE_DEPLOYMENTS[56]!.router, encodeExchange("ng5", args, 1n, 1n, ME), ME), {own})).toBeNull();
    // A [5][5] call into a [4][5] router (Mantle shares Base's router address) is not that router's entry point.
    expect(describeCurveActivity({...tx(CURVE_DEPLOYMENTS[5000]!.router, encodeExchange("ng5", args, 1n, 1n, ME), ME), chain: "eip155:5000"}, {own})).toBeNull();
  });
});
