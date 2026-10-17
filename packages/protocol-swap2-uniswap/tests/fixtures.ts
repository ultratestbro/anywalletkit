// A JSON-RPC stub for one chain: the pinned deployment answers factory()/WETH9(),
// QuoterV2 answers single-hop quotes from a fee → amountOut table (multi-hop reverts).
import {decodeFunctionData, encodeAbiParameters, parseAbi, type Hex} from "viem";
import {UNISWAP_V3} from "../src/addresses.js";

export const D = UNISWAP_V3[1]!;
export const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
export const ME = "0x4444444444444444444444444444444444444444";
export const RPC = {1: ["https://rpc.test"]};

const QUOTER = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256, uint160, uint32, uint256)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256, uint160[], uint32[], uint256)",
]);
const NOMINAL_IN = 1_000_000n;
const word = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;

export interface StubOptions {
  /** amountOut per fee tier for a NOMINAL (1e6) input on direct quotes; other inputs scale linearly (missing tier = no pool → revert). */
  byFee?: Record<number, bigint>;
  /** Pool price impact in bps, applied to inputs of at least the nominal size (a 1/1000 probe sees the marginal rate). */
  impactBps?: number;
  /** A wrong factory on the router: the pinned deployment no longer matches. */
  badFactory?: boolean;
  /** Receipt status for eth_getTransactionReceipt ("0x1", "0x0" or null = not mined). */
  receipt?: string | null;
  /** HTTP-fail every request to these URLs. */
  down?: string[];
}

export function rpcStub(o: StubOptions = {}): typeof fetch & {urls: string[]} {
  const byFee = o.byFee ?? {500: 1_000_000n, 3000: 990_000n};
  const urls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (o.down?.includes(url)) return new Response("down", {status: 502});
    const batch = JSON.parse(String(init?.body)) as {id: number; method: string; params: [{to: string; data: Hex}] | [string]}[];
    const out = batch.map((req) => {
      if (req.method === "eth_getTransactionReceipt") return {id: req.id, result: o.receipt === null || o.receipt === undefined ? null : {status: o.receipt}};
      const {to, data} = req.params[0] as {to: string; data: Hex};
      const sel = data.slice(0, 10);
      if (sel === "0xc45a0155") return {id: req.id, result: word(o.badFactory && to === D.router ? "0x000000000000000000000000000000000000dead" : D.factory)};
      if (sel === "0x4aa4a4fc") return {id: req.id, result: word(D.weth)};
      try {
        const call = decodeFunctionData({abi: QUOTER, data});
        if (call.functionName === "quoteExactInputSingle") {
          const {fee, amountIn} = call.args[0] as {fee: number; amountIn: bigint};
          const nominal = byFee[fee];
          if (nominal === undefined) return {id: req.id, error: {code: 3, message: "execution reverted"}};
          let amount = (nominal * amountIn) / NOMINAL_IN;
          if (o.impactBps && amountIn >= NOMINAL_IN) amount = (amount * BigInt(10_000 - o.impactBps)) / 10_000n;
          return {id: req.id, result: encodeAbiParameters([{type: "uint256"}, {type: "uint160"}, {type: "uint32"}, {type: "uint256"}], [amount, 0n, 1, 90_000n])};
        }
      } catch {
        /* fall through */
      }
      return {id: req.id, error: {code: 3, message: "execution reverted"}};
    });
    return new Response(JSON.stringify(out));
  }) as typeof fetch & {urls: string[]};
  f.urls = urls;
  return f;
}
