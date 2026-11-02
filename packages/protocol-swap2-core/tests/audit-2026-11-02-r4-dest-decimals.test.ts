// The decimals a bridge leg's reviewed minimum is held in (`bridgeOut.destDecimals`) are the catalog's, else the caller's
// verified `toTokenDecimals`. A quote's `destDecimals` is the provider's word: alone it fills nothing, and one that
// disagrees with the caller's is refused before anything is signed.
import {describe, expect, it} from "vitest";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {CrossChainProvider} from "../src/types.js";

const WIRE = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const SENDER = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const UNLISTED = `0x${"ab".repeat(20)}`;
const ETH_USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";

async function bridge(toToken: string, quoted: number | undefined, toTokenDecimals?: number) {
  const provider: CrossChainProvider = {
    name: "serial", enabled: () => true, supportsRoute: () => true,
    getQuote: async (params) => ({
      provider: "serial", intentId: "serial:intent", depositAddress: "", depositMemo: null, txRequest: {serializedTx: WIRE, value: "0"},
      sourceAmount: params.amountIn, destAmount: "990000", minDestAmount: "980000", ...(quoted !== undefined ? {destDecimals: quoted} : {}),
      feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
    }),
    buildDeposit: async (quote) => ({chain: "solana:mainnet", to: "", value: "0", serializedTx: quote.txRequest!.serializedTx!}),
    trackIntent: async () => ({state: "pending"}),
  };
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  const seen: Array<{bridgeOut?: Record<string, unknown>}> = [];
  const account = {
    getAddress: async () => SENDER, getChainId: async () => "solana:mainnet",
    sendTransaction: async () => { throw new Error("unused"); }, transfer: async () => { throw new Error("unused"); },
    sendSerializedTransaction: async (_tx: string, e: {bridgeOut?: Record<string, unknown>}) => { seen.push(e); return {hash: "serial-sig"}; },
  };
  const run = new P(account, {fromChain: "solana:mainnet"}).swap2({
    fromToken: "USDT", toToken, toChain: 1, recipient: RECIPIENT, fromTokenAmount: 1_000_000n, minAmountOut: 980_000n,
    ...(toTokenDecimals !== undefined ? {toTokenDecimals} : {}),
  });
  return {run, seen};
}

describe("audit 2026-11-02 r4: bridgeOut decimals never come from the quote alone", () => {
  it("an unlisted destination with only the quote's decimals (inflated or not) reaches the account without them", async () => {
    for (const quoted of [36, 18]) {
      const {run, seen} = await bridge(UNLISTED, quoted);
      await run;
      expect(seen[0]!.bridgeOut).toMatchObject({destToken: UNLISTED, minAmountOut: "980000"});
      expect(seen[0]!.bridgeOut).not.toHaveProperty("destDecimals");
    }
  });

  it("the caller's toTokenDecimals fill them, agreeing with the quote's or with none quoted", async () => {
    for (const quoted of [18, undefined]) {
      const {run, seen} = await bridge(UNLISTED, quoted, 18);
      await run;
      expect(seen[0]!.bridgeOut).toMatchObject({destToken: UNLISTED, minAmountOut: "980000", destDecimals: 18});
    }
  });

  it("a quote that disagrees with toTokenDecimals is refused before signing; malformed toTokenDecimals are refused", async () => {
    const mismatch = await bridge(UNLISTED, 36, 18);
    await expect(mismatch.run).rejects.toThrow(/destDecimals 36 do not match toTokenDecimals 18/);
    expect(mismatch.seen).toHaveLength(0);
    for (const bad of [6.5, -1, 37]) {
      const r = await bridge(UNLISTED, undefined, bad);
      await expect(r.run).rejects.toThrow(/toTokenDecimals must be whole decimals in 0\.\.36/);
      expect(r.seen).toHaveLength(0);
    }
  });

  it("control: a catalog-listed destination keeps the catalog's decimals whatever the quote or caller says", async () => {
    for (const [quoted, given] of [[36, undefined], [undefined, 18], [18, 18]] as const) {
      const {run, seen} = await bridge(ETH_USDT, quoted, given);
      await run;
      expect(seen[0]!.bridgeOut).toMatchObject({destToken: ETH_USDT, destDecimals: 6});
    }
  });
});
