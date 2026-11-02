import {describe, expect, it} from "vitest";
import {encodeFunctionData, parseAbi, toHex} from "viem";
import {previewEvmTx, type Rpc} from "../src/index.js";

const ME = "0x8abe813577e47415a3cd0bbc68c7abca2c4c55ba";
const FRIEND = "0x3959e49639d3b1bd9d1746a7971155e94fecf1f6";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const WETH = "0x4200000000000000000000000000000000000006";
const DAI = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb";
const DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
const POOL1 = "0xd0b53d9277642d899df5c87a3966a349a798f224";
const POOL2 = "0x6c561b446416e1a00e8e93e221854d6ea4171372";
const FEE = "0xc06ebbefd94032b85424d51906e2a335efae264b";
const KEEPER = "0x91c4d2aa6e15f0a7b3c9d8e7f6a5b4c3d2e1e07a"; // a contract that keeps what it gets
const SINK = "0x7777777777777777777777777777777777777777"; // an account
const JUNK = "0x5555555555555555555555555555555555555555";
const JPOOL = "0x2222222222222222222222222222222222222222";
const MEME = "0x4444444444444444444444444444444444444444";
const DEAD = "0x000000000000000000000000000000000000dead";
const ZERO = "0x0000000000000000000000000000000000000000";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ERC20 = parseAbi(["function approve(address,uint256)"]);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DEPOSIT = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";
const pad = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
type Log = {address: string; topics: string[]; data: string};
const log = (token: string, from: string, to: string, amount: bigint): Log => ({address: token, topics: [TRANSFER, pad(from), pad(to)], data: toHex(amount, {size: 32})});

const approve = {to: USDC, data: encodeFunctionData({abi: ERC20, functionName: "approve", args: [DIAMOND, 100_000_000n]})};
const swap = {to: DIAMOND, data: "0x3f8f6a2a" + "00".repeat(64)};
const OUT = 10n ** 16n;
const KNOWN = {[DIAMOND]: "LI.FI Diamond", [USDC]: "USDC"};

async function run(logs: Log[], opts: {recipient?: string; token?: string; calls?: {to: string; data?: string; value?: bigint}[]; known?: Record<string, string>} = {}) {
  const calls = opts.calls ?? [approve, swap];
  const rpc: Rpc = async (m) => {
    if (m === "eth_simulateV1") return [{calls: calls.map((_, i) => ({status: "0x1", gasUsed: "0x1", logs: i === calls.length - 1 ? logs : []}))}];
    if (m === "eth_call") return "0x";
    throw new Error("no " + m);
  };
  const p = await previewEvmTx({
    chainId: 8453, from: ME, rpc, own: [ME], known: opts.known ?? KNOWN, calls, expectedApproval: 100_000_000n,
    expectedRecipient: opts.recipient ?? ME, ...(opts.token !== undefined ? {expectedOutputToken: opts.token} : {}),
  });
  const out = p.checks.filter((c) => c.code.startsWith("output"));
  return {codes: out.map((c) => c.code), out};
}

const spend = [log(USDC, ME, DIAMOND, 100_000_000n), log(USDC, DIAMOND, POOL1, 100_000_000n)];

describe("a hop that passes on a trace of the output is not exempt", () => {
  it("a contract keeps the output and forwards 1 wei to the recipient: output-foreign", async () => {
    const {out} = await run([...spend, log(WETH, POOL1, KEEPER, OUT), log(WETH, KEEPER, ME, 1n)]);
    expect(out).toEqual([{code: "output-foreign", status: "warn", detail: {address: KEEPER, token: WETH, amount: (OUT - 1n).toString()}}]);
    expect((await run([...spend, log(WETH, POOL1, KEEPER, OUT), log(WETH, KEEPER, ME, 1n)], {token: WETH})).codes).toEqual(["output-foreign"]);
  });

  it("a third party keeps half and sends 1 wei on elsewhere: output-foreign", async () => {
    const {codes} = await run([...spend, log(WETH, POOL1, ME, OUT / 2n), log(WETH, POOL1, KEEPER, OUT / 2n), log(WETH, KEEPER, DEAD, 1n)]);
    expect(codes).toEqual(["output-foreign"]);
  });

  it("the output goes to an account that a look-alike Transfer shows paying the recipient a junk token: output-missing and output-foreign with the output token", async () => {
    const logs = [...spend, log(WETH, POOL1, SINK, OUT), log(JUNK, SINK, ME, 1n)];
    expect((await run(logs, {token: WETH})).codes).toEqual(["output-missing", "output-foreign"]);
  });
});

describe("a token that happens to arrive does not hide where the real output went", () => {
  const stolen = [...spend, log(WETH, POOL1, SINK, OUT)];

  it("a junk mint to the recipient: output-foreign without the output token, and output-missing too with it", async () => {
    const logs = [...stolen, log(JUNK, ZERO, ME, 1n)];
    expect((await run(logs)).out).toEqual([{code: "output-foreign", status: "warn", detail: {address: SINK, token: WETH, amount: OUT.toString()}}]);
    expect((await run(logs, {token: WETH})).codes).toEqual(["output-missing", "output-foreign"]);
  });

  it("1 unit of junk paid through a separate pool: the same", async () => {
    const logs = [...stolen, log(USDC, DIAMOND, JPOOL, 1n), log(JUNK, JPOOL, ME, 1n)];
    expect((await run(logs)).codes).toEqual(["output-foreign"]);
    expect((await run(logs, {token: WETH})).codes).toEqual(["output-missing", "output-foreign"]);
  });

  it("a friend as the recipient with a junk mint to the friend: still flagged", async () => {
    const logs = [...stolen, log(JUNK, ZERO, FRIEND, 1n)];
    expect((await run(logs, {recipient: FRIEND})).codes).toEqual(["output-foreign"]);
    expect((await run(logs, {recipient: FRIEND, token: WETH})).codes).toEqual(["output-missing", "output-foreign"]);
  });
});

