import {describe, expect, it} from "vitest";
import {encodeFunctionData, parseAbi, toHex} from "viem";
import {checksFor, decodeCall, previewEvmTx, type Rpc} from "../src/index.js";

const ME = "0x8abe813577e47415a3cd0bbc68c7abca2c4c55ba";
const ME2 = "0x2cff890f0378a11913b6129b2e97417a2c302680";
const FRIEND = "0x3959e49639d3b1bd9d1746a7971155e94fecf1f6";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const WETH = "0x4200000000000000000000000000000000000006";
const DAI = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb";
const DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
const POOL1 = "0xd0b53d9277642d899df5c87a3966a349a798f224";
const POOL2 = "0x6c561b446416e1a00e8e93e221854d6ea4171372";
const FEE = "0xc06ebbefd94032b85424d51906e2a335efae264b";
const STRANGER = "0x91c4d2aa6e15f0a7b3c9d8e7f6a5b4c3d2e1e07a";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ERC20 = parseAbi(["function approve(address,uint256)"]);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
type Log = {address: string; topics: string[]; data: string};
const log = (token: string, from: string, to: string, amount: bigint): Log => ({address: token, topics: [TRANSFER, pad(from), pad(to)], data: toHex(amount, {size: 32})});

const approve = {to: USDC, data: encodeFunctionData({abi: ERC20, functionName: "approve", args: [DIAMOND, 100_000_000n]})};
const swap = {to: DIAMOND, data: "0x3f8f6a2a" + "00".repeat(64)};

async function run(logs: Log[], expectedRecipient: string | undefined, own: string[] = [ME]) {
  const rpc: Rpc = async (m) => {
    if (m === "eth_simulateV1") return [{calls: [{status: "0x1", gasUsed: "0x1", logs: []}, {status: "0x1", gasUsed: "0x1", logs}]}];
    if (m === "eth_call") return "0x";
    throw new Error("no " + m);
  };
  const p = await previewEvmTx({
    chainId: 8453, from: ME, rpc, own, known: {[DIAMOND]: "LI.FI Diamond", [USDC]: "USDC"},
    calls: [approve, swap], expectedApproval: 100_000_000n, ...(expectedRecipient ? {expectedRecipient} : {}),
  });
  return {p, warns: p.checks.filter((c) => c.status === "warn")};
}

