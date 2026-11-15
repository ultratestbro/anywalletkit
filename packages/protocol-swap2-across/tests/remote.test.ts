// acrossRemoteProvider: the app's side when the V5 key stays on a backend. What a backend can and cannot get signed.
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {acrossQuoteOf} from "../src/build.js";
import {decodeAcrossDeposit, encodeAcrossDeposit, type AcrossDepositArgs} from "../src/deposit.js";
import {acrossRemoteProvider} from "../src/remote.js";
import {acrossRouteOf, type AcrossRoute} from "../src/config.js";
import {acrossIntentId, acrossQuoteFeesOf} from "../src/verify.js";
import {ARB_USDC, BASE_USDC, NOW_MS, NOW_S, USER, recordedIntentId, rpcFrom, statusFixture, usdcQuote, usdcRequest} from "./fixtures.js";

beforeEach(() => { vi.useFakeTimers({toFake: ["Date"], now: NOW_MS}); });
afterEach(() => { vi.useRealTimers(); });

const BASE_URL = "https://backend.example/api/swap2";
const TAG = "~0123456789abcdef0123456789abcdef";
const params = (over: Partial<QuoteParams> = {}): QuoteParams => ({
  sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: ARB_USDC, amountIn: "25000000",
  destAddress: USER, refundAddress: USER, sender: USER, dry: false, ...over,
});

/**
 * A backend that answers `quote` with whatever the test hands it, and records every call. Across's relayer fee quote
 * (read by the app itself) does not answer here: the routes below are ones the pinned floor covers, so the per-asset
 * floor stands in (review-2026-11-15-pricing.test.ts holds quotes to a live answer).
 */
