// Decision 7 (UNISWAP-V4-RESEARCH §8): the provider declares `ownGasEstimate`. What that changes for v3, end to end
// through the engine: the quote still carries its bounded gasLimit (information, and the gas bound that refuses a swap no
// block could mine), but the swap is dry-run from the account right before broadcast and sent with the account's own
// estimate — the quoted limit is never sent. A dry run that reverts refuses the swap; nothing is broadcast.
import {afterEach, describe, expect, it, vi} from "vitest";
import {refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import {UniswapSwap2Protocol} from "../src/protocol.js";
import {uniswapProvider} from "../src/provider.js";
import {D, ME, RPC, USDC, USDT, rpcStub} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

type Call = {to?: string; data?: string; value?: bigint; gasLimit?: bigint};
function account(log: {sent: Call[]; estimated: Call[]}, dryRun?: (t: Call) => void) {
  return {
    getAddress: async () => ME,
    getChainId: async () => 1,
    getBalance: async () => 10n ** 21n,
    getAllowance: async () => 0n,
    quoteSendTransaction: async (t: Call) => {
      log.estimated.push(t);
      if (dryRun && t.to === D.router && t.gasLimit === undefined) dryRun(t);
      return {fee: 1n};
    },
    sendTransaction: async (t: Call) => { log.sent.push(t); return {hash: `0x${String(log.sent.length).padStart(64, "0")}`}; },
    waitForTransaction: async () => {},
  };
}
const nativeSale = {fromToken: "ETH", toToken: USDC, toChain: 1, recipient: ME, fromTokenAmount: 10n ** 15n, minAmountOut: 1n};
const tokenSale = {fromToken: "USDC", toToken: USDT, toChain: 1, recipient: ME, fromTokenAmount: 1_000_000n, minAmountOut: 1n};

describe("ownGasEstimate on a v3 swap", () => {
  it("native input: the quoted gasLimit stays on the quote but is not sent; the exact call is dry-run from the account first", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const log = {sent: [] as Call[], estimated: [] as Call[]};
    const q = await uniswapProvider({rpcUrls: RPC}).getQuote({sourceChain: "eip155:1", destChain: "eip155:1", sourceToken: "ETH", destToken: USDC, amountIn: String(10n ** 15n), destAddress: ME});
    expect(q?.txRequest?.gasLimit).toBe("255000"); // 90k quoter gas: need 210k × 1.05, padded 255k — still quoted
    const p = new UniswapSwap2Protocol(account(log) as never, {fromChain: "eip155:1", rpcUrls: RPC});
    await p.swap2(nativeSale);
    expect(log.sent).toHaveLength(1);
    expect(log.sent[0]!.to).toBe(D.router);
    expect(log.sent[0]!.gasLimit).toBeUndefined();
    expect(log.estimated.some((t) => t.to === D.router && t.gasLimit === undefined && t.value === 10n ** 15n)).toBe(true);
  });

  it("token input: the approval goes first as before; the swap itself is sent without the quoted gasLimit", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const log = {sent: [] as Call[], estimated: [] as Call[]};
    await new UniswapSwap2Protocol(account(log) as never, {fromChain: "eip155:1", rpcUrls: RPC}).swap2(tokenSale);
    const swap = log.sent.find((t) => t.to === D.router)!;
    expect(swap).toBeDefined();
    expect(swap.gasLimit).toBeUndefined();
    expect(log.sent[0]!.to?.toLowerCase()).toBe(USDC.toLowerCase()); // approve(router, exactly the input)
  });

  it("a dry run that reverts refuses the swap (simulation_failed) and nothing is broadcast", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const log = {sent: [] as Call[], estimated: [] as Call[]};
    const reverted = () => { throw Object.assign(new Error("execution reverted: Too little received"), {name: "CallExecutionError"}); };
    const err = await new UniswapSwap2Protocol(account(log, reverted) as never, {fromChain: "eip155:1", rpcUrls: RPC}).swap2(nativeSale).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(refusalOf(err)).toEqual({reason: "simulation_failed"});
    expect(log.sent).toHaveLength(0);
  });
});
