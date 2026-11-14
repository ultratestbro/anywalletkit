import {describe, expect, it} from "vitest";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {acrossChain} from "../src/config.js";
import {decodeAcrossDeposit} from "../src/deposit.js";
import {acrossProvider} from "../src/provider.js";
import {acrossRemoteProvider} from "../src/remote.js";
import {acrossPins} from "../src/verify.js";

/**
 * Live and read-only: real quotes from Across API V5 and /suggested-fees, nothing signed or sent. Opt-in (ACROSS_LIVE=1
 * and ACROSS_API_KEY — the V5 key) so the unit run never touches the network or needs a key; `pnpm verify:live` covers
 * more corridors and the pins on chain. The key is read from the environment, sent only as the bearer header, never
 * printed.
 */
const live = process.env.ACROSS_LIVE === "1" && !!process.env.ACROSS_API_KEY;
const ZERO = "0x0000000000000000000000000000000000000000";
// A public address, the subject of the quote only.
const ME = "0xF977814e90dA44bFA03b6295A0616a897441aceC";
const CORRIDORS: [string, string, string, string, string, string][] = [
  ["USDC Base → Arbitrum", "eip155:8453", "USDC", "eip155:42161", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "25000000"],
  ["ETH Arbitrum → Base", "eip155:42161", "ETH", "eip155:8453", ZERO, "3000000000000000"],
  ["ETH Ethereum → Base", "eip155:1", "ETH", "eip155:8453", ZERO, "3000000000000000"],
];
const key = () => process.env.ACROSS_API_KEY;

describe.skipIf(!live)("live: Across prices a plain deposit the device verifies", () => {
  for (const [name, sourceChain, sourceToken, destChain, destToken, amountIn] of CORRIDORS) {
    it(name, async () => {
      const reasons: string[] = [];
      const params: QuoteParams = {sourceChain, sourceToken, destChain, destToken, amountIn, destAddress: ME, refundAddress: ME, sender: ME, dry: false, onRefusal: (r) => reasons.push(r)};
      const provider = acrossProvider({apiKey: key});
      const q = await provider.getQuote(params);
      expect(reasons).toEqual([]);
      expect(q).not.toBeNull();
      const args = decodeAcrossDeposit(q!.txRequest!.data!);
      expect(q!.txRequest!.to).toBe(acrossChain(sourceChain)!.spokePool);
      expect(args.message).toBe("0x");
      expect(args.exclusiveRelayer).toBe(ZERO);
      expect(args.fillDeadline - args.quoteTimestamp).toBe(7200);
      const fee = BigInt(amountIn) - args.outputAmount;
      expect(fee).toBe(BigInt(q!.providerData!.v5Fee!) > BigInt(q!.providerData!.relayerFee!) ? BigInt(q!.providerData!.v5Fee!) : BigInt(q!.providerData!.relayerFee!));
      expect(acrossPins.verifyQuote!(params, q!)).toBeNull();
      const tx = await provider.buildDeposit(q!);
      await expect(provider.preflightDeposit!(q!, tx)).resolves.toBeUndefined();
      expect(acrossPins.verifyBuild!(q!, tx, params)).toBeNull();
    }, 60_000);
  }

  it("remote mode: the provider behind createSwap2Handler, re-checked by acrossRemoteProvider", async () => {
    const [, sourceChain, sourceToken, destChain, destToken, amountIn] = CORRIDORS[0]!;
    const handle = createSwap2Handler<string>({providers: [acrossProvider({apiKey: key})], sealSecret: crypto.getRandomValues(new Uint8Array(32)), guard: () => {}, subject: () => "live"});
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "live");
      return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
    const app = acrossRemoteProvider({baseUrl: "https://backend.invalid/api/swap2", fetchImpl});
    const q = await app.getQuote({sourceChain, sourceToken, destChain, destToken, amountIn, destAddress: ME, refundAddress: ME, sender: ME, dry: false});
    expect(q?.intentId).toMatch(/~[0-9a-f]{32}$/);
    const tx = await app.buildDeposit(q!);
    expect(tx.data).toBe(q!.txRequest!.data);
  }, 60_000);
});
