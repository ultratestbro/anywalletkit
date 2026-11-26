// U2 activity (UNISWAP-V4-RESEARCH §5.6): the pinned SwapProxy's execute(router, token, amount, commands, inputs,
// deadline) whose router is the pinned Universal Router 2.1.2 and whose commands are exactly V4_SWAP is "Uniswap v4 ·
// <chain>"; a SwapProxy call carrying another plan, forwarding to another router, or sent to another address is left
// unclaimed. Recorded public Ethereum transactions (fixtures/activity/ethereum-v4-swapproxy-*.json and the
// negative-ethereum-swapproxy-*.json plans) plus hand-made negatives from them.
import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {decodeFunctionData, encodeFunctionData, type Hex} from "viem";
import {parseActivityFixture, type ActivityFixtureJson} from "@anywalletkit/conformance";
import {describeUniswapActivity} from "../src/activity.js";
import {uniswapProvider} from "../src/provider.js";
import {SWAP_PROXY_ABI, UNISWAP_V4} from "../src/v4/addresses.js";

const load = (f: string) => parseActivityFixture(JSON.parse(readFileSync(new URL(`../fixtures/activity/${f}`, import.meta.url), "utf8")) as ActivityFixtureJson);
const describeOf = (f: ReturnType<typeof load>) => describeUniswapActivity(f.tx, {own: f.own});
const D1 = UNISWAP_V4[1]!;

describe("Uniswap v4 activity through the SwapProxy", () => {
  it("UNI → AAVE and back through the SwapProxy on Ethereum: Uniswap v4 · Ethereum, the SwapProxy as counterparty", () => {
    const a = describeOf(load("ethereum-v4-swapproxy-a.json"));
    expect(a).toMatchObject({kind: "swap", subtitle: "Uniswap v4 · Ethereum", protocol: "@anywalletkit/protocol-swap2-uniswap", counterparty: D1.swapProxy, title: "Swapped UNI → AAVE"});
    const b = describeOf(load("ethereum-v4-swapproxy-b.json"));
    expect(b).toMatchObject({kind: "swap", subtitle: "Uniswap v4 · Ethereum", title: "Swapped AAVE → UNI"});
  });

  it("the recorded fixtures are what this module builds: router = the pinned UR 2.1.2, commands exactly 0x10", () => {
    for (const f of ["ethereum-v4-swapproxy-a.json", "ethereum-v4-swapproxy-b.json"]) {
      const d = decodeFunctionData({abi: SWAP_PROXY_ABI, data: load(f).tx.call!.data as Hex});
      expect(String(d.args[0]).toLowerCase()).toBe(D1.universalRouter.toLowerCase());
      expect(d.args[3]).toBe("0x10");
    }
  });

  it("SwapProxy plans this module does not build stay unclaimed: a v3 plan (0x00070c) and UNWRAP + V4 + WRAP + SWEEP (0x0c100b04)", () => {
    expect(describeOf(load("negative-ethereum-swapproxy-v3-plan.json"))).toBeNull();
    expect(describeOf(load("negative-ethereum-swapproxy-wrap-plan.json"))).toBeNull();
  });

  it("the same call forwarding to another router, sent to another address, or without calldata is unclaimed", () => {
    const f = load("ethereum-v4-swapproxy-a.json");
    const call = f.tx.call!;
    const args = decodeFunctionData({abi: SWAP_PROXY_ABI, data: call.data as Hex}).args as readonly [`0x${string}`, `0x${string}`, bigint, Hex, readonly Hex[], bigint];
    const evil = encodeFunctionData({abi: SWAP_PROXY_ABI, functionName: "execute", args: ["0x3333333333333333333333333333333333333333", args[1], args[2], args[3], args[4], args[5]]});
    expect(describeUniswapActivity({...f.tx, call: {...call, data: evil}}, {own: f.own})).toBeNull();
    const other = "0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9"; // Tempo's SwapProxy address: not the one pinned on Ethereum
    expect(describeUniswapActivity({...f.tx, to: other, call: {...call, to: other}}, {own: f.own})).toBeNull();
    expect(describeUniswapActivity({...f.tx, call: {to: call.to, selector: call.selector!}}, {own: f.own})).toBeNull();
  });

  it("the provider describes it with its own v4 deployments (an override replaces the pinned table)", () => {
    const f = load("ethereum-v4-swapproxy-a.json");
    expect(uniswapProvider({rpcUrls: {}}).describeActivity!(f.tx, {own: f.own})?.subtitle).toBe("Uniswap v4 · Ethereum");
    expect(uniswapProvider({rpcUrls: {}, v4Deployments: {}}).describeActivity!(f.tx, {own: f.own})).toBeNull();
  });
});
