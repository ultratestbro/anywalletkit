// Scan 2026-10-28, F9: a remote stub's deposit-address and plain-value routes skipped every pin. They now need the
// app's opt-in (`depositAddressRoutes`). A Chainflip Tron vault swap IS a send to the Tron Vault with its note, so
// chainflipPins opt in and ship chainflipVerifyQuote, the provider's own decode run on the client: the Tron deposit
// must be the pinned Vault with a note naming the app's destination, refund and minimum, the EVM route a vault call
// on the pinned Vault naming the same. Both corridors keep executing through the real provider behind the swap2
// server handler, remoteProvider + chainflipPins, and the engine (live encoder responses, 2026-10-20).
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {CF_VAULTS, chainflipPins, chainflipVerifyQuote} from "../src/config.js";
import {chainflipProvider} from "../src/provider.js";

const fx = JSON.parse(readFileSync(new URL("../fixtures/encode-2026-10-20.json", import.meta.url), "utf8")).responses as Record<string, Record<string, string>>;
const QUOTE = [{type: "REGULAR", egressAmount: "19483300", depositAmount: "20000000", estimatedDurationSeconds: 166.6, recommendedSlippageTolerancePercent: 0.5, recommendedLivePriceSlippageTolerancePercent: 1, includedFees: []}];
const TRON = "tron:728126428";
const TRON_SELF = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";
const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const EVM_DEST = "0x1111111111111111111111111111111111111111";
const ARB_SELF = "0x2222222222222222222222222222222222222222";
const ATTACKER_TRON = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";
const TRON_PARAMS: QuoteParams = {sourceChain: TRON, sourceToken: "USDT", destChain: "eip155:42161", destToken: ARB_USDC, amountIn: "20000000", destAddress: EVM_DEST, refundAddress: TRON_SELF, minAmountOut: "19199999", dry: false};
const ARB_PARAMS: QuoteParams = {sourceChain: "eip155:42161", sourceToken: "USDC", destChain: TRON, destToken: TRON_USDT, amountIn: "20000000", destAddress: TRON_SELF, refundAddress: ARB_SELF, minAmountOut: "13999999", dry: false};

/** The Chainflip backend answering the quote and the live encoder response. */
function stub(encode: Record<string, string>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/v2/quote")) return new Response(JSON.stringify(QUOTE));
    if (url.includes("/api/encodeVaultSwapData")) return new Response(JSON.stringify(encode));
    return new Response("{}", {status: 404});
  }));
}
afterEach(() => vi.unstubAllGlobals());
const noTx = ({txRequest: _tx, ...q}: Quote): Quote => q;