describe("the fee tolerance is one share of the total output, for all third parties together", () => {
  it("25 slices of 4.9 % each: output-foreign naming the largest holder, the total and the count", async () => {
    const slice = (OUT * 49n) / 1000n;
    const logs = [...spend, log(WETH, POOL1, DIAMOND, OUT + 25n * slice), log(WETH, DIAMOND, ME, OUT)];
    for (let i = 0; i < 25; i++) logs.push(log(WETH, DIAMOND, `0x${(0xa000 + i).toString(16).padStart(40, "0")}`, slice));
    for (const token of [undefined, WETH]) {
      const {out} = await run(logs, token ? {token} : {});
      expect(out).toEqual([{code: "output-foreign", status: "warn", detail: {address: `0x${(0xa000).toString(16).padStart(40, "0")}`, token: WETH, amount: (25n * slice).toString(), holders: "25"}}]);
    }
  });

  it("a 5 % buy tax kept by the token contract is a fee; a 10 % one is flagged", async () => {
    const total = 1000n * 10n ** 18n;
    const buy = (tax: bigint) => [...spend, log(MEME, POOL1, MEME, tax), log(MEME, POOL1, ME, total - tax)];
    expect((await run(buy(total / 20n))).codes).toEqual([]);
    expect((await run(buy(total / 20n), {token: MEME})).codes).toEqual([]);
    expect((await run(buy(total / 10n))).codes).toEqual(["output-foreign"]);
    expect((await run(buy(total / 10n), {token: MEME})).codes).toEqual(["output-foreign"]);
  });
});

describe("live router shapes raise nothing, with and without the output token", () => {
  it("the LI.FI route from the history fixture (input-token fee, two pools, a hop that keeps a sliver)", async () => {
    const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
    const WETH1 = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
    const TOKEN = "0x9d65ff81a3c488d585bbfb0bfe3c7707c7917f54";
    const logs = [
      log(USDT, ME, DIAMOND, 3000000n),
      log(USDT, DIAMOND, FEE, 7500n),
      log(USDT, DIAMOND, "0x22ec88b9ff78c6f2458ab1a7aa8bb99d84bd4b86", 2992500n),
      log(WETH1, "0x11b815efb8f581194ae79006d24e0d814b7697f6", "0x22ec88b9ff78c6f2458ab1a7aa8bb99d84bd4b86", 1250912535626817n),
      log(USDT, "0x22ec88b9ff78c6f2458ab1a7aa8bb99d84bd4b86", "0x11b815efb8f581194ae79006d24e0d814b7697f6", 2992500n),
      log(TOKEN, "0x0a55882f4e1117adc54afbbac4a39079ad52fb89", "0x28bf6006d87de7f44445905aa4f5cb8c0d8cba02", 957822217333707768n),
      log(WETH1, "0x22ec88b9ff78c6f2458ab1a7aa8bb99d84bd4b86", "0x0a55882f4e1117adc54afbbac4a39079ad52fb89", 1250912535626817n),
      log(TOKEN, "0x28bf6006d87de7f44445905aa4f5cb8c0d8cba02", DIAMOND, 957661331266839909n),
      log(TOKEN, DIAMOND, ME, 957661331266839909n),
    ];
    expect((await run(logs)).codes).toEqual([]);
    expect((await run(logs, {token: TOKEN.toUpperCase().replace("0X", "0x")})).codes).toEqual([]);
  });

  it("single pool, multi-hop with a 0.25 % output-token fee, an intermediate-token dust refund, and an unwrap to native", async () => {
    const single = [log(USDC, ME, POOL1, 100_000_000n), log(WETH, POOL1, ME, OUT)];
    const multi = [
      ...spend, log(WETH, POOL1, POOL2, OUT), log(DAI, POOL2, DIAMOND, 99n * 10n ** 18n),
      log(DAI, DIAMOND, FEE, 25n * 10n ** 16n), log(DAI, DIAMOND, ME, 9875n * 10n ** 16n),
    ];
    const refund = [...multi.slice(0, 3), log(WETH, POOL1, ME, 1000n), ...multi.slice(3)];
    const unwrap = [...spend, log(WETH, POOL1, DIAMOND, OUT), log(NATIVE, WETH, DIAMOND, OUT), log(NATIVE, DIAMOND, ME, OUT)];
    for (const [logs, token] of [[single, WETH], [multi, DAI], [refund, DAI], [unwrap, "native"], [unwrap, ZERO], [unwrap, NATIVE]] as const) {
      expect((await run(logs)).codes).toEqual([]);
      expect((await run(logs, {token})).codes).toEqual([]);
    }
  });

  it("a wrap through a known WETH counts its Deposit as the output", async () => {
    const wrap = {to: WETH, data: "0xd0e30db0", value: OUT};
    const logs: Log[] = [log(NATIVE, ME, WETH, OUT), {address: WETH, topics: [DEPOSIT, pad(ME)], data: toHex(OUT, {size: 32})}];
    expect((await run(logs, {calls: [wrap], known: {[WETH]: "WETH"}, token: WETH})).codes).toEqual([]);
  });

  it("the output token names what must arrive: the swap paying out another token is output-missing", async () => {
    const {codes} = await run([log(USDC, ME, POOL1, 100_000_000n), log(DAI, POOL1, ME, 99n * 10n ** 18n)], {token: WETH});
    expect(codes).toEqual(["output-missing"]);
  });
});
