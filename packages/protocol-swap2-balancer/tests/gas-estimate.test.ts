// Quote.gasEstimate (protocol-swap2-core's contract, source "model"): the measured table of src/gas.ts — a base plus
// one cost per hop by the pool's specialization (from its pool id). Checked on the provider's quotes, and against the
// recordings in fixtures/gas (the provider's own quotes simulated with eth_simulateV1, and real batchSwap transactions
// sent straight to the Vault, recorded read-only on 2026-11-28).
import {afterEach, describe, expect, it, vi} from "vitest";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {decodeFunctionData, type Hex} from "viem";
import {gasEstimateProblem} from "@anywalletkit/protocol-swap2-core/validate";
import {BALANCER_V2_CHAINS, BALANCER_V2_VAULT, balancerProvider} from "../src/provider.js";
import {BALANCER_GAS_BASE, BALANCER_GAS_CHAINS, BALANCER_HOP_GAS, balancerGasEstimate, balancerSpecialization} from "../src/gas.js";
import {ME, POOL_A, RPC, USDC, VAULT, WETH, stub} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const base = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME};
/** A pool id with the given specialization code (bytes 20–21). */
const idOf = (code: number, fill = "5c") => `0x${fill.repeat(20)}${code.toString(16).padStart(4, "0")}${"00".repeat(10)}`;

describe("the table", () => {
  it("reads the specialization from the pool id: 0 general, 1 minimal swap info, 2 two token, else nothing", () => {
    expect(balancerSpecialization(idOf(0))).toBe("general");
    expect(balancerSpecialization(idOf(1))).toBe("minimal");
    expect(balancerSpecialization(idOf(2))).toBe("two-token");
    expect(balancerSpecialization(idOf(3))).toBeUndefined();
    expect(balancerSpecialization(POOL_A)).toBeUndefined(); // the stubs' 0xaa… ids
    expect(balancerSpecialization("0x1234")).toBeUndefined();
  });

  it("base + each hop's cost, at most the quote's gas limit", () => {
    const limit = (hops: number) => 160_000n + 95_000n * BigInt(hops);
    expect(balancerGasEstimate(1, [idOf(2)], limit(1))).toBe(BALANCER_GAS_BASE + BALANCER_HOP_GAS["two-token"]);
    expect(balancerGasEstimate(1, [idOf(2), idOf(1), idOf(0)], limit(3))).toBe(BALANCER_GAS_BASE + BALANCER_HOP_GAS["two-token"] + BALANCER_HOP_GAS.minimal + BALANCER_HOP_GAS.general);
    // The provider's limit (160,000 + 95,000 a hop) covers every batch it builds: 1..16 hops of the dearest kind.
    for (let n = 1; n <= 16; n++) expect(balancerGasEstimate(1, Array(n).fill(idOf(0)), limit(n)), String(n)).toBeDefined();
    expect(balancerGasEstimate(1, [idOf(2)], BALANCER_GAS_BASE + BALANCER_HOP_GAS["two-token"] - 1n)).toBeUndefined();
    expect(balancerGasEstimate(1, [idOf(2), idOf(3)], limit(2))).toBeUndefined();
    expect(balancerGasEstimate(1, [], limit(0))).toBeUndefined();
  });

  it("measured chains only, every one a Vault chain", () => {
    for (const c of BALANCER_GAS_CHAINS) expect(Object.prototype.hasOwnProperty.call(BALANCER_V2_CHAINS, c), String(c)).toBe(true);
    for (const c of [137, 146, 9745, 43114, 31337]) expect(balancerGasEstimate(c, [idOf(2)], 10n ** 9n), String(c)).toBeUndefined();
  });
});

