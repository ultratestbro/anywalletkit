// describeFyndActivity: a swap through the active TychoRouterV3, and through the router it replaced on 2026-11-16
// (paused that day, tycho registry commit 8aab890), is labeled for history; other contracts and selectors are not Fynd.
import {describe, expect, it} from "vitest";
import type {ChainTx} from "@anywalletkit/core";
import {encodeFunctionData} from "viem";
import {FYND_PREVIOUS_ROUTERS, describeFyndActivity} from "../src/activity.js";
import {FYND_CHAINS, TYCHO_ROUTER_ABI} from "../src/router.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const ME = "0x1111111111111111111111111111111111111111";
const NO_FEE = {clientFeeBps: 0, clientFeeReceiver: ZERO, maxClientContribution: 0n, deadline: 0n, clientSignature: "0x"} as const;
const own = new Set([ME.toLowerCase()]);
const data = encodeFunctionData({abi: TYCHO_ROUTER_ABI, functionName: "singleSwap", args: [1_000_000n, USDC, WETH, 4n * 10n ** 14n, 39n * 10n ** 13n, ME, NO_FEE as never, "0xdeadbeef"]});

function tx(to: string, calldata: string = data, chain = "eip155:8453"): ChainTx {
  return {
    chain, hash: "0xabc", time: 1, status: "confirmed", address: ME, from: ME, to, nativeValue: 0n,
    transfers: [
      {token: USDC.toLowerCase(), from: ME, to, amount: 1_000_000n, standard: "erc20"},
      {token: WETH.toLowerCase(), from: to, to: ME, amount: 4n * 10n ** 14n, standard: "erc20"},
    ],
    call: {to, selector: calldata.slice(0, 10), data: calldata},
  };
}

describe("describeFyndActivity", () => {
  it("a swap through the active router", () => {
    expect(describeFyndActivity(tx(FYND_CHAINS[8453]!.router), {own})).toMatchObject({kind: "swap", title: "Swapped USDC → WETH", subtitle: "Fynd · Base"});
  });

  it("a past swap through the router replaced on 2026-11-16 keeps its label", () => {
    for (const old of FYND_PREVIOUS_ROUTERS[8453]!) {
      expect(describeFyndActivity(tx(old), {own})).toMatchObject({kind: "swap", subtitle: "Fynd · Base"});
    }
  });

  it("a previous router counts only on its own chain", () => {
    expect(describeFyndActivity(tx(FYND_PREVIOUS_ROUTERS[1]![0]!), {own})).toBeNull();
  });

  it("not Fynd: another contract, another selector, a chain the module does not serve", () => {
    expect(describeFyndActivity(tx("0x2222222222222222222222222222222222222222"), {own})).toBeNull();
    expect(describeFyndActivity(tx(FYND_CHAINS[8453]!.router, "0x095ea7b3" + "00".repeat(64)), {own})).toBeNull();
    expect(describeFyndActivity(tx(FYND_CHAINS[8453]!.router, data, "eip155:10"), {own})).toBeNull();
  });
});
