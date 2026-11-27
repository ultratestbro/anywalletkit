/**
 * Quote.gasEstimate on the real 0x answers (fixtures/quotes, both pin eras): 0x's own gas figure for the call —
 * `transaction.gas` on a live quote, `gas` on an indicative price — set on every quote that states one, from the venue,
 * within the gas limit the module pads from that same figure, and carried through the swap2 server and the device's
 * remote provider unchanged.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {gasEstimateProblem, quoteRejection} from "@anywalletkit/protocol-swap2-core/validate";
import {zeroExGasEstimate, zeroExProvider} from "../src/provider.js";
import {zeroExRemoteProvider} from "../src/remote.js";
import {getKey} from "./fixtures.js";
import {RECORDED, bodyOf, chainsConfigOf, loadRecorded, paramsOf, recordedFetch, rpcOf, type RecordedQuote} from "./recorded.js";

beforeEach(() => { vi.useFakeTimers({toFake: ["Date"]}); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function quoted(f: RecordedQuote, body?: unknown) {
  vi.setSystemTime(f.request.nowMs);
  vi.stubGlobal("fetch", recordedFetch(f, body === undefined ? {} : {body}));
  const refusals: string[] = [];
  const provider = zeroExProvider({apiKey: getKey, rpcUrls: rpcOf(f), chains: chainsConfigOf(f), ...(f.request.excludedSources ? {excludedSources: f.request.excludedSources} : {})});
  const params = paramsOf(f, {onRefusal: (text) => refusals.push(text)});
  return {quote: await provider.getQuote(params), params, refusals};
}

const ACCEPTED = RECORDED.map(loadRecorded).filter((f) => !f.refusal);

describe("0x gasEstimate on the recordings", () => {
  it("covers live token sales, live native sales and indicative prices", () => {
    expect(ACCEPTED.filter((f) => !f.request.dry).length).toBeGreaterThanOrEqual(30);
    expect(ACCEPTED.filter((f) => f.request.dry).length).toBeGreaterThanOrEqual(15);
  });

  for (const f of ACCEPTED) {
    it(`${f.name}: 0x's gas figure, from the venue${f.request.dry ? "" : ", within the gas limit"}`, async () => {
      const {quote, params, refusals} = await quoted(f);
      expect(refusals).toEqual([]);
      const stated = (f.request.dry ? f.response.gas : f.response.transaction.gas) as string;
      expect(stated).toMatch(/^[1-9][0-9]*$/);
      expect([quote!.gasEstimate, quote!.gasEstimateSource]).toEqual([stated, "venue"]);
      expect(gasEstimateProblem(quote!, params.sourceChain)).toBeNull();
      expect(quoteRejection(quote!, params, "zeroex")).toBeNull();
      if (f.request.dry) expect(quote!.txRequest).toBeUndefined();
      else {
        // the limit is still 0x's figure × 1.2 + 20 000, and the estimate is at most that
        expect(quote!.txRequest!.gasLimit).toBe(((BigInt(stated) * 12n) / 10n + 20_000n).toString());
        expect(BigInt(quote!.gasEstimate!) <= BigInt(quote!.txRequest!.gasLimit!)).toBe(true);
      }
    });
  }

  it("Monad's largest recorded sale keeps its estimate, under the chain's own 15M cap as before", async () => {
    const {quote} = await quoted(loadRecorded("monad-mon-ausd-1m.2026-11-25"));
    expect(quote!.gasEstimate).toBe("6140730");
    expect(quote!.txRequest!.gasLimit).toBe("7388876");
  });

  it("a live quote that states no gas carries neither a gas limit nor an estimate", async () => {
    const f = loadRecorded("base-usdc-eth.2026-11-25");
    const body = bodyOf(f);
    delete body.transaction.gas;
    const {quote, params} = await quoted(f, body);
    expect(quote!.txRequest!.gasLimit).toBeUndefined();
    expect(quote!.gasEstimate).toBeUndefined();
    expect(quote!.gasEstimateSource).toBeUndefined();
    expect(quoteRejection(quote!, params, "zeroex")).toBeNull();
  });

  it("a price that states no gas, 0, or gas in hex carries no estimate (its recorded totalNetworkFee still prices the network fee)", async () => {
    const f = loadRecorded("base-usdc-eth-price.2026-11-25");
    for (const gas of [undefined, "0", "0x41d2a"]) {
      const body = bodyOf(f);
      if (gas === undefined) delete body.gas;
      else body.gas = gas;
      const {quote, params} = await quoted(f, body);
      expect(quote!.gasEstimate, String(gas)).toBeUndefined();
      expect(quote!.gasEstimateSource).toBeUndefined();
      expect(quoteRejection(quote!, params, "zeroex")).toBeNull();
    }
  });

  it.each(["base-usdc-eth.2026-11-25", "base-eth-usdc.2026-11-25"])("%s: sealed by the swap2 server, the same estimate reaches the device's remote provider", async (name) => {
    const f = loadRecorded(name);
    vi.setSystemTime(f.request.nowMs);
    vi.stubGlobal("fetch", recordedFetch(f));
    const handle = createSwap2Handler<string>({providers: [zeroExProvider({apiKey: getKey, rpcUrls: rpcOf(f), chains: chainsConfigOf(f)})], sealSecret: "recorded-test-seal-secret-at-least-32-bytes", guard: () => {}, subject: () => "alice"});
    const backend = (async (url: string, init: RequestInit) => {
      const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "user");
      return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
    const app = zeroExRemoteProvider({baseUrl: "https://backend.example/api/swap2", fetchImpl: backend, rpcUrls: rpcOf(f), chains: chainsConfigOf(f)});
    const q = await app.getQuote(paramsOf(f) as QuoteParams);
    expect([q!.gasEstimate, q!.gasEstimateSource]).toEqual([f.response.transaction.gas, "venue"]);
  });
});

describe("zeroExGasEstimate", () => {
  it("is 0x's figure as canonical digits, or nothing", () => {
    expect(zeroExGasEstimate("269610")).toBe("269610");
    expect(zeroExGasEstimate("0269610")).toBe("269610");
    expect(zeroExGasEstimate("6140730")).toBe("6140730");
    expect(zeroExGasEstimate("0")).toBeUndefined();
    expect(zeroExGasEstimate(null)).toBeUndefined();
    expect(zeroExGasEstimate(undefined)).toBeUndefined();
    expect(zeroExGasEstimate(269610)).toBeUndefined();
    expect(zeroExGasEstimate("0x41d2a")).toBeUndefined();
    expect(zeroExGasEstimate("10000000000")).toBeUndefined();
  });
});
