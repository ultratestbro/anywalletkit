// A stand-in KyberSwap API and RPC for the tests: `/routes` prices the request, `/route/build` encodes swap() the way
// the live endpoint does (2026-11-24: executor callTarget, no approve target, flags 0x200, the minimum one unit under
// floor(amountOut × (1 − slippage))). `tamper` rewrites what the "API" answers, for the hostile cases.
import {vi} from "vitest";
import {encodeFunctionData, type Hex} from "viem";
import {KYBER_EXECUTOR, KYBER_NATIVE, KYBER_ROUTER_ABI, KYBER_ROUTER_V2, kyberMinimum} from "../src/router.js";

export const ZERO = "0x0000000000000000000000000000000000000000";
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const WETH = "0x4200000000000000000000000000000000000006";
export const ME = "0x4444444444444444444444444444444444444444";
export const ATTACKER = "0x000000000000000000000000000000000000bEEF";
export const RPC = {8453: ["https://rpc.test"]};

export interface SwapArgs {
  callTarget?: string;
  approveTarget?: string;
  targetData?: Hex;
  srcToken: string;
  dstToken: string;
  srcReceivers?: string[];
  srcAmounts?: bigint[];
  feeReceivers?: string[];
  feeAmounts?: bigint[];
  dstReceiver: string;
  amount: bigint;
  minReturnAmount: bigint;
  flags?: bigint;
  permit?: Hex;
  clientData?: Hex;
}

/** The router calldata for `a`, filled the way the build endpoint fills it. */
export function swapData(a: SwapArgs): Hex {
  const native = a.srcToken.toLowerCase() === KYBER_NATIVE.toLowerCase();
  return encodeFunctionData({abi: KYBER_ROUTER_ABI, functionName: "swap", args: [{
    callTarget: (a.callTarget ?? KYBER_EXECUTOR) as Hex,
    approveTarget: (a.approveTarget ?? ZERO) as Hex,
    targetData: a.targetData ?? "0xdeadbeef",
    desc: {
      srcToken: a.srcToken as Hex,
      dstToken: a.dstToken as Hex,
      srcReceivers: (a.srcReceivers ?? (native ? [] : ["0x1e40450f8e21bb68490d7d91ab422888cd5a60f1"])) as Hex[],
      srcAmounts: a.srcAmounts ?? (native ? [] : [a.amount]),
      feeReceivers: (a.feeReceivers ?? []) as Hex[],
      feeAmounts: a.feeAmounts ?? [],
      dstReceiver: a.dstReceiver as Hex,
      amount: a.amount,
      minReturnAmount: a.minReturnAmount,
      flags: a.flags ?? 0x200n,
      permit: a.permit ?? "0x",
    },
    clientData: a.clientData ?? "0x7b7d",
  }]});
}

export interface Stub {
  /** The route's amountOut. */
  out?: bigint;
  routerAddress?: string;
  /** HTTP status + Kyber error code on /routes (or on /route/build with `onBuild`). */
  error?: {status: number; code?: number; message?: string; onBuild?: boolean};
  extraFee?: Record<string, unknown>;
  tamperSummary?: (s: Record<string, unknown>) => Record<string, unknown>;
  /** Rewrite the build's swap arguments (a compromised or buggy endpoint). */
  tamper?: (a: SwapArgs) => SwapArgs;
  tamperBuild?: (b: Record<string, unknown>) => Record<string, unknown>;
  ethCall?: "ok" | "revert-min" | "revert-other" | "down";
  calls?: {url: string; method: string; body?: Record<string, unknown>; headers: Record<string, string>}[];
}

