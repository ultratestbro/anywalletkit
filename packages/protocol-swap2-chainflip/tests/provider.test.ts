import {afterEach, describe, expect, it, vi} from "vitest";
import {readFileSync} from "node:fs";
import {chainflipProvider} from "../src/provider.js";
import {CF_VAULTS} from "../src/config.js";
import {validQuote} from "@anywalletkit/protocol-swap2-core";

const fx = JSON.parse(readFileSync(new URL("../fixtures/encode-2026-10-20.json", import.meta.url), "utf8")).responses as Record<string, Record<string, string>>;
const QUOTE = [{type: "REGULAR", egressAmount: "19483300", depositAmount: "20000000", estimatedDurationSeconds: 166.6, recommendedSlippageTolerancePercent: 0.5, recommendedLivePriceSlippageTolerancePercent: 1, includedFees: [{type: "NETWORK", chain: "Ethereum", asset: "USDC", amount: "500000"}, {type: "EGRESS", chain: "Arbitrum", asset: "USDC", amount: "4881"}]}];
const TRON_PARAMS = {sourceChain: "tron:728126428", sourceToken: "USDT", destChain: "eip155:42161", destToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", amountIn: "20000000", destAddress: "0x1111111111111111111111111111111111111111", refundAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL", minAmountOut: "19199999", dry: false};

function stub(encode: Record<string, string>, swaps: (id: string) => Response = () => new Response("{}", {status: 404})) {
  const seen: {url: string; body?: unknown}[] = []
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    seen.push({url, ...(init?.body ? {body: JSON.parse(String(init.body))} : {})})
    if (url.includes("/v2/quote")) return new Response(JSON.stringify(QUOTE));
    if (url.includes("/api/encodeVaultSwapData")) return new Response(JSON.stringify(encode));
    if (url.includes("/v2/swaps/")) return swaps(url.split("/v2/swaps/")[1]!);
    return new Response("{}", {status: 404});
  }));
  return seen
}
afterEach(() => vi.unstubAllGlobals());

