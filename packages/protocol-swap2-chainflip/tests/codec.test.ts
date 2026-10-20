import {describe, expect, it} from "vitest";
import {readFileSync} from "node:fs";
import {decodeEvmVaultCall, decodeTronNote, destAddressBytes, minOutOf, minPriceX128For, toHex} from "../src/codec.js";
import {CF_CHAINS, CF_VAULTS, cfAsset} from "../src/config.js";

// Live encoder outputs (2026-10-20). Requests: Tron USDT 20 → Arbitrum USDC to 0x1111…, refund TNPee…, min price 0.96;
// Arbitrum USDC 20 → Tron USDT to TNPee…, refund 0x2222…, min 0.7; Ethereum 0.0211 ETH → BTC bc1qar0…, refund 0x2222…
const fx = JSON.parse(readFileSync(new URL("../fixtures/encode-2026-10-20.json", import.meta.url), "utf8")).responses as Record<string, {to: string; calldata: string; note?: string; value: string; sourceTokenAddress?: string}>;
const X128 = 2n ** 128n;

describe("Chainflip codec on live encoder output", () => {
  it("Tron USDT note: ArbUsdc to 0x1111…, refund = the sender, min price 0.96, oracle 100 bps, broker 0 bps", () => {
    const n = decodeTronNote(fx.tron_usdt!.note!);
    expect(n.outputAsset).toBe(cfAsset("eip155:42161", "USDC")!.id);
    expect(n.destTag).toBe(CF_CHAINS["eip155:42161"]!.addrTag);
    expect(toHex(n.destAddress)).toBe("0x" + "11".repeat(20));
    expect(n.params.refundAddress).toBe(toHex(destAddressBytes("tron:728126428", "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL")));
    expect(n.params.retryDurationBlocks).toBe(50);
    expect(Number((n.params.minPriceX128 * 10_000n) / X128) / 10_000).toBeCloseTo(0.96, 3);
    expect(n.params.maxOraclePriceSlippageBps).toBe(100);
    expect(n.params.broker.feeBps).toBe(0);
    expect(n.params).toMatchObject({dca: null, boostFeeBps: 0, affiliates: []});
    expect(fx.tron_usdt!.to).toBe(CF_VAULTS["tron:728126428"]);
  });
  it("Arbitrum USDC → Tron: xSwapToken to the Arbitrum Vault, dstChain 7 (Tron), TRX-hex destination without the 0x41", () => {
    expect(fx.arb_usdc!.to.toLowerCase()).toBe(CF_VAULTS["eip155:42161"]!.toLowerCase());
    const v = decodeEvmVaultCall(fx.arb_usdc!.calldata);
    expect(v).toMatchObject({native: false, dstChain: CF_CHAINS["tron:728126428"]!.id, dstToken: cfAsset("tron:728126428", "USDT")!.id, amount: 20_000_000n});
    expect(v.srcToken!.toLowerCase()).toBe(cfAsset("eip155:42161", "USDC")!.token!.toLowerCase());
    expect(toHex(v.dstAddress)).toBe(toHex(destAddressBytes("tron:728126428", "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL")));
    expect(v.params.refundAddress).toBe("0x" + "22".repeat(20));
  });
  it("Ethereum ETH → BTC: xSwapNative, dstChain 3, the bech32 address as ASCII bytes", () => {
    const v = decodeEvmVaultCall(fx.eth_eth!.calldata);
    expect(v).toMatchObject({native: true, dstChain: CF_CHAINS["bitcoin:mainnet"]!.id, dstToken: cfAsset("bitcoin:mainnet", "native")!.id});
    expect(new TextDecoder().decode(v.dstAddress)).toBe("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
  });
  it("min price round trip guarantees at least the requested output", () => {
    for (const [a, m] of [[20_000_000n, 19_382_000n], [21_100_000_000_000_000n, 60_400n], [1n, 1n]] as const) {
      expect(minOutOf(a, minPriceX128For(a, m))).toBeGreaterThanOrEqual(m);
      expect(minOutOf(a, minPriceX128For(a, m))).toBeLessThanOrEqual(m + 1n);
    }
  });
  it("refuses tampered encodings", () => {
    const note = fx.tron_usdt!.note!;
    expect(() => decodeTronNote(note + "00")).toThrow(/trailing/);
    expect(() => decodeTronNote(note.slice(0, -10))).toThrow(/truncated/);
  });
});
