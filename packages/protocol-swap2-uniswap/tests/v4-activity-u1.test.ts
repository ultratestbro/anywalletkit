// U1 activity (UNISWAP-V4-RESEARCH §5.6): the pinned Universal Router 2.1.2's execute(bytes,bytes[],uint256) whose commands
// are exactly V4_SWAP (0x10) is "Uniswap v4 · <chain>"; every other router call stays unclaimed. Recorded public
// transactions (fixtures/activity/unichain-v4-*.json, negative-*-ur-*.json) plus hand-made negatives from them.
import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {encodeFunctionData, parseAbi, type Hex} from "viem";
import {parseActivityFixture, type ActivityFixtureJson} from "@anywalletkit/conformance";
import {describeUniswapActivity} from "../src/activity.js";
import {uniswapProvider} from "../src/provider.js";
import {UNISWAP_V4} from "../src/v4/addresses.js";

const load = (f: string) => parseActivityFixture(JSON.parse(readFileSync(new URL(`../fixtures/activity/${f}`, import.meta.url), "utf8")) as ActivityFixtureJson);
const describeOf = (f: ReturnType<typeof load>) => describeUniswapActivity(f.tx, {own: f.own});
const UR = UNISWAP_V4[130]!.universalRouter;

describe("Uniswap v4 activity", () => {
  it("a native-input V4_SWAP on Unichain: Swapped ETH → token, Uniswap v4 · Unichain", () => {
    const item = describeOf(load("unichain-v4-native-in.json"));
    expect(item).toMatchObject({kind: "swap", subtitle: "Uniswap v4 · Unichain", protocol: "@anywalletkit/protocol-swap2-uniswap", counterparty: UR});
    expect(item!.assetsOut).toEqual([expect.objectContaining({token: null, amount: 200_000_000_000_000n})]);
    expect(item!.title).toMatch(/^Swapped ETH → /);
  });

  it("a V4_SWAP paying native out (from the PoolManager, an internal transfer): token → ETH", () => {
    const item = describeOf(load("unichain-v4-token-to-native.json"));
    expect(item).toMatchObject({kind: "swap", subtitle: "Uniswap v4 · Unichain"});
    expect(item!.assetsIn).toEqual([expect.objectContaining({token: null, amount: 13_495_925_442_349n})]);
  });

  it("router plans this module does not build stay unclaimed: V3+V4 (0x0010) on Unichain, PERMIT2_PERMIT+V4 (0x0a10) on Monad", () => {
    expect(describeOf(load("negative-unichain-ur-mixed-v3-v4.json"))).toBeNull();
    expect(describeOf(load("negative-monad-ur-permit2-v4.json"))).toBeNull();
  });

  it("the same V4_SWAP through the no-deadline entry point, to an unpinned router, or without calldata is unclaimed", () => {
    const f = load("unichain-v4-native-in.json");
    const call = f.tx.call!;
    const decoded = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable", "function execute(bytes commands, bytes[] inputs) payable"]);
    const noDeadline = encodeFunctionData({abi: decoded, functionName: "execute", args: ["0x10", ["0x"]]});
    expect(describeUniswapActivity({...f.tx, call: {...call, selector: noDeadline.slice(0, 10), data: noDeadline}}, {own: f.own})).toBeNull();
    const other = "0x0d97Dc33264bfC1c226207428A79b26757fb9dc3"; // Monad's UR 2.0 address, not pinned on Unichain
    expect(describeUniswapActivity({...f.tx, to: other, call: {...call, to: other}}, {own: f.own})).toBeNull();
    expect(describeUniswapActivity({...f.tx, call: {to: call.to, selector: call.selector!}}, {own: f.own})).toBeNull();
    const plan = encodeFunctionData({abi: decoded, functionName: "execute", args: ["0x1004", ["0x", "0x"], 1n]}) as Hex;
    expect(describeUniswapActivity({...f.tx, call: {...call, data: plan}}, {own: f.own})).toBeNull();
  });

  it("the provider describes v4 activity with its own v4 deployments (an override replaces the pinned table)", () => {
    const f = load("unichain-v4-native-in.json");
    expect(uniswapProvider({rpcUrls: {}}).describeActivity!(f.tx, {own: f.own})?.subtitle).toBe("Uniswap v4 · Unichain");
    expect(uniswapProvider({rpcUrls: {}, v4Deployments: {}}).describeActivity!(f.tx, {own: f.own})).toBeNull();
  });
});
