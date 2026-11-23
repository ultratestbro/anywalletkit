// describeActivity beyond the recorded fixtures (conformance.test.ts runs those): each of the three calls the account
// itself sends is named on every shipped chain, and nothing else on those contracts — or those selectors elsewhere — is.
import {describe, expect, it} from "vitest";
import type {ChainTx} from "@anywalletkit/core";
import {COW_MODULE, COW_SETTLEMENT_INVALIDATE_SELECTOR, describeCowActivity} from "../src/activity.js";
import {COW_DEPLOYMENTS, cowDeployments} from "../src/deployments.js";
import {ETH_FLOW_CREATE_SELECTOR, ETH_FLOW_INVALIDATE_SELECTOR, encodeCreateOrder, encodeInvalidateOrder} from "../src/ethflow.js";
import {ME, OTHER, USDC} from "./fixtures.js";

const own = new Set([ME.toLowerCase()]);
const DATA = {buyToken: USDC, receiver: ME, sellAmount: "10000000000000000", buyAmount: "39000000", appData: `0x${"11".repeat(32)}`, validTo: 1_800_001_200, quoteId: 7};
function tx(chain: string, to: string, data: string, nativeValue = 0n): ChainTx {
  return {chain, hash: "0xabc", time: 1, status: "confirmed", address: ME, from: ME, to, nativeValue, transfers: [], call: {to, selector: data.slice(0, 10), data}};
}

describe("describeCowActivity", () => {
  it("names the three calls on every shipped chain", () => {
    for (const d of Object.values(COW_DEPLOYMENTS)) {
      const chain = `eip155:${d.chainId}`;
      expect(describeCowActivity(tx(chain, d.ethFlow, encodeCreateOrder(DATA), 10n ** 16n), {own})).toMatchObject({kind: "swap", title: "Placed a CoW order", protocol: COW_MODULE});
      expect(describeCowActivity(tx(chain, d.ethFlow, encodeInvalidateOrder(DATA)), {own})).toMatchObject({kind: "contract", title: "Refunded a CoW order"});
      expect(describeCowActivity(tx(chain, d.settlement, `${COW_SETTLEMENT_INVALIDATE_SELECTOR}${"00".repeat(64)}`), {own})).toMatchObject({kind: "contract", title: "Cancelled a CoW order"});
    }
    expect(describeCowActivity(tx("eip155:8453", COW_DEPLOYMENTS[8453]!.ethFlow, encodeCreateOrder(DATA)), {own})!.subtitle).toBe("CoW Protocol · Base");
  });
  it("the selectors are the contracts' own", () => {
    expect(encodeCreateOrder(DATA).slice(0, 10)).toBe(ETH_FLOW_CREATE_SELECTOR);
    expect(encodeInvalidateOrder(DATA).slice(0, 10)).toBe(ETH_FLOW_INVALIDATE_SELECTOR);
  });
  it("not CoW: another contract, another selector, the right call on the wrong contract, a chain without a deployment", () => {
    const d = COW_DEPLOYMENTS[1]!;
    expect(describeCowActivity(tx("eip155:1", OTHER, encodeCreateOrder(DATA)), {own})).toBeNull();
    expect(describeCowActivity(tx("eip155:1", d.ethFlow, `0x095ea7b3${"00".repeat(64)}`), {own})).toBeNull();
    expect(describeCowActivity(tx("eip155:1", d.settlement, encodeCreateOrder(DATA)), {own})).toBeNull();
    expect(describeCowActivity(tx("eip155:1", d.ethFlow, `${COW_SETTLEMENT_INVALIDATE_SELECTOR}${"00".repeat(64)}`), {own})).toBeNull();
    // A solver's settlement is not the account's transaction and not an order of its own.
    expect(describeCowActivity(tx("eip155:1", d.settlement, `0x13d79a0b${"00".repeat(64)}`), {own})).toBeNull();
    expect(describeCowActivity(tx("eip155:100", d.ethFlow, encodeCreateOrder(DATA)), {own})).toBeNull();
    expect(describeCowActivity(tx("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", d.ethFlow, encodeCreateOrder(DATA)), {own})).toBeNull();
  });
  it("a chain the app added is recognized with its own eth-flow", () => {
    const extra = cowDeployments({100: {chainId: 100, network: "xdai", label: "Gnosis", settlement: COW_DEPLOYMENTS[1]!.settlement, vaultRelayer: COW_DEPLOYMENTS[1]!.vaultRelayer, ethFlow: OTHER, wrappedNative: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d"}});
    expect(describeCowActivity(tx("eip155:100", OTHER, encodeCreateOrder(DATA)), {own}, extra)).toMatchObject({title: "Placed a CoW order"});
  });
});