export function stub(o: Stub = {}): typeof fetch {
  return vi.fn(async (url: string, init: {method?: string; body?: string; headers?: Record<string, string>} = {}) => {
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    o.calls?.push({url, method: init.method ?? "GET", ...(body ? {body} : {}), headers: init.headers ?? {}});
    if (url.includes("/api/v1/routes")) {
      if (o.error && !o.error.onBuild) return new Response(JSON.stringify({code: o.error.code, message: o.error.message ?? "error"}), {status: o.error.status});
      const q = new URL(url).searchParams;
      let summary: Record<string, unknown> = {
        tokenIn: q.get("tokenIn")!.toLowerCase(), amountIn: q.get("amountIn"), tokenOut: q.get("tokenOut")!.toLowerCase(),
        amountOut: (o.out ?? 400_000_000_000_000_000n).toString(), gas: "330498", extraFee: o.extraFee ?? {feeAmount: "", chargeFeeBy: "", isInBps: false, feeReceiver: ""},
        route: [[{pool: "0xpool", exchange: "uniswapv3"}]], routeID: "r-1", checksum: "123", timestamp: 1795528620,
      };
      if (o.tamperSummary) summary = o.tamperSummary(summary);
      return new Response(JSON.stringify({code: 0, message: "successfully", data: {routeSummary: summary, routerAddress: o.routerAddress ?? KYBER_ROUTER_V2}}));
    }
    if (url.includes("/api/v1/route/build")) {
      if (o.error?.onBuild) return new Response(JSON.stringify({code: o.error.code, message: o.error.message ?? "error"}), {status: o.error.status});
      const s = body!.routeSummary as Record<string, string>;
      const amountOut = BigInt(s.amountOut!);
      let args: SwapArgs = {srcToken: s.tokenIn!, dstToken: s.tokenOut!, dstReceiver: String(body!.recipient), amount: BigInt(s.amountIn!), minReturnAmount: kyberMinimum(amountOut, Number(body!.slippageTolerance))};
      if (o.tamper) args = o.tamper(args);
      const native = s.tokenIn!.toLowerCase() === KYBER_NATIVE.toLowerCase();
      let b: Record<string, unknown> = {amountIn: s.amountIn, amountOut: s.amountOut, gas: "330498", data: swapData(args), routerAddress: o.routerAddress ?? KYBER_ROUTER_V2, transactionValue: native ? s.amountIn : "0"};
      if (o.tamperBuild) b = o.tamperBuild(b);
      return new Response(JSON.stringify({code: 0, message: "successfully", data: b}));
    }
    // JSON-RPC
    const rpc = body as {method: string};
    if (o.ethCall === "down") throw new TypeError("fetch failed");
    if (rpc.method === "eth_call") {
      const to = ((body as {params: [{to: string}]}).params[0].to ?? "").toLowerCase();
      if (to !== KYBER_ROUTER_V2.toLowerCase()) return new Response(JSON.stringify({jsonrpc: "2.0", id: 1, result: `0x${(10n ** 30n).toString(16).padStart(64, "0")}`}));
      if (o.ethCall === "revert-min") return new Response(JSON.stringify({jsonrpc: "2.0", id: 1, error: {message: "execution reverted: Return amount is not enough"}}));
      if (o.ethCall === "revert-other") return new Response(JSON.stringify({jsonrpc: "2.0", id: 1, error: {message: "execution reverted: pool locked"}}));
      return new Response(JSON.stringify({jsonrpc: "2.0", id: 1, result: "0x"}));
    }
    if (rpc.method === "eth_getBalance") return new Response(JSON.stringify({jsonrpc: "2.0", id: 1, result: `0x${(10n ** 30n).toString(16)}`}));
    if (rpc.method === "eth_getTransactionReceipt") return new Response(JSON.stringify({jsonrpc: "2.0", id: 1, result: {status: "0x1"}}));
    return new Response("{}", {status: 404});
  }) as unknown as typeof fetch;
}

export const params = (over: Record<string, unknown> = {}) => ({
  sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:8453", destToken: WETH,
  amountIn: "1000000000", destAddress: ME, refundAddress: ME, slippageBps: 50, ...over,
});
