// preflightDeposit blamed every revert on the price ("the price moved past your minimum") without looking at why the
// swap reverted: a balance under the amount, an approval the RPC did not see yet, a router fee check — all read as
// slippage. Now the price is named only when the router reverts with TychoRouter__NegativeSlippage; otherwise the
// input balance and the router's allowance are read, and anything else is named as it is. A fake API and RPC, no keys.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeFunctionData, parseAbi, type Hex} from "viem";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {fyndProvider} from "../src/provider.js";
import {FYND_CHAINS, ROUTER_NATIVE, TYCHO_ROUTER_ABI} from "../src/router.js";

afterEach(() => vi.unstubAllGlobals());

const ZERO = "0x0000000000000000000000000000000000000000";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const ME = "0x4444444444444444444444444444444444444444";
const ROUTER = FYND_CHAINS[8453]!.router;
const NO_FEE = {clientFeeBps: 0, clientFeeReceiver: ZERO, maxClientContribution: 0n, deadline: 0n, clientSignature: "0x"} as const;
const RPC = {8453: ["https://rpc.test"]};
const GROSS = 400_000_000_000_000_000n;
const ERRORS = parseAbi([
  "error TychoRouter__NegativeSlippage(uint256 amount, uint256 minAmount)",
  "error TychoRouter__FeesExceedOutput(uint256 totalFees, uint256 actualAmountOut)",
  "error Error(string)",
]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address, address) view returns (uint256)", "function approve(address, uint256) returns (bool)"]);
const slippage = (amount: bigint, min: bigint) => encodeErrorResult({abi: ERRORS, errorName: "TychoRouter__NegativeSlippage", args: [amount, min]});
const word = (v: bigint) => encodeAbiParameters([{type: "uint256"}], [v]);

interface Chain {
  /** The router eth_call's JSON-RPC error; none → the swap executes. */
  revert?: {message: string; data?: unknown};
  balance?: bigint;
  allowance?: bigint;
  native?: bigint;
  /** The diagnostic reads (balanceOf / allowance / eth_getBalance) fail. */
  readsFail?: boolean;
  reads?: string[];
}

/** The hosted API (one singleSwap order) and an RPC: the router call reverts per `revert`, ERC-20 / native reads answer from `c`. */
function fake(c: Chain = {}): typeof fetch {
  return vi.fn(async (url: string, init: {body: string}) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const reply = (v: unknown) => new Response(JSON.stringify({jsonrpc: "2.0", id: 1, ...(v as object)}));
    if (url.includes("/quote")) {
      const order = (body.orders as Record<string, string>[])[0]!;
      const amountIn = BigInt(order.amount!);
      const slip = (GROSS * 50n) / 10_000n;
      const min = GROSS - slip;
      const sentinel = (t: string) => (t === ZERO ? ROUTER_NATIVE : t);
      const data = encodeFunctionData({abi: TYCHO_ROUTER_ABI, functionName: "singleSwap", args: [amountIn, sentinel(order.token_in!) as Hex, sentinel(order.token_out!) as Hex, GROSS, min, order.receiver as Hex, NO_FEE as never, "0xdeadbeef"]});
      return new Response(JSON.stringify({orders: [{status: "success", amount_in: amountIn.toString(), amount_out: GROSS.toString(), gas_estimate: "150000",
        route: {swaps: [{protocol: "uniswap_v3"}]},
        fee_breakdown: {router_fee: "0", client_fee: "0", max_slippage: slip.toString(), min_amount_received: min.toString()},
        transaction: {to: ROUTER, value: order.token_in === ZERO ? amountIn.toString() : "0", data}}]}));
    }
    const rpc = body as {method: string; params: Array<{to: string; data: Hex}>};
    if (rpc.method === "eth_getBalance") {
      c.reads?.push("eth_getBalance");
      return reply(c.readsFail ? {error: {message: "upstream error"}} : {result: `0x${(c.native ?? 0n).toString(16)}`});
    }
    if (rpc.method === "eth_call") {
      const call = rpc.params[0]!;
      if (call.to.toLowerCase() === ROUTER.toLowerCase()) return reply(c.revert ? {error: c.revert} : {result: "0x"});
      const read = decodeFunctionData({abi: ERC20, data: call.data});
      c.reads?.push(read.functionName);
      if (c.readsFail) return reply({error: {message: "upstream error"}});
      return reply({result: word(read.functionName === "balanceOf" ? c.balance ?? 0n : c.allowance ?? 0n)});
    }
    if (rpc.method === "eth_getTransactionReceipt") return reply({result: {status: "0x1"}});
    return new Response("{}", {status: 404});
  }) as unknown as typeof fetch;
}

