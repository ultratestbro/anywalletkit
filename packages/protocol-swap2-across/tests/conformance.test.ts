import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {describeProtocolModule} from "@anywalletkit/conformance";
import type {ActivityFixtureJson} from "@anywalletkit/conformance";
import {AcrossSwap2Protocol} from "../src/protocol.js";
import {ACROSS_MODULE, describeAcrossActivity} from "../src/activity.js";
import {acrossProvider} from "../src/provider.js";

// Recorded real transactions (fixtures/activity/*.json, scripts/record-fixtures.mjs); `negative-*` must come back null.
const fixturesDir = fileURLToPath(new URL("../fixtures/activity/", import.meta.url));
const loadFixtures = (pick: (file: string) => boolean): ActivityFixtureJson[] =>
  readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && pick(f)).sort().map((f) => JSON.parse(readFileSync(fixturesDir + f, "utf8")) as ActivityFixtureJson);
const activity = {fixtures: loadFixtures((f) => !f.startsWith("negative-")), negatives: loadFixtures((f) => f.startsWith("negative-"))};

describeProtocolModule("protocol-swap2-across", {
  type: "swap2",
  activity,
  Protocol: AcrossSwap2Protocol,
  config: {fromChain: "eip155:8453"},
  samples: {getSupportedChains: []}, mustResolve: ["getSupportedChains"],
});

describe("activity", () => {
  it("three real deposits are recognised (deposit, depositV3 of WETH, depositV3 of the native coin), the relayed one is not", () => {
    expect(activity.fixtures).toHaveLength(3);
    expect(activity.negatives).toHaveLength(1);
    const titles = activity.fixtures.map((f) => f.expect?.title).sort();
    expect(titles).toEqual(["Bridged ETH", "Bridged USDC", "Bridged WETH"]);
  });

  it("the provider and the module describe the same; another chain, another contract or selector is not ours", () => {
    const f = activity.fixtures.find((x) => x.expect?.title === "Bridged USDC")!;
    const tx = {...f.tx, nativeValue: BigInt(f.tx.nativeValue as unknown as string), block: f.tx.block === undefined ? undefined : BigInt(f.tx.block as unknown as string), fee: f.tx.fee === undefined ? undefined : BigInt(f.tx.fee as unknown as string), transfers: f.tx.transfers.map((t) => ({...t, amount: BigInt(t.amount as unknown as string)}))} as never;
    const ctx = {own: new Set(f.own.map((a) => a.toLowerCase()).concat(f.own))};
    const item = describeAcrossActivity(tx, ctx)!;
    expect(item).toMatchObject({kind: "bridge", title: "Bridged USDC", protocol: ACROSS_MODULE, subtitle: "Across · Base"});
    expect(acrossProvider().describeActivity!(tx, ctx)).toEqual(item);
    expect(describeAcrossActivity({...(tx as object), chain: "eip155:56"} as never, ctx)).toBeNull();
    expect(describeAcrossActivity({...(tx as object), call: {to: "0x97ccdbea4632140639ad5ea9b944aa034eb15fd4", selector: "0xad5425c6"}} as never, ctx)).toBeNull();
    expect(describeAcrossActivity({...(tx as object), call: {to: (tx as {call: {to: string}}).call.to, selector: "0x8b15788e"}} as never, ctx)).toBeNull();
  });
});
