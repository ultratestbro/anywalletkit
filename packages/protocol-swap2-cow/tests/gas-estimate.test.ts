// Quote.gasEstimate on CoW quotes: a signed order is gasless and carries exactly "0" (a solver sends and pays the
// settlement; an approval, when one is needed, is the router's to price, as before); an eth-flow order is the user's own
// createOrder transaction and carries the gas that call uses, measured (fixtures/gas/eth-flow-create-order.json).
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it, vi} from "vitest";
import {gasEstimateProblem, quoteRejection} from "@anywalletkit/protocol-swap2-core/validate";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {ETH_FLOW_CREATE_GAS, ETH_FLOW_CREATE_GAS_USED} from "../src/ethflow.js";
import {D1, RPC, ethToUsdc, setup, usdcToWeth} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

interface Measured {
  receipts: {chainId: number; hash: string; status: string; gasUsed: string; gasUsedForL1?: string; l2Gas?: string}[];
  simulated: {chainId: number; status: string; gasUsed: string}[];
}
const measured = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/gas/eth-flow-create-order.json", import.meta.url)), "utf8")) as Measured;

const valid = (q: Parameters<typeof gasEstimateProblem>[0] & Parameters<typeof quoteRejection>[0], params: Record<string, unknown>) => {
  expect(gasEstimateProblem(q, params.sourceChain as string)).toBeNull();
  expect(quoteRejection(q, params as unknown as QuoteParams, "cow")).toBeNull();
};

describe("cow gasEstimate", () => {
  it("a token sale (an order a solver settles) is gasless: \"0\" from the model, the approval still named for the router", async () => {
    for (const dry of [true, false]) {
      const {quote} = setup({}, {permit: false});
      const params = usdcToWeth({dry});
      const q = (await quote(params))!;
      expect(q.gasless).toBe(true);
      expect([q.gasEstimate, q.gasEstimateSource]).toEqual(["0", "model"]);
      expect(q.txRequest).toBeUndefined();
      expect(q.providerData?.approvalAddress).toBe(D1.vaultRelayer);
      valid(q, params);
    }
  });

  it("a token sale with a permit (no approval transaction either) is gasless the same way", async () => {
    const {quote} = setup({}, {rpcUrls: RPC});
    const params = usdcToWeth({dry: false});
    const q = (await quote(params))!;
    expect(q.providerData?.permit).toBe("offered");
    expect([q.gasless, q.gasEstimate, q.gasEstimateSource]).toEqual([true, "0", "model"]);
    valid(q, params);
  });

  it("an eth-flow sale is the user's createOrder: the measured gas it uses, within the limit it carries", async () => {
    for (const dry of [true, false]) {
      const {quote} = setup({}, {permit: false});
      const params = ethToUsdc({dry});
      const q = (await quote(params))!;
      expect(q.gasless).toBeUndefined();
      expect([q.gasEstimate, q.gasEstimateSource]).toEqual([ETH_FLOW_CREATE_GAS_USED.toString(), "model"]);
      expect(q.txRequest!.gasLimit).toBe(ETH_FLOW_CREATE_GAS.toString());
      expect(BigInt(q.gasEstimate!) <= BigInt(q.txRequest!.gasLimit!)).toBe(true);
      valid(q, params);
    }
  });

  it("the eth-flow figure is the median of the measurements, which all sit within 48 gas of each other", () => {
    expect(measured.receipts.map((r) => r.status)).toEqual(["0x1", "0x1"]);
    expect(measured.simulated.every((s) => s.status === "0x1")).toBe(true);
    // L2 execution gas: an Arbitrum receipt's gasUsed includes its L1 data component, which the router leaves out
    const l2 = [...measured.receipts.map((r) => BigInt(r.l2Gas ?? r.gasUsed)), ...measured.simulated.map((s) => BigInt(s.gasUsed))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(l2).toHaveLength(11);
    expect(ETH_FLOW_CREATE_GAS_USED).toBe(l2[5]);
    expect([l2[0], l2.at(-1)]).toEqual([56_216n, 56_264n]);
    expect(measured.receipts.find((r) => r.chainId === 42161)).toMatchObject({gasUsed: "56692", gasUsedForL1: "428", l2Gas: "56264"});
  });
});
