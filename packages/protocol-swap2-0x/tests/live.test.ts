import {describe, expect, it} from "vitest";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {ZEROEX_CHAINS} from "../src/chains.js";
import {zeroExProvider} from "../src/provider.js";
import {zeroExVerifyBuild, zeroExVerifyQuote} from "../src/remote.js";
import {SETTLER_NATIVE_CHECK_SELECTOR, createSettlerResolver, decodeSettlerExecute, zeroExSettlerNonce} from "../src/settler.js";

/**
 * Live and read-only: real quotes from api.0x.org with your key, nothing signed or sent. Opt-in (ZEROEX_LIVE=1 and
 * ZEROEX_API_KEY) so the unit run never touches the network or needs a key; `pnpm verify:live` covers every chain and
 * the registry on chain. The key is read from the environment, sent only as the 0x-api-key header, never printed.
 */
const live = process.env.ZEROEX_LIVE === "1" && !!process.env.ZEROEX_API_KEY;
const NATIVE = "0x0000000000000000000000000000000000000000";
const ME = "0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA";
const RPC = {8453: ["https://base-rpc.publicnode.com"], 56: ["https://bsc-rpc.publicnode.com"]};
const CORRIDORS: [string, number, string, number | undefined, string, string][] = [
  ["Base USDC → ETH (Permit2 token sale)", 8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6, NATIVE, "25000000"],
  ["Base ETH → USDC (native sale)", 8453, NATIVE, undefined, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "8000000000000000"],
  ["BNB Smart Chain USDT → BNB (Permit2 token sale)", 56, "0x55d398326f99059fF775485246999027B3197955", 18, NATIVE, "25000000000000000000"],
];

describe.skipIf(!live)("live: 0x quotes pass every device check", () => {
  for (const [name, chainId, sourceToken, decimals, destToken, amountIn] of CORRIDORS) {
    it(name, async () => {
      const reasons: string[] = [];
      const params: QuoteParams = {
        sourceChain: `eip155:${chainId}`, destChain: `eip155:${chainId}`, sourceToken, ...(decimals !== undefined ? {sourceDecimals: decimals} : {}),
        destToken, amountIn, slippageBps: 50, destAddress: ME, refundAddress: ME, dry: false, onRefusal: (r) => reasons.push(r),
      };
      const resolver = createSettlerResolver({chains: ZEROEX_CHAINS, rpcUrls: RPC});
      const provider = zeroExProvider({apiKey: () => process.env.ZEROEX_API_KEY, rpcUrls: RPC, settlerResolver: resolver});
      const q = await provider.getQuote(params);
      expect(reasons).toEqual([]);
      expect(q).not.toBeNull();
      const settlers = await resolver.resolve(chainId, {fresh: true});
      expect(zeroExSettlerNonce(chainId, q!.txRequest!.to!)).not.toBeNull();
      const ctx = {chains: ZEROEX_CHAINS, settlers: () => settlers};
      expect(zeroExVerifyQuote(params, q!, ctx)).toBeNull();
      const tx = await provider.buildDeposit(q!);
      expect(await zeroExVerifyBuild(q!, tx, params, {...ctx, resolver})).toBeNull();
      await expect(provider.preflightDeposit!(q!, tx)).resolves.toBeUndefined();
      if (sourceToken === NATIVE) {
        expect(tx.value).toBe(amountIn);
        expect(tx.approvalAddress).toBeUndefined();
        expect(decodeSettlerExecute(tx.data!).actions[0]!.selector).toBe(SETTLER_NATIVE_CHECK_SELECTOR);
      } else {
        expect(tx.permit2Transfer).toBeTypeOf("string");
      }
      // A quote asked for one recipient does not verify as another's.
      expect(zeroExVerifyQuote({...params, destAddress: "0x1111111111111111111111111111111111111111"}, q!, ctx)).toMatch(/not the recipient of this swap/);
    }, 60_000);
  }
});
