// The SOR + JSON-RPC stub for one chain: the SOR returns the given paths, the Vault answers WETH() and prices
// queryBatchSwap at `vaultOut` for the last asset.
import {decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, type Hex} from "viem";

export const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
export const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const BAL = "0xba100000625a3754423978a60c9317c58a424e3D";
export const ME = "0x4444444444444444444444444444444444444444";
export const RPC = {1: ["https://rpc.test"]};
export const ZERO = "0x0000000000000000000000000000000000000000";
export const POOL_A = `0x${"aa".repeat(32)}`;
export const POOL_B = `0x${"bb".repeat(32)}`;
export const VAULT = parseAbi([
  "function queryBatchSwap(uint8 kind, (bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps, address[] assets, (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds) returns (int256[] assetDeltas)",
  "function batchSwap(uint8 kind, (bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps, address[] assets, (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds, int256[] limits, uint256 deadline) payable returns (int256[] assetDeltas)",
  "function WETH() view returns (address)",
]);

export interface Stub {
  /** SOR paths to return (tokens as addresses). */
  paths?: {pools: string[]; tokens: string[]; amountIn: string}[];
  /** Output the Vault prices (base units of the last token). */
  vaultOut?: bigint;
  weth?: string;
  receipt?: string | null;
  sorCalls?: string[];
}

export function stub(o: Stub = {}): typeof fetch {
  const paths = o.paths ?? [{pools: [POOL_A], tokens: [WETH, USDC], amountIn: "1000000000000000000"}];
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).includes("balancer")) {
      o.sorCalls?.push(body.query);
      return new Response(JSON.stringify({data: {sorGetSwapPaths: {protocolVersion: 2, paths: paths.map((p) => ({pools: p.pools, tokens: p.tokens.map((a) => ({address: a.toLowerCase(), decimals: 18})), inputAmountRaw: p.amountIn, outputAmountRaw: "1", protocolVersion: 2}))}}}));
    }
    if (body.method === "eth_getTransactionReceipt") return new Response(JSON.stringify({result: o.receipt == null ? null : {status: o.receipt}}));
    const data = body.params[0].data as Hex;
    if (data.startsWith("0xad5c4648")) return new Response(JSON.stringify({result: encodeAbiParameters([{type: "address"}], [(o.weth ?? WETH) as Hex])}));
    const call = decodeFunctionData({abi: VAULT, data});
    if (call.functionName !== "queryBatchSwap") throw new Error("unexpected call");
    const [, swaps, assets] = call.args;
    const amountIn = swaps.reduce((s, x) => s + x.amount, 0n);
    const deltas = assets.map((_, i) => (i === Number(swaps[0]!.assetInIndex) ? amountIn : i === assets.length - 1 ? -(o.vaultOut ?? 2_000_000n) : 0n));
    return new Response(JSON.stringify({result: encodeFunctionResult({abi: VAULT, functionName: "queryBatchSwap", result: deltas})}));
  }) as typeof fetch;
}