/** The real provider behind the real swap2 handler, as the app's backend runs it. */
function realBackend(): typeof fetch {
  const handle = createSwap2Handler<string>({providers: [chainflipProvider()], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
  return (async (url: string, init: RequestInit) => {
    const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
    return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
}

function app(fromChain: string, self: string, fetchImpl: typeof fetch, pins: object = chainflipPins) {
  const sent: unknown[] = [], transfers: unknown[] = [];
  const account = {
    getAddress: async () => self, getChainId: async () => 42161, getAllowance: async () => 0n, waitForTransaction: async () => {},
    sendTransaction: async (tx: unknown) => { sent.push(tx); return {hash: `0x${String(sent.length).padStart(64, "0")}`}; },
    transfer: async (t: unknown) => { transfers.push(t); return {hash: `t${transfers.length}`}; },
  };
  const provider: CrossChainProvider = remoteProvider({name: "chainflip", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, ...pins});
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  return {sent, transfers, swap2: new P(account as never, {fromChain, ...(fromChain === TRON ? {skipAccountChainCheck: true} : {})} as never)};
}

describe("scan 2026-10-28 F9: Chainflip remote corridors with chainflipPins", () => {
  it("chainflipVerifyQuote passes the live Tron and Arbitrum quotes and refuses a deposit or call that pays someone else", async () => {
    stub(fx.tron_usdt!);
    const tron = (await chainflipProvider().getQuote(TRON_PARAMS))!;
    expect(chainflipVerifyQuote(TRON_PARAMS, tron)).toBeNull();
    stub(fx.arb_usdc!);
    const arb = (await chainflipProvider().getQuote(ARB_PARAMS))!;
    expect(chainflipVerifyQuote(ARB_PARAMS, arb)).toBeNull();
    const cases: Array<[string, QuoteParams, Quote, RegExp]> = [
      ["Tron deposit to the attacker", TRON_PARAMS, {...tron, depositAddress: ATTACKER_TRON}, /send to the Tron Vault/],
      ["Tron note paying someone else", TRON_PARAMS, {...tron, depositMemo: tron.depositMemo!.replace("1111111111111111111111111111111111111111", "9999999999999999999999999999999999999999")}, /another destination/],
      ["Tron note refunding elsewhere", TRON_PARAMS, {...tron, depositMemo: tron.depositMemo!.replace("8840e6c55b9ada326d211d818c34a994aeced808", "1234567890123456789012345678901234567890")}, /refund address/],
      ["Tron quote with a minimum the note does not guarantee", TRON_PARAMS, {...tron, minDestAmount: "19483300"}, /minimum price/],
      ["Tron route turned into calldata", TRON_PARAMS, {...tron, txRequest: arb.txRequest!}, /send to the Tron Vault/],
      ["EVM route as a deposit address", ARB_PARAMS, {...noTx(arb), depositAddress: EVM_DEST}, /vault call, not a deposit/],
      ["EVM call to another contract", ARB_PARAMS, {...arb, txRequest: {...arb.txRequest!, to: EVM_DEST}}, /not the Vault/],
      ["EVM call approving another spender", ARB_PARAMS, {...arb, txRequest: {...arb.txRequest!, approvalAddress: EVM_DEST}}, /another token or amount/],
      ["EVM call for another request", {...ARB_PARAMS, destAddress: ATTACKER_TRON}, arb, /another destination/],
    ];
    for (const [what, params, q, why] of cases) expect(chainflipVerifyQuote(params, q), what).toMatch(why);
    // A dry quote pays nobody: listing routes is unaffected.
    expect(chainflipVerifyQuote({...TRON_PARAMS, dry: true}, {...tron, depositAddress: "", depositMemo: null})).toBeNull();
  });

  it("corridor Tron USDT → Arbitrum USDC: the TRC-20 transfer to the Tron Vault with the hex note", async () => {
    stub(fx.tron_usdt!);
    const a = app(TRON, TRON_SELF, realBackend());
    await a.swap2.swap2({fromToken: "USDT", toToken: ARB_USDC, toChain: 42161, recipient: EVM_DEST, fromTokenAmount: 20_000_000n, minAmountOut: 19_199_999n} as never);
    expect(a.transfers).toEqual([{token: TRON_USDT, recipient: CF_VAULTS[TRON], amount: 20_000_000n, memo: fx.tron_usdt!.note, memoEncoding: "hex"}]);
  });

  it("corridor Arbitrum USDC → Tron USDT: approve the Vault, then the vault call", async () => {
    stub(fx.arb_usdc!);
    const a = app("eip155:42161", ARB_SELF, realBackend());
    await a.swap2.swap2({fromToken: "USDC", toToken: TRON_USDT, toChain: TRON, recipient: TRON_SELF, fromTokenAmount: 20_000_000n, minAmountOut: 13_999_999n} as never);
    expect(a.sent.map((t) => (t as {to: string}).to.toLowerCase())).toEqual([ARB_USDC.toLowerCase(), CF_VAULTS["eip155:42161"]!.toLowerCase()]);
  });

  it("without the opt-in the Tron route is refused; a backend paying its own Tron address fails the app's check", async () => {
    stub(fx.tron_usdt!);
    const closed = app(TRON, TRON_SELF, realBackend(), {...chainflipPins, depositAddressRoutes: false});
    await expect(closed.swap2.swap2({fromToken: "USDT", toToken: ARB_USDC, toChain: 42161, recipient: EVM_DEST, fromTokenAmount: 20_000_000n, minAmountOut: 19_199_999n} as never)).rejects.toThrow(/did not allow deposit-address routes/);
    const real = realBackend();
    const evil = (async (url: string, init: RequestInit) => {
      const reply = (x: unknown) => new Response(JSON.stringify(x), {status: 200, headers: {"content-type": "application/json"}});
      if (String(url).endsWith("/quote")) return reply({...(await (await real(url, init)).json() as object), depositAddress: ATTACKER_TRON});
      return real(url, init);
    }) as unknown as typeof fetch;
    const open = app(TRON, TRON_SELF, evil);
    await expect(open.swap2.swap2({fromToken: "USDT", toToken: ARB_USDC, toChain: 42161, recipient: EVM_DEST, fromTokenAmount: 20_000_000n, minAmountOut: 19_199_999n} as never)).rejects.toThrow(/fails this app's own check — a Tron vault swap is a send to the Tron Vault/);
    expect([closed.transfers, open.transfers]).toEqual([[], []]);
  });
});
