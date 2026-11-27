// Quote.gasEstimate (2026-11-28): a Relay quote carries none. Relay's one gas figure for the deposit, the step's `gas`
// (undescribed in Relay's API reference), is a gas limit with a 30 % margin — `eth_estimateGas` × 1.3 — not the gas
// the deposit uses; `fees.gas` is that figure priced at `maxFeePerGas`. fixtures/gas/measured-2026-11-28.json: ten live
// quotes, each deposit simulated right after it was quoted, and the receipts of two public deposits.
import {readFileSync} from "node:fs";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {gasEstimateProblem} from "@anywalletkit/protocol-swap2-core/validate";
import {forgetClearedOrders} from "../src/cleared.js";
import {relayProvider} from "../src/provider.js";
import {DIRECT, loadQuote} from "./fixtures.js";

type Measured = {name: string; depositGas: string; maxFeePerGas: string; feesGasAmount: string; quoteGasLimit: string; simulatedGasUsed: number; estimateGas: number};
const measured = JSON.parse(readFileSync(new URL("../fixtures/gas/measured-2026-11-28.json", import.meta.url), "utf8")) as {quotes: Measured[]; receipts: {gasUsed: number; selector: string}[]};

beforeEach(() => { vi.useFakeTimers({toFake: ["Date"]}); forgetClearedOrders(); });
afterEach(() => { vi.useRealTimers(); });

describe("Relay gasEstimate: absent — Relay's gas figure is a limit with a margin", () => {
  it("the recorded quotes the provider takes carry no gasEstimate and keep their gas limit", async () => {
    let n = 0;
    for (const name of DIRECT) {
      const f = loadQuote(name);
      vi.setSystemTime(f.request.nowMs);
      const fetchImpl = (async () => new Response(JSON.stringify(f.response), {status: 200})) as unknown as typeof fetch;
      const q = await relayProvider({fetchImpl}).getQuote({sourceChain: f.request.sourceChain, destChain: f.request.destChain, sourceToken: f.request.sourceToken, destToken: f.request.destToken, amountIn: f.request.amount, destAddress: f.request.recipient, refundAddress: f.request.depositor, dry: false});
      if (!q) continue;
      n++;
      expect(q.gasEstimate, name).toBeUndefined();
      expect(q.gasEstimateSource, name).toBeUndefined();
      expect(gasEstimateProblem(q, f.request.sourceChain), name).toBeNull();
      expect(BigInt(q.txRequest!.gasLimit!) >= 2n * BigInt(f.response.steps.find((s) => s.id === "deposit")!.items[0]!.data.gas!) || BigInt(q.txRequest!.gasLimit!) >= 90_000n, name).toBe(true);
    }
    expect(n).toBeGreaterThan(5);
  });

  it("measured: Relay's deposit gas is 1.30–1.32 × the gas the deposit uses, and its origin gas fee is priced on it", () => {
    expect(measured.quotes).toHaveLength(10);
    for (const m of measured.quotes) {
      const ratio = Number(m.depositGas) / m.simulatedGasUsed;
      expect(ratio, m.name).toBeGreaterThan(1.29);
      expect(ratio, m.name).toBeLessThan(1.33);
      // The same figure is eth_estimateGas × 1.3 (Relay's own estimate of the deposit, within a few dozen gas of ours).
      expect(Math.abs(Number(m.depositGas) / 1.3 - m.estimateGas) / m.estimateGas, m.name).toBeLessThan(0.02);
      // Off the OP Stack (whose L1 data fee is added on top), fees.gas = depositGas × maxFeePerGas.
      if (!["op-eth>base-eth", "op-usdc>base-usdc", "base-eth>arb-eth", "base-usdc>arb-usdc"].includes(m.name)) {
        expect(BigInt(m.feesGasAmount), m.name).toBe(BigInt(m.depositGas) * BigInt(m.maxFeePerGas));
      }
    }
    // Two public deposits on Arbitrum (the test wallet's, fixtures/activity): depositNative and depositErc20 of USDC.
    expect(measured.receipts.map((r) => [r.selector, r.gasUsed])).toEqual([["0x49290c1c", 24961], ["0xe8017952", 53916]]);
  });
});