function backend(answer: (body: {provider: string; params?: QuoteParams}) => unknown, calls: string[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    if (String(url).startsWith("https://app.across.to/")) throw new TypeError("offline");
    const action = String(url).slice(BASE_URL.length + 1);
    calls.push(action);
    return new Response(JSON.stringify(answer(JSON.parse(String(init.body)))), {status: 200, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
}

/** The honest quote for {@link params}, as a backend would send it (with its intent tag). */
function honest(): Quote {
  const q = acrossQuoteOf(usdcRequest({minAmountOut: undefined}), usdcQuote({exclusiveRelayer: "0x0000000000000000000000000000000000000000", exclusivityParameter: 0}));
  return {...q, intentId: `${q.intentId}${TAG}`};
}

/** The honest quote with its deposit re-encoded with other arguments (and an id, amounts and fees that name the new deposit). */
function withArgs(edit: Partial<AcrossDepositArgs>): Quote {
  const q = honest();
  const args = {...decodeAcrossDeposit(q.txRequest!.data!), ...edit};
  const data = encodeAcrossDeposit(args);
  const route = acrossRouteOf("eip155:8453", BASE_USDC, "eip155:42161", ARB_USDC) as AcrossRoute;
  return {
    ...q, txRequest: {...q.txRequest!, data}, intentId: `${acrossIntentId(8453, 42161, data)}${TAG}`, destAmount: args.outputAmount.toString(), minDestAmount: args.outputAmount.toString(),
    ...acrossQuoteFeesOf(route, args.inputAmount - args.outputAmount),
  };
}

describe("a backend's quote, checked on the device", () => {
  it("the honest quote passes; its id carries the server's tag", async () => {
    const app = acrossRemoteProvider({baseUrl: BASE_URL, fetchImpl: backend(() => honest())});
    const q = await app.getQuote(params());
    expect(q?.intentId.endsWith(TAG)).toBe(true);
  });

  it("a deposit that leaves relayers less than they take is refused (the per-asset floor), however the backend prices it", async () => {
    for (const fee of [1n, 2_499n]) {
      const app = acrossRemoteProvider({baseUrl: BASE_URL, fetchImpl: backend(() => withArgs({outputAmount: 25_000_000n - fee}))});
      const err = await app.getQuote(params()).catch((e: unknown) => e);
      expect(String((err as Error).message)).toMatch(/under the 100-per-million floor for USDC from Base/);
      expect(refusalOf(err)?.reason).toBe("price_check_failed");
    }
    // 1.0 bp is accepted.
    const app = acrossRemoteProvider({baseUrl: BASE_URL, fetchImpl: backend(() => withArgs({outputAmount: 25_000_000n - 2_500n}))});
    expect(await app.getQuote(params())).not.toBeNull();
  });

  it("the app's fee cap, not the server's", async () => {
    const app = acrossRemoteProvider({baseUrl: BASE_URL, maxFeeBps: 3, fetchImpl: backend(() => honest())});
    const err = await app.getQuote(params()).catch((e: unknown) => e);
    expect(String((err as Error).message)).toMatch(/over the 3 bps cap/);
  });

  it("another depositor, recipient, a message, exclusivity, a stretched deadline: refused", async () => {
    const OTHER = "0x1111111111111111111111111111111111111111";
    const cases: [Partial<AcrossDepositArgs>, RegExp][] = [
      [{depositor: OTHER}, /tx-depositor/],
      [{recipient: OTHER}, /tx-recipient/],
      [{message: "0x01"}, /tx-message/],
      [{exclusiveRelayer: OTHER, exclusivityParameter: 3600}, /tx-exclusivity/],
      [{fillDeadline: NOW_S + 20_000}, /tx-fill-deadline/],
    ];
    for (const [edit, code] of cases) {
      const app = acrossRemoteProvider({baseUrl: BASE_URL, fetchImpl: backend(() => withArgs(edit))});
      await expect(app.getQuote(params())).rejects.toThrow(code);
    }
  });

  it("V5's own funding (approve + store on its escrow) is never what is signed: another target is refused", async () => {
    const q = honest();
    const store = {...q, txRequest: {...q.txRequest!, to: "0x794dbdbdbfd3f8a3b887f4513bf5ff29edd04a94", data: `0x1e04ce08${"00".repeat(96)}`, approvalAddress: "0x794dbdbdbfd3f8a3b887f4513bf5ff29edd04a94"}};
    const app = acrossRemoteProvider({baseUrl: BASE_URL, fetchImpl: backend(() => store)});
    const err = await app.getQuote(params()).catch((e: unknown) => e);
    expect(String((err as Error).message)).toMatch(/tx-target/);
    expect(refusalOf(err)?.reason).toBe("vault_mismatch");
  });

  it("a backend's refusal arrives with its reason", async () => {
    const app = acrossRemoteProvider({baseUrl: BASE_URL, fetchImpl: backend(() => ({noQuote: "across: Across API V5 answered HTTP 400 policy.amount_out_of_range [api-error]", reason: "amount_too_small"}))});
    const err = await app.getQuote(params()).catch((e: unknown) => e);
    expect(refusalOf(err)?.reason).toBe("amount_too_small");
  });

  it("a request to Ethereum is not sent at all (not priced)", async () => {
    const calls: string[] = [];
    const app = acrossRemoteProvider({baseUrl: BASE_URL, fetchImpl: backend(() => honest(), calls)});
    expect(app.supportsRoute({chain: "eip155:8453", token: "USDC"}, {chain: "eip155:1", token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"})).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("status", () => {
  const f = statusFixture("base-arb-weth-depositv3");
  const id = `${recordedIntentId(f)}${TAG}`;

  it("with the app's own RPCs for both chains it is read on the device, not asked of the backend", async () => {
    const calls: string[] = [];
    const rpc = rpcFrom(f, 1);
    const fetchImpl = (async (url: string, init: RequestInit) => (String(url).startsWith(BASE_URL) ? backend(() => ({state: "failed"}), calls)(url, init) : rpc(url, init))) as unknown as typeof fetch;
    const app = acrossRemoteProvider({baseUrl: BASE_URL, fetchImpl, rpcUrls: {"eip155:8453": "https://base.rpc.test", "eip155:42161": "https://arb.rpc.test"}});
    expect(await app.trackIntent({intentId: id, sourceTxHash: f.source.txHash})).toMatchObject({state: "completed"});
    expect(calls).toEqual([]);
  });

  it("without them it asks the backend", async () => {
    const calls: string[] = [];
    const app = acrossRemoteProvider({baseUrl: BASE_URL, fetchImpl: backend(() => ({state: "pending"}), calls), rpcUrls: {"eip155:8453": "https://base.rpc.test"}});
    expect(await app.trackIntent({intentId: id, sourceTxHash: f.source.txHash})).toEqual({state: "pending"});
    expect(calls).toEqual(["track"]);
  });
});
