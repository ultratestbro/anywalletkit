// Scan 2026-10-27 (modules), F4: the engine now signs a provider's EIP-712 payload only when it is the swap's own
// Limit Order Protocol order (maker = this account, the source token, the exact input, the approved settlement
// contract). The live Omniston orders captured on 2026-10-16 and 2026-10-20 must still be signed as they are — hex
// amounts, lowercase addresses, hex chain ids — and the same orders with another maker must not.
import "../src/buffer-global.js";
import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {omnistonPins, validateEvmTypedOrder} from "../src/provider.js";

type Fixture = {chains: Record<string, {payload?: {typedData?: string}}>};
const load = (file: string) => JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8")) as Fixture;
const orders = [...Object.entries(load("live-evm-ton-2026-10-16.json").chains), ...Object.entries(load("live-evm-evm-2026-10-20.json").chains)]
  .filter(([, c]) => c.payload?.typedData)
  .map(([name, c]) => {
    const typedData = c.payload!.typedData!;
    const td = JSON.parse(typedData) as {domain: {chainId: string; verifyingContract: string}; message: {maker: string; makerAsset: string; makingAmount: string}};
    return {name, typedData, chain: `eip155:${Number(td.domain.chainId)}`, lop: td.domain.verifyingContract, maker: td.message.maker, token: td.message.makerAsset, amount: BigInt(td.message.makingAmount)};
  });
const ATTACKER = "0x9999999999999999999999999999999999999999";

/** The engine over a provider that answers the live order as its build, for an account `address`. */
function run(o: (typeof orders)[number], address: string, typedData = o.typedData) {
  const signed: unknown[] = [], sent: unknown[] = [], registered: string[] = [];
  const provider: CrossChainProvider = {
    name: "omniston", enabled: () => true, supportsRoute: () => true, supportsSameChain: true, trackIntent: async () => ({state: "pending"}),
    getQuote: async (params: QuoteParams) => ({
      provider: "omniston", intentId: `omniston:${o.name}`, depositAddress: "", depositMemo: null, sourceAmount: params.amountIn, destAmount: "1000", minDestAmount: "990",
      feeUsd: 0, etaSeconds: 60, reliability: 1, validUntilMs: Date.now() + 60_000,
    }) as Quote,
    buildDeposit: async () => ({chain: o.chain, to: o.lop, value: "0", chainId: Number(o.chain.slice(7)), approvalAddress: o.lop, typedData}),
    registerSignedOrder: async (_id, sig) => { registered.push(sig); },
  };
  const account = {
    getAddress: async () => address, getChainId: async () => Number(o.chain.slice(7)), getAllowance: async () => 0n, waitForTransaction: async () => {},
    sendTransaction: async (tx: unknown) => { sent.push(tx); return {hash: `0x${sent.length}`}; },
    signTypedData: async (td: unknown) => { signed.push(td); return "0x" + "11".repeat(65); },
  };
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  const p = new P(account as never, {fromChain: o.chain, allowUnlistedTokens: true} as never);
  const swap = () => p.swap2({fromToken: o.token, fromTokenDecimals: 6, toToken: o.token, toChain: o.chain, recipient: address, fromTokenAmount: o.amount, minAmountOut: 990n});
  return {signed, sent, registered, swap};
}

describe("live Omniston orders through the engine's typed-order gate (scan 2026-10-27 modules, F4)", () => {
  it(`all ${orders.length} live orders are approved for the input, signed and registered`, async () => {
    expect(orders.length).toBeGreaterThanOrEqual(8);
    for (const o of orders) {
      const r = run(o, o.maker);
      await r.swap();
      expect(r.signed, o.name).toHaveLength(1);
      expect(r.registered, o.name).toHaveLength(1);
      expect((r.signed[0] as {domain: {chainId: unknown}}).domain.chainId, o.name).toBe(Number(o.chain.slice(7)));
    }
  });

  it("the same orders are refused for any other account, and when the backend swaps the maker", async () => {
    for (const o of orders) {
      const other = run(o, ATTACKER);
      await expect(other.swap(), o.name).rejects.toThrow(/typed order refused — the maker is not this account/);
      expect([other.signed, other.sent], o.name).toEqual([[], []]);
      const td = JSON.parse(o.typedData) as {message: Record<string, unknown>};
      td.message.maker = ATTACKER;
      const swapped = run(o, o.maker, JSON.stringify(td));
      await expect(swapped.swap(), o.name).rejects.toThrow(/the maker is not this account/);
      expect([swapped.signed, swapped.sent], o.name).toEqual([[], []]);
    }
  });

  it("omnistonPins: the app's audited order protocols are the only spenders a remote order may name", () => {
    const pins = omnistonPins({"eip155:8453": ["0xe7405facdedb2512e91f2886bdff13231343af5e"], "eip155:1": ["0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9"]});
    expect(pins.spenders("eip155:8453")).toEqual(["0xe7405fAcDEDB2512e91F2886BDff13231343aF5E"]);
    expect(pins.spenders("eip155:137")).toEqual([]);
    expect(pins.callTargets("eip155:8453")).toEqual([]);
    expect(() => omnistonPins({"eip155:1": ["not an address"]})).toThrow();
    expect(typeof validateEvmTypedOrder).toBe("function");
  });
});