describe("the provider's quotes", () => {
  it("a two-token hop on Ethereum: the table's figure, a model, within the core contract and under the gas limit", async () => {
    const pool = idOf(2);
    vi.stubGlobal("fetch", stub({paths: [{pools: [pool], tokens: [WETH, USDC], amountIn: "1000000000000000000"}]}));
    const q = await balancerProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "WETH", destToken: USDC, amountIn: "1000000000000000000"});
    expect(q!.txRequest!.to).toBe(BALANCER_V2_VAULT);
    expect(q!.gasEstimate).toBe((BALANCER_GAS_BASE + BALANCER_HOP_GAS["two-token"]).toString());
    expect(q!.gasEstimateSource).toBe("model");
    expect(gasEstimateProblem(q!, "eip155:1")).toBeNull();
    expect(BigInt(q!.gasEstimate!) <= BigInt(q!.txRequest!.gasLimit!)).toBe(true);
  });

  it("a pool id of no known specialization: no estimate, the quote otherwise as before", async () => {
    vi.stubGlobal("fetch", stub());
    const q = await balancerProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "WETH", destToken: USDC, amountIn: "1000000000000000000"});
    expect(q).toMatchObject({txRequest: {to: BALANCER_V2_VAULT, gasLimit: "255000"}});
    expect(q!.gasEstimate).toBeUndefined();
    expect(q!.gasEstimateSource).toBeUndefined();
  });
});

describe("the recordings (fixtures/gas/batchswap-2026-11-28.json)", () => {
  const fx = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/gas/batchswap-2026-11-28.json", import.meta.url)), "utf8")) as {
    simulated: {chainId: number; to: string; data: string; gasLimit: string; simulatedGasUsed: string; recipient: string}[];
    receipts: {chainId: number; to: string; data: string; status: string; gasUsed: string}[];
  };
  const estimate = (chainId: number, data: string, gasLimit: bigint) => {
    const call = decodeFunctionData({abi: VAULT, data: data as Hex});
    expect(call.functionName).toBe("batchSwap");
    return balancerGasEstimate(chainId, (call.args[1] as readonly {poolId: string}[]).map((s) => s.poolId), gasLimit);
  };
  const spread = (errors: number[]) => {
    const a = errors.map(Math.abs).sort((p, q) => p - q);
    return {median: a[Math.floor(a.length / 2)]!, p90: a[Math.floor(0.9 * (a.length - 1))]!, max: a.at(-1)!};
  };

  it("hold no endpoint, and are Vault batchSwaps", () => {
    expect(JSON.stringify(fx)).not.toMatch(/https?:\/\//);
    for (const r of [...fx.simulated, ...fx.receipts]) expect(r.to.toLowerCase()).toBe(BALANCER_V2_VAULT.toLowerCase());
    expect(fx.simulated.length).toBeGreaterThanOrEqual(50);
    expect(fx.receipts.length).toBe(2);
  });

  it("the provider's simulated quotes: an estimate on each, under its gas limit; median within 6% of the simulated gasUsed, 9 in 10 within 20%, none off by more than 26%", () => {
    const errors: number[] = [];
    for (const r of fx.simulated) {
      const e = estimate(r.chainId, r.data, BigInt(r.gasLimit));
      expect(e, r.data.slice(0, 80)).toBeDefined();
      expect(gasEstimateProblem({gasEstimate: e!.toString(), gasEstimateSource: "model", txRequest: {to: r.to, data: r.data, gasLimit: r.gasLimit}}, `eip155:${r.chainId}`)).toBeNull();
      errors.push(Number(e! - BigInt(r.simulatedGasUsed)) / Number(r.simulatedGasUsed));
    }
    const s = spread(errors);
    expect(s.median).toBeLessThanOrEqual(0.06);
    expect(s.p90).toBeLessThanOrEqual(0.2);
    expect(s.max).toBeLessThanOrEqual(0.26);
  });

  it("the real batchSwaps sent straight to the Vault (Arbitrum five hops over two paths, Base two hops): within 10% of their receipts' gasUsed", () => {
    for (const r of fx.receipts) {
      expect(r.status).toBe("0x1");
      const e = estimate(r.chainId, r.data, 10n ** 9n);
      expect(e).toBeDefined();
      expect(Math.abs(Number(e! - BigInt(r.gasUsed))) / Number(r.gasUsed)).toBeLessThanOrEqual(0.1);
    }
  });
});
