// Scan 2026-10-27 (modules), F24: behind a backend the `preflight` body is the client's — only the quote is sealed —
// and preflightDeposit decoded the client's `tx.data` and priced it with queryBatchSwap on the server's RPC: any batch,
// any size, on the operator's quota. Now only the quote's own batch is decoded and priced, at most BALANCER_MAX_SWAPS
// hops with no userData. A real handler (seal, verify) in front of the real provider; the SOR and the RPC are stubs.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, parseAbi, type Hex} from "viem";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import type {Quote} from "@anywalletkit/protocol-swap2-core/types";
import {BALANCER_MAX_SWAPS, BALANCER_V2_VAULT, balancerProvider} from "../src/provider.js";

afterEach(() => vi.unstubAllGlobals());

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ME = "0x4444444444444444444444444444444444444444";
const POOL = `0x${"aa".repeat(32)}` as Hex;
const VAULT = parseAbi([
  "function queryBatchSwap(uint8 kind, (bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps, address[] assets, (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds) returns (int256[] assetDeltas)",
  "function batchSwap(uint8 kind, (bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps, address[] assets, (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds, int256[] limits, uint256 deadline) payable returns (int256[] assetDeltas)",
]);
const PARAMS = {sourceChain: "eip155:1", destChain: "eip155:1", sourceToken: "WETH", destToken: USDC, amountIn: "1000000000000000000", destAddress: ME, refundAddress: ME, dry: false};

/** The SOR (one pool, WETH → USDC) and an RPC that prices any batch at 2 USDC; `queries` counts queryBatchSwap calls. */
function stub(pools = 1) {
  const queries: number[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).includes("balancer")) {
      const tokens = [WETH, ...Array.from({length: pools - 1}, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`), USDC];
      return new Response(JSON.stringify({data: {sorGetSwapPaths: {protocolVersion: 2, paths: [{pools: Array.from({length: pools}, () => POOL), tokens: tokens.map((a) => ({address: a.toLowerCase(), decimals: 18})), inputAmountRaw: PARAMS.amountIn, outputAmountRaw: "1", protocolVersion: 2}]}}}));
    }
    const data = body.params[0].data as Hex;
    if (data.startsWith("0xad5c4648")) return new Response(JSON.stringify({result: encodeAbiParameters([{type: "address"}], [WETH])}));
    const call = decodeFunctionData({abi: VAULT, data});
    if (call.functionName !== "queryBatchSwap") throw new Error("unexpected call");
    const [, swaps, assets] = call.args;
    queries.push(swaps.length);
    const deltas = assets.map((_, i) => (i === 0 ? BigInt(PARAMS.amountIn) : i === assets.length - 1 ? -2_000_000n : 0n));
    return new Response(JSON.stringify({result: encodeFunctionResult({abi: VAULT, functionName: "queryBatchSwap", result: deltas})}));
  }) as typeof fetch;
  return {queries, fetchImpl};
}

async function sealedQuote() {
  const s = stub();
  vi.stubGlobal("fetch", s.fetchImpl);
  const provider = balancerProvider({rpcUrls: {1: ["https://rpc.test"]}});
  const handle = createSwap2Handler({providers: [provider], sealSecret: "s".repeat(32), guard: () => {}});
  const quoted = await handle("quote", {provider: "balancer", params: PARAMS}, null);
  expect(quoted.status).toBe(200);
  const quote = quoted.body as Quote;
  const tx = {chain: "eip155:1", to: BALANCER_V2_VAULT, value: "0", data: quote.txRequest!.data!, chainId: 1};
  return {handle, quote, tx, queries: s.queries};
}

/** A batchSwap the client wrote itself: `n` hops through an arbitrary pool, with `userData`. */
const clientBatch = (n: number, userData: Hex = "0x") => encodeFunctionData({abi: VAULT, functionName: "batchSwap", args: [0, Array.from({length: n}, () => ({poolId: POOL, assetInIndex: 0n, assetOutIndex: 1n, amount: 1n, userData})), [WETH, USDC], {sender: ME, fromInternalBalance: false, recipient: ME, toInternalBalance: false}, [1n, 0n], 2n ** 64n]});

describe("Balancer preflight prices only the quoted batch (scan 2026-10-27 modules, F24)", () => {
  it("a client's own batch (2 000 hops, pool userData) is refused before it is decoded or priced", async () => {
    const {handle, quote, tx, queries} = await sealedQuote();
    const before = queries.length;
    for (const data of [clientBatch(2_000), clientBatch(1, `0x${"ff".repeat(4096)}`), `0x${"00".repeat(400_000)}`]) {
      const res = await handle("preflight", {provider: "balancer", quote, tx: {...tx, data}}, null);
      expect(res.status).toBe(422);
      expect((res.body as {error: string}).error).toBe("balancer: the transaction is not the quoted batch. Nothing was sent; refresh the quote.");
    }
    expect(queries.length).toBe(before);
  });

  it("the quoted batch is still re-priced (case of the hex does not matter)", async () => {
    const {handle, quote, tx, queries} = await sealedQuote();
    const before = queries.length;
    expect((await handle("preflight", {provider: "balancer", quote, tx}, null)).status).toBe(200);
    expect((await handle("preflight", {provider: "balancer", quote, tx: {...tx, data: `0x${tx.data.slice(2).toUpperCase()}`}}, null)).status).toBe(200);
    expect(queries.slice(before)).toEqual([1, 1]);
  });

  it(`a route of more than ${BALANCER_MAX_SWAPS} hops is refused at the quote; an unsealed quote with one is refused at preflight`, async () => {
    const s = stub(BALANCER_MAX_SWAPS + 1);
    vi.stubGlobal("fetch", s.fetchImpl);
    const p = balancerProvider({rpcUrls: {1: ["https://rpc.test"]}});
    let why = "";
    expect(await p.getQuote({...PARAMS, onRefusal: (r) => { why = r; }})).toBeNull();
    expect(why).toBe(`balancer: the SOR route has ${BALANCER_MAX_SWAPS + 1} pool hops, more than ${BALANCER_MAX_SWAPS}`);
    expect(s.queries).toEqual([]);
    // In-process (no seal): a quote whose own batch is oversized or carries userData is not priced either.
    const {quote, queries} = await sealedQuote();
    const before = queries.length;
    for (const [data, re] of [[clientBatch(BALANCER_MAX_SWAPS + 1), /pool hops, not 1–16/], [clientBatch(1, "0xdead"), /userData/]] as const) {
      const forged = {...quote, intentId: "balancer:1", txRequest: {...quote.txRequest!, data}}; // the provider's own id, as the engine holds it
      await expect(p.preflightDeposit!(forged, {chain: "eip155:1", to: BALANCER_V2_VAULT, value: "0", data})).rejects.toThrow(re);
    }
    expect(queries.length).toBe(before);
  });
});