describe("chainflip provider — Tron USDT vault swap", () => {
  it("live quote: the Vault + the decoded note, a hex memo; the request carries fill-or-kill with our minimum and the sender as refund", async () => {
    const seen = stub(fx.tron_usdt!);
    const p = chainflipProvider();
    const q = await p.getQuote(TRON_PARAMS);
    expect(q).toMatchObject({provider: "chainflip", depositAddress: CF_VAULTS["tron:728126428"], depositMemo: fx.tron_usdt!.note, destAmount: "19483300"});
    expect(BigInt(q!.minDestAmount)).toBeGreaterThanOrEqual(19_199_999n);
    const enc = seen.find((s) => s.url.includes("encode"))!.body as {fillOrKillParams: {refundAddress: string; minPriceX128: string; retryDurationBlocks: number; maxOraclePriceSlippage: number}; commissionBps: number};
    expect(enc.fillOrKillParams).toMatchObject({refundAddress: TRON_PARAMS.refundAddress, retryDurationBlocks: 50, maxOraclePriceSlippage: 100});
    expect(enc.commissionBps).toBe(0);
    expect(await p.buildDeposit(q!)).toEqual({chain: "", to: CF_VAULTS["tron:728126428"], value: "20000000", memo: fx.tron_usdt!.note, memoEncoding: "hex"});
  });
  const tamper = (f: (n: string) => string) => ({...fx.tron_usdt!, note: f(fx.tron_usdt!.note!)});
  const refusedBy = async (encode: Record<string, string>, params = TRON_PARAMS) => {
    stub(encode);
    const reasons: string[] = [];
    const q = await chainflipProvider().getQuote({...params, onRefusal: (r) => reasons.push(r)});
    return {q, reason: reasons.join(" ")};
  };
  it("refuses an encoding that pays someone else, refunds elsewhere, lowers the minimum, takes a broker fee or targets another vault", async () => {
    const r1 = await refusedBy(tamper((n) => n.replace("1111111111111111111111111111111111111111", "9999999999999999999999999999999999999999")));
    expect(r1.q).toBeNull(); expect(r1.reason).toMatch(/destination/);
    const r2 = await refusedBy(tamper((n) => n.replace("8840e6c55b9ada326d211d818c34a994aeced808", "1234567890123456789012345678901234567890")));
    expect(r2.q).toBeNull(); expect(r2.reason).toMatch(/refund/);
    const r3 = await refusedBy(tamper((n) => n.replace("f5285c8fc2f5285c8fc2f5285c8fc2f5", "00000000000000000000000000000000")));
    expect(r3.q).toBeNull(); expect(r3.reason).toMatch(/minimum price/);
    const r4 = await refusedBy(tamper((n) => n.replace(/0000(00)$/, "6400$1")));
    expect(r4.q).toBeNull(); expect(r4.reason).toMatch(/broker takes/);
    const r5 = await refusedBy({...fx.tron_usdt!, to: "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9"});
    expect(r5.q).toBeNull(); expect(r5.reason).toMatch(/not the Tron Vault/);
  });
  it("a floor AND a slippage: the minimum honours both (execution sends a floor under the listed quote plus the list's slippage)", async () => {
    stub(fx.tron_usdt!);
    const both = await chainflipProvider().getQuote({...TRON_PARAMS, dry: true, slippageBps: 10});
    expect(BigInt(both!.minDestAmount)).toBeGreaterThanOrEqual((19_483_300n * 9_990n) / 10_000n);
    expect(validQuote(both!, {...TRON_PARAMS, dry: true, slippageBps: 10}, "chainflip")).toBe(true);
    // The floor alone stays the floor; a floor above the slippage minimum wins.
    const floorOnly = await chainflipProvider().getQuote({...TRON_PARAMS, dry: true});
    expect(BigInt(floorOnly!.minDestAmount)).toBeLessThan(19_300_000n);
    const highFloor = await chainflipProvider().getQuote({...TRON_PARAMS, dry: true, slippageBps: 300, minAmountOut: "19400000"});
    expect(BigInt(highFloor!.minDestAmount)).toBeGreaterThanOrEqual(19_400_000n);
  });
  it("dry quotes never encode; below-minimum amounts are refused up front", async () => {
    const seen = stub(fx.tron_usdt!);
    const q = await chainflipProvider().getQuote({...TRON_PARAMS, dry: true});
    expect(q?.depositAddress).toBe("");
    expect(seen.some((s) => s.url.includes("encode"))).toBe(false);
    expect((await refusedBy(fx.tron_usdt!, {...TRON_PARAMS, amountIn: "9000000"})).reason).toMatch(/minimum deposit/);
  });
});

describe("chainflip provider — Arbitrum USDC vault call", () => {
  it("decodes xSwapToken and asks for an approval to the Vault", async () => {
    stub(fx.arb_usdc!);
    const q = await chainflipProvider().getQuote({sourceChain: "eip155:42161", sourceToken: "USDC", destChain: "tron:728126428", destToken: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", amountIn: "20000000", destAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL", refundAddress: "0x2222222222222222222222222222222222222222", minAmountOut: "13999999", dry: false});
    expect(q?.txRequest).toMatchObject({to: CF_VAULTS["eip155:42161"], value: "0", chainId: 42161, approvalAddress: CF_VAULTS["eip155:42161"]});
  });
});

describe("chainflip status", () => {
  it("tracks a vault swap by its source tx: 404 pending, SWAPPING received, COMPLETED with the egress tx, FAILED with a refund", async () => {
    const answers: Record<string, unknown> = {aa: {state: "SWAPPING"}, bb: {state: "COMPLETED", swapEgress: {txRef: "0xdest"}}, cc: {state: "FAILED", refundEgress: {txRef: "r"}}};
    stub({}, (id) => (answers[id] ? new Response(JSON.stringify(answers[id])) : new Response("{}", {status: 404})));
    const p = chainflipProvider();
    const t = (h: string) => p.trackIntent({intentId: "cfvault:tron:728126428", sourceTxHash: h});
    expect(await t("zz")).toEqual({state: "pending"});
    expect(await t("aa")).toEqual({state: "pending", depositReceived: true});
    expect(await t("bb")).toEqual({state: "completed", depositReceived: true, destTxHash: "0xdest"});
    expect(await t("cc")).toEqual({state: "refunded", depositReceived: true});
  });
});
