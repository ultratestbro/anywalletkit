// LIVE-1 (U1/U2 review round 1): on Monad, a V4Quoter candidate that needs more gas than the chain's 30M per-transaction
// cap starves even alone in its Multicall3 aggregate (UnexpectedRevertBytes("")). Before the fix that empty revert read
// as "the node did not answer" and refused the whole Uniswap quote, v3 included: 2,000 AUSD → MON and 20,000 USDC → AUSD
// were unquotable with v4 on, on every Monad RPC. Now such a call is read once more, straight to the V4Quoter with
// exactly 30M gas named; still empty, the route could never be mined (§6.5 row 17) — it is ranked out and counted
// (`providerData.v4Unexecutable`), and the other candidates quote as usual.
//
// Recorded read-only at Monad block 125,520,066 on 2026-11-26 by the round-1 provider itself
// (fixtures/rpc/monad-125520066-live1.json: every answer, keyed by method, target, calldata and the gas named).
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeAbiParameters, getAddress, type Hex} from "viem";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {uniswapProvider, type UniswapProviderConfig} from "../src/provider.js";
import {UNISWAP_V3, uniswapVerifyQuote} from "../src/addresses.js";
import {UNISWAP_V4} from "../src/v4/addresses.js";

afterEach(() => vi.unstubAllGlobals());

interface Fixture {
  chainId: number;
  block: {number: string; hex: string};
  calls: Record<string, {result?: unknown; error?: {code: number; message: string; data?: string}}>;
}
const fx = JSON.parse(readFileSync(new URL("../fixtures/rpc/monad-125520066-live1.json", import.meta.url), "utf8")) as Fixture;
const D4 = UNISWAP_V4[143]!;
const AUSD = getAddress("0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a");
const NATIVE = "0x0000000000000000000000000000000000000000";
const ME = "0x1111111111111111111111111111111111111111";
const RPC = {143: ["https://monad.fixture"]};
const CAP = 30_000_000n;

function replay() {
  const misses: string[] = [];
  const bound: {to: string; gas: bigint}[] = [];
  const f = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]} | {id: number; method: string; params: unknown[]}[];
    const batch = Array.isArray(body) ? body : [body];
    const out = batch.map((req) => {
      let key = req.method;
      if (req.method === "eth_call") {
        const c = req.params[0] as {to: string; data: string; gas?: string};
        key = `eth_call ${c.to.toLowerCase()} ${c.data.toLowerCase()}${c.gas ? ` gas=${BigInt(c.gas)}` : ""}`;
        if (c.gas && getAddress(c.to) === getAddress(D4.quoter)) bound.push({to: c.to, gas: BigInt(c.gas)});
      } else if (req.method === "eth_getCode") {
        key = `eth_getCode ${String(req.params[0]).toLowerCase()}`;
      }
      const answer = fx.calls[key];
      if (!answer) {
        misses.push(key.slice(0, 120));
        return {jsonrpc: "2.0", id: req.id, error: {code: -32603, message: "not in the recording"}};
      }
      return {jsonrpc: "2.0", id: req.id, ...answer};
    });
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]));
  }) as typeof fetch;
  return {fetch: f, misses, bound};
}
const params = (sourceToken: string, destToken: string, amountIn: bigint): QuoteParams => ({sourceChain: "eip155:143", destChain: "eip155:143", sourceToken, destToken, amountIn: amountIn.toString(), destAddress: ME, refundAddress: ME});
async function quote(p: QuoteParams, config: Partial<UniswapProviderConfig>) {
  const r = replay();
  vi.stubGlobal("fetch", r.fetch);
  const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
  const q = await uniswapProvider({rpcUrls: RPC, ...config}).getQuote({...p, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }});
  return {q, heard, misses: r.misses, bound: r.bound};
}
const AUSD_MON = params("AUSD", NATIVE, 2_000_000_000n);
const USDC_AUSD = params("USDC", AUSD, 20_000_000_000n);

describe("LIVE-1, Monad block 125,520,066: candidates past the 30M cap are ranked out, never the whole quote refused", () => {
  it("the recording holds no endpoint, and its re-reads at the bound starve: UnexpectedRevertBytes(\"\") with 30M gas", () => {
    expect(JSON.stringify(fx)).not.toMatch(/https?:\/\//);
    const reread = Object.entries(fx.calls).filter(([k]) => k.startsWith(`eth_call ${D4.quoter.toLowerCase()} `) && k.endsWith(` gas=${CAP}`));
    expect(reread.length).toBeGreaterThan(0);
    for (const [, v] of reread) {
      expect(v.error?.code).toBe(3);
      const data = v.error!.data as Hex;
      expect(data.slice(0, 10)).toBe("0x6190b2b0"); // UnexpectedRevertBytes(bytes)
      expect(decodeAbiParameters([{type: "bytes"}], `0x${data.slice(10)}`)[0]).toBe("0x"); // …of nothing: the inner call starved
    }
  });

  it('2,000 AUSD → MON, v4 "all": 182,815.6 MON on v4 (4 candidates past the cap ranked out); v3 alone pays 78.65', async () => {
    const {q, heard, misses, bound} = await quote(AUSD_MON, {v4: "all"});
    expect(misses).toEqual([]);
    expect(heard).toEqual([]);
    expect(q).toMatchObject({destAmount: "182815619388841801516424", txRequest: {to: D4.swapProxy, value: "0", approvalAddress: D4.swapProxy}, providerData: {venue: "v4", route: "v4 via USDC 0.005%/1 → 0.05%/10", v4Unexecutable: "4", simulated: "none"}});
    // The re-reads went straight to the V4Quoter with exactly Monad's per-transaction cap named.
    expect(bound.length).toBeGreaterThan(0);
    expect(bound.every((b) => b.gas === CAP)).toBe(true);
    expect(uniswapVerifyQuote(AUSD_MON, q!)).toBeNull();
    const off = await quote(AUSD_MON, {});
    expect(off.q).toMatchObject({destAmount: "78652323460800054581", txRequest: {to: UNISWAP_V3[143]!.router}});
    expect(off.q!.providerData!.v4Unexecutable).toBeUndefined();
  });

  it("2,000 AUSD → MON at maxPriceImpactBps 500 (cp0x's setting): quoted, G = max(probe 49, spot 54)", async () => {
    const {q, heard, misses} = await quote(AUSD_MON, {v4: "all", maxPriceImpactBps: 500});
    expect(misses).toEqual([]);
    expect(heard).toEqual([]);
    expect(q).toMatchObject({destAmount: "182815619388841801516424", providerData: {venue: "v4", priceImpactBps: "49", valueLossBps: "54", v4Unexecutable: "4"}});
  });

  it("20,000 USDC → AUSD: 20,002.93 AUSD on the AUSD/USDC 0.005%/1 pool (1 candidate past the cap ranked out); v3 alone pays 1.13", async () => {
    for (const config of [{v4: "all" as const}, {v4: "all" as const, maxPriceImpactBps: 500}]) {
      const {q, heard, misses} = await quote(USDC_AUSD, config);
      expect(misses).toEqual([]);
      expect(heard).toEqual([]);
      expect(q).toMatchObject({destAmount: "20002928571", txRequest: {to: D4.swapProxy}, providerData: {venue: "v4", route: "v4 direct 0.005%/1", v4Unexecutable: "1"}});
      expect(uniswapVerifyQuote(USDC_AUSD, q!)).toBeNull();
    }
    const off = await quote(USDC_AUSD, {});
    expect(off.q).toMatchObject({destAmount: "1128958", txRequest: {to: UNISWAP_V3[143]!.router}});
  });
});
