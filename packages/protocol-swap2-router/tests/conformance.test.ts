import {describe, expect, it} from "vitest";
import {describeProtocolModule, parseActivityFixture} from "@anywalletkit/conformance";
import {activityBase, netTransfers, splitNet, type ActivityItem, type ChainTx, type DescribeActivityContext} from "@anywalletkit/core";
import type {CrossChainProvider} from "@anywalletkit/protocol-swap2-core/types";
import {RouterSwap2Protocol} from "../src/swap2/router.js";
import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import type {ActivityFixtureJson} from "@anywalletkit/conformance";

// Recorded real transactions (fixtures/activity/*.json); `negative-*` must come back null.
const fixturesDir = fileURLToPath(new URL("../fixtures/activity/", import.meta.url));
const loadFixtures = (pick: (file: string) => boolean): ActivityFixtureJson[] =>
  readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && pick(f)).sort().map((f) => JSON.parse(readFileSync(fixturesDir + f, "utf8")) as ActivityFixtureJson);
const activity = {fixtures: loadFixtures((f) => !f.startsWith("negative-")), negatives: loadFixtures((f) => f.startsWith("negative-"))};

/** A provider that quotes nothing but recognizes WETH9 deposit() — the router must surface what its providers describe. */
const wethDescriber: CrossChainProvider = {
  name: "weth_describer",
  enabled: () => true,
  supportsRoute: () => false,
  getQuote: async () => null,
  buildDeposit: async () => { throw new Error("not routable"); },
  trackIntent: async () => { throw new Error("not routable"); },
  describeActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
    if (tx.chain !== "eip155:1" || tx.call?.selector !== "0xd0e30db0" || tx.call.to.toLowerCase() !== "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2") return null;
    const {assetsIn, assetsOut} = splitNet(netTransfers(tx, ctx.own));
    return activityBase(tx, "wrap", "Wrapped ETH", {protocol: "weth_describer", assetsIn, assetsOut, counterparty: tx.call.to});
  },
};

describeProtocolModule("protocol-swap2-router", {
  type: "swap2",
  Protocol: RouterSwap2Protocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true, providers: [wethDescriber]},
  samples: {getSupportedChains: []},
  activity,
});

describe("protocol-swap2-router: activity delegation", () => {
  it("returns null when it holds no provider", () => {
    const p = new RouterSwap2Protocol(undefined, {fromChain: "eip155:1", skipAccountChainCheck: true, providers: []});
    const {tx, own} = parseActivityFixture(activity.fixtures[0]!);
    expect(p.describeActivity(tx, {own})).toBeNull();
  });
  it("hands the fixture to the provider that claims it", () => {
    const p = new RouterSwap2Protocol(undefined, {fromChain: "eip155:1", skipAccountChainCheck: true, providers: [wethDescriber]});
    const {tx, own} = parseActivityFixture(activity.fixtures[0]!);
    expect(p.describeActivity(tx, {own})?.protocol).toBe("weth_describer");
  });
});
