import {describe, expect, it} from "vitest";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router";
import {RELAY_DEPOSIT_ERC20, RELAY_DEPOSIT_NATIVE, relayChain} from "../src/config.js";
import {relayProvider} from "../src/provider.js";
import {relayVerifyQuote} from "../src/verify.js";

/**
 * Live and read-only: real quotes from Relay's API, no key, nothing signed or sent. Opt-in (RELAY_LIVE=1) so the unit
 * run never touches the network; `pnpm verify:live` covers more corridors and re-reads every pin. RELAY_API_KEY is
 * sent when set — only needed if Relay ever stops answering keyless quotes.
 */
const live = process.env.RELAY_LIVE === "1";
const config = process.env.RELAY_API_KEY ? {apiKey: process.env.RELAY_API_KEY} : {};
const NATIVE = "0x0000000000000000000000000000000000000000";
const ME = "0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA";
const CORRIDORS: [string, number, string, number, string, string][] = [
  ["Arbitrum USDC → Elysium HYPE", 42161, "0xaf88d065e77c8cc2239327c5edb3a432268e5831", 99901, NATIVE, "25000000"],
  ["Base ETH → Arbitrum ETH", 8453, NATIVE, 42161, NATIVE, "5000000000000000"],
  ["Arbitrum USDC → Base USDC", 42161, "0xaf88d065e77c8cc2239327c5edb3a432268e5831", 8453, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "25000000"],
  ["Linea ETH → Base ETH (second depository)", 59144, NATIVE, 8453, NATIVE, "5000000000000000"],
];

describe.skipIf(!live)("live: Relay quotes pass the verifier", () => {
  for (const [name, from, sourceToken, to, destToken, amountIn] of CORRIDORS) {
    it(`${name}: through the provider and through the router`, async () => {
      const reasons: string[] = [];
      const params: QuoteParams = {sourceChain: `eip155:${from}`, sourceToken, destChain: `eip155:${to}`, destToken, amountIn, destAddress: ME, refundAddress: ME, dry: false, onRefusal: (r) => reasons.push(r)};
      const provider = relayProvider(config);
      const q = await provider.getQuote(params);
      expect(reasons).toEqual([]);
      expect(q).not.toBeNull();
      expect(relayVerifyQuote(params, q!)).toBeNull();
      expect(BigInt(q!.minDestAmount)).toBeGreaterThan(0n);
      expect(BigInt(q!.minDestAmount)).toBeLessThanOrEqual(BigInt(q!.destAmount));
      const tx = await provider.buildDeposit(q!);
      const depository = relayChain(`eip155:${from}`)!.depository;
      expect(tx.to).toBe(depository);
      expect(tx.data!.slice(0, 10)).toBe(sourceToken === NATIVE ? RELAY_DEPOSIT_NATIVE : RELAY_DEPOSIT_ERC20);
      expect(tx.value).toBe(sourceToken === NATIVE ? amountIn : "0");
      expect(tx.approvalAddress).toBe(sourceToken === NATIVE ? undefined : depository);
      await expect(provider.preflightDeposit!(q!, tx)).resolves.toBeUndefined();
      // The same order is not funded twice.
      await expect(provider.preflightDeposit!(q!, tx)).rejects.toThrow(/order-reused/);

      const router = new CrossChainRouter([relayProvider(config)]);
      const best = await router.getBestQuote(params);
      expect(best?.provider).toBe("relay");
      expect(relayVerifyQuote(params, best!)).toBeNull();
      const via = router.getProvider("relay")!;
      await expect(via.preflightDeposit!(best!, await via.buildDeposit(best!))).resolves.toBeUndefined();
      // A quote asked for one recipient does not verify as another's.
      expect(relayVerifyQuote({...params, destAddress: "0x1111111111111111111111111111111111111111"}, best!)).toMatch(/output-recipient/);
    }, 60_000);
  }
});