describe("expectedRecipient is compared with where the simulated output goes", () => {
  it("a swap whose output goes to a stranger: output-missing and output-foreign", async () => {
    const {p, warns} = await run([log(USDC, ME, DIAMOND, 100_000_000n), log(WETH, DIAMOND, STRANGER, 10n ** 16n)], ME);
    expect(p.checks.map((c) => `${c.code}:${c.status}`)).toContain("recipient-own:ok");
    expect(warns).toEqual([
      {code: "output-missing", status: "warn", detail: {address: ME}},
      {code: "output-foreign", status: "warn", detail: {address: STRANGER, token: WETH, amount: (10n ** 16n).toString()}},
    ]);
  });

  it("output split with a stranger beyond a fee's share: output-foreign", async () => {
    const {warns} = await run([
      log(USDC, ME, DIAMOND, 100_000_000n), log(WETH, POOL1, DIAMOND, 10n ** 16n),
      log(WETH, DIAMOND, ME, 6n * 10n ** 15n), log(WETH, DIAMOND, STRANGER, 4n * 10n ** 15n),
    ], ME);
    expect(warns.map((c) => `${c.code}:${c.detail?.address}`)).toEqual([`output-foreign:${STRANGER}`]);
  });

  it("a real LI.FI route (USDT → WETH → token through two pools, input-token fee, a forwarding hop): no warnings", async () => {
    // Mainnet tx 0x8ae009668f… (history-evm fixture etherscan-eth-proxy-receipt.json), Transfer logs only.
    const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
    const WETH1 = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
    const OUT = "0x9d65ff81a3c488d585bbfb0bfe3c7707c7917f54";
    const logs = [
      log(USDT, ME, DIAMOND, 3000000n),
      log(USDT, DIAMOND, FEE, 7500n),
      log(USDT, DIAMOND, "0x22ec88b9ff78c6f2458ab1a7aa8bb99d84bd4b86", 2992500n),
      log(WETH1, "0x11b815efb8f581194ae79006d24e0d814b7697f6", "0x22ec88b9ff78c6f2458ab1a7aa8bb99d84bd4b86", 1250912535626817n),
      log(USDT, "0x22ec88b9ff78c6f2458ab1a7aa8bb99d84bd4b86", "0x11b815efb8f581194ae79006d24e0d814b7697f6", 2992500n),
      log(OUT, "0x0a55882f4e1117adc54afbbac4a39079ad52fb89", "0x28bf6006d87de7f44445905aa4f5cb8c0d8cba02", 957822217333707768n),
      log(WETH1, "0x22ec88b9ff78c6f2458ab1a7aa8bb99d84bd4b86", "0x0a55882f4e1117adc54afbbac4a39079ad52fb89", 1250912535626817n),
      log(OUT, "0x28bf6006d87de7f44445905aa4f5cb8c0d8cba02", DIAMOND, 957661331266839909n),
      log(OUT, DIAMOND, ME, 957661331266839909n),
    ];
    const {warns} = await run(logs, ME);
    expect(warns).toEqual([]);
  });

  it("a single-pool swap, a multi-hop swap with an output-token fee, and an unwrap to native: no warnings", async () => {
    expect((await run([log(USDC, ME, POOL1, 100_000_000n), log(WETH, POOL1, ME, 10n ** 16n)], ME)).warns).toEqual([]);
    expect((await run([
      log(USDC, ME, DIAMOND, 100_000_000n), log(USDC, DIAMOND, POOL1, 100_000_000n),
      log(WETH, POOL1, POOL2, 10n ** 16n), log(DAI, POOL2, DIAMOND, 99n * 10n ** 18n),
      log(DAI, DIAMOND, FEE, 25n * 10n ** 16n), log(DAI, DIAMOND, ME, 9875n * 10n ** 16n),
    ], ME)).warns).toEqual([]);
    expect((await run([
      log(USDC, ME, DIAMOND, 100_000_000n), log(USDC, DIAMOND, POOL1, 100_000_000n), log(WETH, POOL1, DIAMOND, 10n ** 16n),
      log(NATIVE, WETH, DIAMOND, 10n ** 16n), log(NATIVE, DIAMOND, ME, 10n ** 16n),
    ], ME)).warns).toEqual([]);
  });

  it("output to another own account, or to the chosen friend: no output warning (a friend stays recipient-foreign)", async () => {
    const toMe2 = await run([log(USDC, ME, POOL1, 100_000_000n), log(WETH, POOL1, ME2, 10n ** 16n)], ME2, [ME, ME2]);
    expect(toMe2.warns).toEqual([]);
    const toFriend = await run([log(USDC, ME, POOL1, 100_000_000n), log(WETH, POOL1, FRIEND, 10n ** 16n)], FRIEND);
    expect(toFriend.warns.map((c) => c.code)).toEqual(["recipient-foreign"]);
    const friendShorted = await run([log(USDC, ME, POOL1, 100_000_000n), log(WETH, POOL1, STRANGER, 10n ** 16n)], FRIEND);
    expect(friendShorted.warns.map((c) => c.code)).toEqual(["recipient-foreign", "output-missing", "output-foreign"]);
  });

  it("controls: no expectedRecipient (a bridge) and an app-built simulation without transfers run no output checks", async () => {
    const bridge = await run([log(USDC, ME, DIAMOND, 100_000_000n), log(USDC, DIAMOND, STRANGER, 100_000_000n)], undefined);
    expect(bridge.warns).toEqual([]);
    const known = {[DIAMOND]: "LI.FI Diamond"};
    const checks = checksFor({chainId: 8453, from: ME, rpc: async () => null, own: [ME], known, calls: [swap], expectedRecipient: ME},
      [decodeCall(swap, known)], {status: "ok", changes: [{token: USDC, symbol: "USDC", decimals: 6, delta: -1n, verified: true}], gasUsed: []});
    expect(checks.filter((c) => c.status === "warn")).toEqual([]);
  });
});