const USDC_IN = {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:8453", destToken: WETH, amountIn: "1000000000", destAddress: ME, refundAddress: ME, slippageBps: 50};
const ETH_IN = {...USDC_IN, sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000000"};

/** Quote with a clean RPC, then run the preflight against `c`; the refusal it throws ("" when it passes). */
async function preflight(c: Chain, params: Record<string, unknown> = USDC_IN): Promise<string> {
  vi.stubGlobal("fetch", fake());
  const p = fyndProvider({apiKey: "k", rpcUrls: RPC});
  const q = (await p.getQuote(params as never))!;
  const tx = await p.buildDeposit(q);
  vi.stubGlobal("fetch", fake(c));
  try {
    await p.preflightDeposit!(q, tx);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

describe("Fynd preflight names why the swap would revert", () => {
  it("the router's TychoRouter__NegativeSlippage is the price, with the amounts — and nothing else is read", async () => {
    const reads: string[] = [];
    const why = await preflight({revert: {message: "execution reverted", data: slippage(397_000n, 398_000n)}, reads});
    expect(why).toBe("fynd: the price moved past your minimum — the route now pays 397000, under your minimum 398000. Nothing was sent; refresh the quote.");
    expect(reads).toEqual([]);
  });

  it("finds the slippage error under data.data, as hex in the message, or by name in the message", async () => {
    for (const revert of [
      {message: "execution reverted", data: {data: slippage(1n, 2n)}},
      {message: `execution reverted: custom error ${slippage(1n, 2n)}`},
    ]) {
      expect(await preflight({revert})).toMatch(/^fynd: the price moved past your minimum — the route now pays 1, under your minimum 2\. Nothing was sent/);
    }
    expect(await preflight({revert: {message: "execution reverted: TychoRouter__NegativeSlippage"}, balance: 10n ** 12n, allowance: 10n ** 12n}))
      .toBe("fynd: the price moved past your minimum. Nothing was sent; refresh the quote.");
  });

  it("ERC-20 input: a balance under the amount is named, not blamed on the price", async () => {
    const reads: string[] = [];
    const why = await preflight({revert: {message: "execution reverted"}, balance: 999_999_999n, allowance: 10n ** 12n, reads});
    expect(why).toBe("fynd: the wallet's balance is below the amount (999999999 < 1000000000). Nothing was sent.");
    expect(why).not.toMatch(/price/);
    expect(reads.sort()).toEqual(["allowance", "balanceOf"]);
  });

  it("ERC-20 input: an allowance the RPC does not see yet is named, not blamed on the price", async () => {
    const why = await preflight({revert: {message: "execution reverted", data: encodeErrorResult({abi: ERRORS, errorName: "Error", args: ["ERC20: transfer amount exceeds allowance"]})}, balance: 10n ** 12n, allowance: 0n});
    expect(why).toBe("fynd: the token approval is not visible on-chain yet. Nothing was sent; try again in a moment.");
  });

  it("the allowance is read for the quote's approval address (the router)", async () => {
    let spender = "";
    vi.stubGlobal("fetch", fake());
    const p = fyndProvider({apiKey: "k", rpcUrls: RPC});
    const q = (await p.getQuote(USDC_IN as never))!;
    const inner = fake({revert: {message: "execution reverted"}, balance: 10n ** 12n, allowance: 10n ** 12n});
    vi.stubGlobal("fetch", (async (url: string, init: {body: string}) => {
      const call = (JSON.parse(init.body) as {params?: Array<{data?: Hex}>}).params?.[0];
      if (call?.data?.startsWith("0xdd62ed3e")) spender = String(decodeFunctionData({abi: ERC20, data: call.data}).args[1]);
      return inner(url, init as never);
    }) as unknown as typeof fetch);
    await expect(p.preflightDeposit!(q, await p.buildDeposit(q))).rejects.toThrow(/would revert now/);
    expect(spender.toLowerCase()).toBe(ROUTER.toLowerCase());
  });

  it("balance and approval in place: the revert is named as it is, neutrally (a string reason, a router error)", async () => {
    const enough = {balance: 10n ** 12n, allowance: 10n ** 12n};
    const stf = await preflight({revert: {message: "execution reverted", data: encodeErrorResult({abi: ERRORS, errorName: "Error", args: ["STF"]})}, ...enough});
    expect(stf).toBe("fynd: the swap would revert now (STF). Nothing was sent; refresh the quote.");
    const fees = await preflight({revert: {message: "execution reverted", data: encodeErrorResult({abi: ERRORS, errorName: "TychoRouter__FeesExceedOutput", args: [5n, 4n]})}, ...enough});
    expect(fees).toBe("fynd: the swap would revert now (TychoRouter__FeesExceedOutput(5, 4)). Nothing was sent; refresh the quote.");
    const bare = await preflight({revert: {message: "execution reverted"}, ...enough});
    expect(bare).toBe("fynd: the swap would revert now (execution reverted). Nothing was sent; refresh the quote.");
    for (const why of [stf, fees, bare]) expect(why).not.toMatch(/price/);
  });

  it("native input: the coin balance under the value is named; enough of it leaves the neutral reason", async () => {
    const reads: string[] = [];
    expect(await preflight({revert: {message: "execution reverted"}, native: 10n ** 17n, reads}, ETH_IN))
      .toBe("fynd: the wallet's balance is below the amount (100000000000000000 < 1000000000000000000). Nothing was sent.");
    expect(reads).toEqual(["eth_getBalance"]);
    expect(await preflight({revert: {message: "execution reverted"}, native: 2n * 10n ** 18n}, ETH_IN))
      .toBe("fynd: the swap would revert now (execution reverted). Nothing was sent; refresh the quote.");
  });

  it("when the diagnostic reads fail the refusal still stands, neutrally; a swap that executes still passes", async () => {
    expect(await preflight({revert: {message: "execution reverted"}, readsFail: true})).toBe("fynd: the swap would revert now (execution reverted). Nothing was sent; refresh the quote.");
    expect(await preflight({revert: {message: "execution reverted"}, readsFail: true}, ETH_IN)).toBe("fynd: the swap would revert now (execution reverted). Nothing was sent; refresh the quote.");
    expect(await preflight({})).toBe("");
  });

  it("the RPC's reason is bounded in the refusal", async () => {
    const why = await preflight({revert: {message: `execution reverted: ${"x".repeat(100_000)}`}, balance: 10n ** 12n, allowance: 10n ** 12n});
    expect(why.length).toBeLessThan(250);
  });
});

describe("the engine around a refused preflight is unchanged", () => {
  it("approve the router, refuse with the named reason, revoke the approval; the swap is never sent", async () => {
    vi.stubGlobal("fetch", fake({revert: {message: "execution reverted"}, balance: 10n ** 12n, allowance: 0n}));
    const sent: UnsignedTx[] = [];
    const account = {getAddress: async () => ME, getChainId: async () => 8453, getAllowance: async () => 0n, waitForTransaction: async () => {}, sendTransaction: async (t: UnsignedTx) => { sent.push(t); return {hash: `0x${sent.length}`}; }};
    const provider = fyndProvider({apiKey: "k", rpcUrls: RPC});
    class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
    const p = new P(account as never, {fromChain: "eip155:8453"} as never);
    await expect(p.swap2({fromToken: "USDC", toToken: WETH, toChain: 8453, recipient: ME, fromTokenAmount: 1_000_000_000n, minAmountOut: 390_000_000_000_000_000n} as never))
      .rejects.toThrow("fynd: the token approval is not visible on-chain yet. Nothing was sent; try again in a moment.");
    expect(sent.map((t) => t.to.toLowerCase())).toEqual([USDC.toLowerCase(), USDC.toLowerCase()]);
    const approvals = sent.map((t) => decodeFunctionData({abi: ERC20, data: t.data as Hex}).args as readonly [string, bigint]);
    expect(approvals.map(([spender]) => spender.toLowerCase())).toEqual([ROUTER.toLowerCase(), ROUTER.toLowerCase()]);
    expect(approvals.map(([, amount]) => amount)).toEqual([1_000_000_000n, 0n]);
  });
});
