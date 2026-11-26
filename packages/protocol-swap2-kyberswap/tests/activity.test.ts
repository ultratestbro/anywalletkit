// describeKyberActivity: a swap() through MetaAggregationRouterV2 on a served chain is labeled; other contracts,
// selectors (swapGeneric, swapSimpleMode) and chains are not KyberSwap.
import {describe, expect, it} from "vitest";
import type {ChainTx} from "@anywalletkit/core";
import {describeKyberActivity} from "../src/activity.js";
import {KYBER_ROUTER_V2} from "../src/router.js";
import {ME, USDC, WETH, swapData} from "./helpers.js";

const own = new Set([ME.toLowerCase()]);
const data = swapData({srcToken: USDC, dstToken: WETH, dstReceiver: ME, amount: 1_000_000n, minReturnAmount: 39n * 10n ** 13n});

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

describe("describeKyberActivity", () => {
  it("labels a swap through the router", () => {
    expect(describeKyberActivity(tx(KYBER_ROUTER_V2), {own})).toMatchObject({kind: "swap", title: "Swapped USDC → WETH", subtitle: "KyberSwap · Base"});
  });
  it("labels it on a lite-router chain too (HyperEVM)", () => {
    expect(describeKyberActivity(tx(KYBER_ROUTER_V2, data, "eip155:999"), {own})).toMatchObject({kind: "swap"});
  });
  it("ignores other contracts, other router entry points and chains KyberSwap is not pinned on", () => {
    expect(describeKyberActivity(tx("0x1111111111111111111111111111111111111111"), {own})).toBeNull();
    expect(describeKyberActivity(tx(KYBER_ROUTER_V2, `0x59e50fed${data.slice(10)}`), {own})).toBeNull();
    expect(describeKyberActivity(tx(KYBER_ROUTER_V2, data, "eip155:324"), {own})).toBeNull();
    expect(describeKyberActivity({...tx(KYBER_ROUTER_V2), chain: "solana:mainnet"}, {own})).toBeNull();
  });
});
