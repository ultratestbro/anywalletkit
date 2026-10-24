/**
 * Host failover. A quote must only ever be bound to an inbound snapshot from
 * the same node, host-level failures move to the next host, and a node's
 * business rejection is final (never re-asked elsewhere).
 */
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {thorchainProvider} from "../src/provider.js";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";

const PRIMARY = "https://primary.invalid";
const SECONDARY = "https://secondary.invalid";
const VAULT = "0x1111111111111111111111111111111111111111";
const ROUTER = "0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146";
const BTC_DEST = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

type Reply = {status: number; body: unknown} | "down";
interface HostState {quote: Reply; inbound: Reply}

let hosts: Record<string, HostState>;
let calls: string[];

const ok = (body: unknown): Reply => ({status: 200, body});
const inboundBody = () => [
  {chain: "ETH", address: VAULT, router: ROUTER, halted: false},
  {chain: "BTC", address: BTC_DEST, halted: false},
];
const quoteBody = (limit = "95000") => ({
  expected_amount_out: "100000",
  inbound_address: VAULT,
  router: ROUTER,
  memo: `=:b:${BTC_DEST}:${limit}`,
  expiry: Math.floor(Date.now() / 1000) + 3600,
});

function params(): QuoteParams {
  return {
    sourceChain: "eip155:1",
    sourceToken: "ETH",
    destChain: "bitcoin:mainnet",
    destToken: "0x0000000000000000000000000000000000000000",
    amountIn: "50000000000000000",
    destAddress: BTC_DEST,
  };
}

beforeEach(() => {
  hosts = {
    [PRIMARY]: {quote: ok(quoteBody()), inbound: ok(inboundBody())},
    [SECONDARY]: {quote: ok(quoteBody()), inbound: ok(inboundBody())},
  };
  calls = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    const host = Object.keys(hosts).find((h) => url.startsWith(h));
    if (!host) return new Response("nope", {status: 404});
    const kind = url.includes("/quote/swap") ? "quote" : url.includes("/inbound_addresses") ? "inbound" : null;
    if (!kind) return new Response("nope", {status: 404});
    calls.push(`${host} ${kind}`);
    const reply = hosts[host]![kind];
    if (reply === "down") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(reply.body), {status: reply.status});
  });
});
afterEach(() => vi.unstubAllGlobals());

const provider = () => thorchainProvider({nodeUrl: [PRIMARY, SECONDARY]});

describe("THORNode host failover", () => {
  it("serves quote + inbound from the primary when it is healthy", async () => {
    await expect(provider().getQuote(params())).resolves.not.toBeNull();
    expect(calls).toEqual([`${PRIMARY} quote`, `${PRIMARY} inbound`]);
  });

  it("moves both calls to the secondary when the primary is unreachable", async () => {
    hosts[PRIMARY]!.quote = "down";
    await expect(provider().getQuote(params())).resolves.not.toBeNull();
    expect(calls).toEqual([`${PRIMARY} quote`, `${SECONDARY} quote`, `${SECONDARY} inbound`]);
  });

  it("treats gateway errors and rate limits as host failures", async () => {
    for (const status of [500, 502, 503, 429, 403]) {
      calls = [];
      hosts[PRIMARY]!.quote = {status, body: {error: "gateway"}};
      await expect(provider().getQuote(params())).resolves.not.toBeNull();
      expect(calls).toEqual([`${PRIMARY} quote`, `${SECONDARY} quote`, `${SECONDARY} inbound`]);
    }
  });

  it("never pairs a primary quote with a secondary inbound snapshot", async () => {
    hosts[PRIMARY]!.inbound = "down";
    await expect(provider().getQuote(params())).resolves.not.toBeNull();
    // The inbound failure on the primary re-runs the QUOTE on the secondary.
    expect(calls).toEqual([`${PRIMARY} quote`, `${PRIMARY} inbound`, `${SECONDARY} quote`, `${SECONDARY} inbound`]);
  });

  it("names a memo limit under the caller's floor instead of a silent null", async () => {
    const reasons: string[] = [];
    await expect(provider().getQuote({...params(), minAmountOut: "96000", onRefusal: (r) => reasons.push(r)})).resolves.toBeNull();
    expect(reasons).toEqual(["thorchain: floor breach (limit=95000 < floor=96000, 1e8 units)"]);
  });

  it("does not shop a node's business rejection to another host", async () => {
    hosts[PRIMARY]!.quote = {status: 404, body: {error: "pool does not exist"}};
    await expect(provider().getQuote(params())).resolves.toBeNull();
    expect(calls).toEqual([`${PRIMARY} quote`]);
  });

  it("keeps the adaptive slippage retry on the same host", async () => {
    let first = true;
    const original = hosts[PRIMARY]!.quote;
    hosts[PRIMARY]!.quote = {status: 400, body: {code: 3, message: "emit asset 96000 less than price limit 97000"}};
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith(PRIMARY) && url.includes("/quote/swap")) {
        calls.push(`${PRIMARY} quote`);
        if (first) {
          first = false;
          return new Response(JSON.stringify(hosts[PRIMARY]!.quote === "down" ? {} : (hosts[PRIMARY]!.quote as {body: unknown}).body), {status: 400});
        }
        return new Response(JSON.stringify((original as {body: unknown}).body), {status: 200});
      }
      if (url.startsWith(PRIMARY) && url.includes("/inbound_addresses")) {
        calls.push(`${PRIMARY} inbound`);
        return new Response(JSON.stringify(inboundBody()), {status: 200});
      }
      calls.push(`other ${url}`);
      return new Response("nope", {status: 404});
    });
    await expect(provider().getQuote(params())).resolves.not.toBeNull();
    expect(calls).toEqual([`${PRIMARY} quote`, `${PRIMARY} quote`, `${PRIMARY} inbound`]);
  });

  it("fails closed when every host is down", async () => {
    hosts[PRIMARY]!.quote = "down";
    hosts[SECONDARY]!.quote = "down";
    await expect(provider().getQuote(params())).resolves.toBeNull();
  });

  it("re-checks inbound state from the next live host before broadcast", async () => {
    const p = provider();
    const quote = (await p.getQuote(params()))!;
    const tx = await p.buildDeposit(quote);
    calls = [];
    hosts[PRIMARY]!.inbound = "down";
    await expect(p.preflightDeposit!(quote, tx)).resolves.toBeUndefined();
    expect(calls).toEqual([`${PRIMARY} inbound`, `${SECONDARY} inbound`]);
    hosts[SECONDARY]!.inbound = "down";
    await expect(p.preflightDeposit!(quote, tx)).rejects.toThrow(/cannot refresh/);
  });

  it("accepts a comma-separated host list and rejects malformed entries", async () => {
    hosts[PRIMARY]!.quote = "down";
    await expect(thorchainProvider({nodeUrl: ` ${PRIMARY}, ${SECONDARY} `}).getQuote(params())).resolves.not.toBeNull();
    expect(calls.at(-1)).toBe(`${SECONDARY} inbound`);
    expect(() => thorchainProvider({nodeUrl: "not a url"})).toThrow(/absolute http/);
    expect(() => thorchainProvider({nodeUrl: [PRIMARY, "ftp://x"]})).toThrow(/http or https/);
  });
});
