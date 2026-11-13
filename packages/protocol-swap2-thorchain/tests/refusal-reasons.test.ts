/**
 * CS-13 refusal reasons: every refusal this package produces keeps its text byte for byte and carries a stable
 * `reason` next to it — on `onRefusal`'s second argument (getQuote), on the thrown error (buildDeposit,
 * preflightDeposit; `refusalOf`), and through `thorchainPins().reasonOf` for the texts `verifyBuild` returns. Every
 * case drives the real provider over fake THORNodes (a stubbed global fetch, no network): quote and inbound snapshot
 * from the quoting node, the second-node check from the confirming ones.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {encodeFunctionData} from "viem";
import {refusalOf, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {thorchainPins, thorchainProvider} from "../src/provider.js";
import {LIVE_HEIGHT, LIVE_MIMIR, asgardFor, lastblockAt, vault} from "./thornode-stub.js";

const QUOTE = "https://quote.invalid";
const QUOTE2 = "https://quote2.invalid";
const CONFIRM = "https://confirm.invalid";
const CONFIRM2 = "https://confirm2.invalid";
// The default public nodes: always among the provider's confirming hosts, after confirmNodeUrl and nodeUrl.
const LIQUIFY = "https://gateway.liquify.com/chain/thorchain_api";
const IBS = "https://thorchain.ibs.team/api";
const VAULT = "0x1111111111111111111111111111111111111111";
const OTHER_VAULT = "0x2222222222222222222222222222222222222222";
const ROUTER = "0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146";
const BASE_ROUTER = "0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4";
const ATTACKER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NATIVE = "0x0000000000000000000000000000000000000000";
const BTC_DEST = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const BTC_OTHER = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
const BTC_VAULT = "bc1qyl7j673h6hlvvlgf3kj7s4ll5yfmxzzvk03qky";
const ETH_DEST = "0x9999999999999999999999999999999999999999";
const TRON = "tron:728126428";
const TRON_VAULT = "TAewdzzZPbA8bUUoDqo1Ygh5CbCuq2hrLD";
const TRON_OTHER = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CANONICAL = `=:BTC.BTC:${BTC_DEST}:95000`;

const ROUTER_ABI = [{type: "function", name: "depositWithExpiry", stateMutability: "payable", inputs: [{name: "vault", type: "address"}, {name: "asset", type: "address"}, {name: "amount", type: "uint256"}, {name: "memo", type: "string"}, {name: "expiry", type: "uint256"}], outputs: []}] as const;
const depositCall = (vault: string, amount: bigint, memo: string, expiry: bigint) =>
  encodeFunctionData({abi: ROUTER_ABI, functionName: "depositWithExpiry", args: [vault as `0x${string}`, NATIVE, amount, memo, expiry]});

interface FakeNode {
  height: number;
  inbound: unknown[];
  quote: {status: number; body?: unknown; raw?: string};
  /** Every read of the node answers this status (with these headers), or fails at the network. */
  fail?: {status: number; headers?: Record<string, string>} | "network";
  /** One path's own answer, by path suffix. */
  answer?: Record<string, () => Response>;
}

const inbound = (o: {eth?: Record<string, unknown>; btc?: Record<string, unknown>; tron?: Record<string, unknown>} = {}): unknown[] => [
  {chain: "ETH", address: VAULT, router: ROUTER, halted: false, dust_threshold: "1000", ...o.eth},
  {chain: "BTC", address: BTC_VAULT, halted: false, dust_threshold: "10000", ...o.btc},
  {chain: "TRON", address: TRON_VAULT, halted: false, dust_threshold: "10000", ...o.tron},
];
const ethQuote = (o: Record<string, unknown> = {}) => ({
  expected_amount_out: "100000", inbound_address: VAULT, router: ROUTER, memo: `=:b:${BTC_DEST}:95000`,
  expiry: Math.floor(Date.now() / 1000) + 3600, recommended_min_amount_in: "1000", ...o,
});
const tronQuote = (o: Record<string, unknown> = {}) => ({
  expected_amount_out: "2061155", inbound_address: TRON_VAULT, memo: `=:e:${ETH_DEST}:2014026`,
  expiry: Math.floor(Date.now() / 1000) + 3600, recommended_min_amount_in: "1000", ...o,
});
const node = (o: Partial<FakeNode> = {}): FakeNode => ({height: LIVE_HEIGHT, inbound: inbound(), quote: {status: 200, body: ethQuote()}, ...o});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});
/** A confirming node whose current ETH inbound is another vault, and whose vault list (and mimir) say this of VAULT. */
const listing = (v: Record<string, unknown>, mimir: Record<string, number> = LIVE_MIMIR): Partial<FakeNode> => ({
  inbound: inbound({eth: {address: OTHER_VAULT}}),
  answer: {"/thorchain/vaults/asgard": () => json([v]), "/thorchain/mimir": () => json(mimir)},
});
const retiringVault = () => listing(vault("retiring", "RetiringVault", [{chain: "ETH", address: VAULT}]));
const compromisedVault = () => {
  const v = vault("compromised", "ActiveVault", [{chain: "ETH", address: VAULT}]);
  return listing(v, {...LIVE_MIMIR, [`CompromisedVault-${String(v.pub_key)}`]: 1});
};

let nodes: Record<string, FakeNode>;

beforeEach(() => {
  nodes = {[QUOTE]: node(), [CONFIRM]: node()};
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const href = String(input);
    const host = Object.keys(nodes).find((h) => href.startsWith(`${h}/`));
    // Any other host (the default public nodes among the confirming hosts) is not reachable here.
    if (!host) return new Response("nope", {status: 404});
    const n = nodes[host]!;
    if (n.fail === "network") throw new TypeError("fetch failed");
    if (n.fail) return new Response(JSON.stringify({error: "refused"}), {status: n.fail.status, headers: n.fail.headers ?? {}});
    const path = new URL(href).pathname;
    for (const [suffix, answer] of Object.entries(n.answer ?? {})) if (path.endsWith(suffix)) return answer();
    if (path.endsWith("/thorchain/quote/swap")) return n.quote.raw !== undefined ? new Response(n.quote.raw, {status: n.quote.status}) : json(n.quote.body, n.quote.status);
    if (path.endsWith("/thorchain/inbound_addresses")) return json(n.inbound);
    if (path.endsWith("/thorchain/lastblock")) return json(lastblockAt(n.height));
    if (path.endsWith("/thorchain/vaults/asgard")) return json(asgardFor(n.inbound));
    if (path.endsWith("/thorchain/mimir")) return json(LIVE_MIMIR);
    return new Response("nope", {status: 404});
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const params = (o: Partial<QuoteParams> = {}): QuoteParams => ({
  sourceChain: "eip155:1", sourceToken: "ETH", destChain: "bitcoin:mainnet", destToken: NATIVE,
  amountIn: "50000000000000000", destAddress: BTC_DEST, ...o,
});
const tronParams = (o: Partial<QuoteParams> = {}): QuoteParams => ({
  sourceChain: TRON, sourceToken: "USDT", destChain: "eip155:1", destToken: NATIVE, amountIn: "50000000", destAddress: ETH_DEST, ...o,
});
const provider = (o: Parameters<typeof thorchainProvider>[0] = {}) => thorchainProvider({nodeUrl: QUOTE, confirmNodeUrl: [CONFIRM], ...o});

interface Seen {text: string; info: Swap2RefusalInfo | undefined}
/** The one refusal getQuote reported, text and classification; the quote itself is null. */
async function refusedQuote(p: CrossChainProvider, o: Partial<QuoteParams> = {}, base = params): Promise<Seen> {
  const seen: Seen[] = [];
  await expect(p.getQuote(base({...o, onRefusal: (text, info) => { seen.push({text, info}); }}))).resolves.toBeNull();
  expect(seen).toHaveLength(1);
  return seen[0]!;
}
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}
/** A live quote and its deposit from the default fake nodes. */
async function quoted(p: CrossChainProvider = provider(), o: Partial<QuoteParams> = {}, base = params): Promise<{p: CrossChainProvider; q: Quote; tx: UnsignedTx}> {
  const q = await p.getQuote(base(o));
  expect(q).not.toBeNull();
  return {p, q: q!, tx: await p.buildDeposit(q!)};
}

describe("getQuote: the node's own rejection, classified from its text, else its status", () => {
  const rejecting = (status: number, body: unknown) => {
    nodes[QUOTE]!.quote = {status, body};
  };

  it("unsupported_pair: the node has no such pool", async () => {
    rejecting(404, {error: "pool does not exist"});
    const r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: pool does not exist");
    expect(r.info).toEqual({reason: "unsupported_pair"});
  });

  it("price_check_failed: the output under the price limit (an explicit 0 bp slippage is never widened)", async () => {
    rejecting(400, {code: 3, message: "failed to simulate swap: failed to simulate handler: emit asset 61302 less than price limit 61597: invalid request"});
    const r = await refusedQuote(provider(), {slippageBps: 0});
    expect(r.text).toBe("thorchain: failed to simulate swap: failed to simulate handler: emit asset 61302 less than price limit 61597: invalid request");
    expect(r.info).toEqual({reason: "price_check_failed"});
  });

  it("amount_too_small: fees leave nothing to emit", async () => {
    rejecting(400, {code: 3, message: "failed to simulate swap: failed to simulate handler: emit asset 0 less than price limit 61597: invalid request"});
    const r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: failed to simulate swap: failed to simulate handler: emit asset 0 less than price limit 61597: invalid request");
    expect(r.info).toEqual({reason: "amount_too_small"});
  });

  it("chain_halted: trading is halted", async () => {
    rejecting(400, {code: 3, message: "failed to simulate swap: failed to simulate handler: trading is halted, can't process swap: invalid request"});
    const r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: failed to simulate swap: failed to simulate handler: trading is halted, can't process swap: invalid request");
    expect(r.info).toEqual({reason: "chain_halted"});
  });

  it("insufficient_liquidity: the node reports too little liquidity", async () => {
    rejecting(400, {code: 3, message: "failed to simulate swap: not enough liquidity"});
    const r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: failed to simulate swap: not enough liquidity");
    expect(r.info).toEqual({reason: "insufficient_liquidity"});
  });

  it("no_route: a rejection nothing else names", async () => {
    rejecting(400, {error: "no quote available"});
    const r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: no quote available");
    expect(r.info).toEqual({reason: "no_route"});
  });

  it("key_rejected: HTTP 401 from the quote endpoint", async () => {
    rejecting(401, {code: 16, message: "access denied"});
    const r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: access denied");
    expect(r.info).toEqual({reason: "key_rejected", httpStatus: 401});
  });

  it("upstream_unavailable: a 4xx without a JSON body is another shape", async () => {
    nodes[QUOTE]!.quote = {status: 404, raw: "<html>not found</html>"};
    const r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: HTTP 404");
    expect(r.info).toEqual({reason: "upstream_unavailable", httpStatus: 404});
  });

  it("amount_too_small / rate_limited / key_rejected: dust, fees, throttling and the key, named by the text (a 400 says nothing itself)", async () => {
    const cases: [unknown, string, Swap2RefusalInfo][] = [
      [{code: 3, message: "failed to simulate swap: amount less than dust threshold"}, "thorchain: failed to simulate swap: amount less than dust threshold", {reason: "amount_too_small"}],
      [{code: 3, message: "failed to simulate swap: not enough asset to pay for fees"}, "thorchain: failed to simulate swap: not enough asset to pay for fees", {reason: "amount_too_small"}],
      [{error: "swap amount too small"}, "thorchain: swap amount too small", {reason: "amount_too_small"}],
      [{error: "rate limit exceeded"}, "thorchain: rate limit exceeded", {reason: "rate_limited"}],
      [{message: "Too Many Requests"}, "thorchain: Too Many Requests", {reason: "rate_limited"}],
      [{error: "invalid api key"}, "thorchain: invalid api key", {reason: "key_rejected"}],
      [{message: "Unauthorized"}, "thorchain: Unauthorized", {reason: "key_rejected"}],
    ];
    for (const [body, text, info] of cases) {
      rejecting(400, body);
      const r = await refusedQuote(provider());
      expect(r.text).toBe(text);
      expect(r.info).toEqual(info);
    }
  });
});

describe("getQuote: every node failing (the real fetch path through hostGet)", () => {
  const twoHosts = () => thorchainProvider({nodeUrl: [QUOTE, QUOTE2], confirmNodeUrl: [CONFIRM]});
  beforeEach(() => {
    nodes[QUOTE2] = node();
  });

  it("rate_limited: HTTP 429 on every node, with the shortest Retry-After", async () => {
    nodes[QUOTE]!.fail = {status: 429, headers: {"retry-after": "30"}};
    nodes[QUOTE2]!.fail = {status: 429, headers: {"retry-after": "10"}};
    const r = await refusedQuote(twoHosts());
    expect(r.text).toBe("thorchain: inbound addresses unavailable from every node");
    expect(r.info).toEqual({reason: "rate_limited", retryAfterMs: 10_000});
  });

  it("key_rejected: HTTP 403 on every node", async () => {
    nodes[QUOTE]!.fail = {status: 403};
    nodes[QUOTE2]!.fail = {status: 403};
    const r = await refusedQuote(twoHosts());
    expect(r.text).toBe("thorchain: inbound addresses unavailable from every node");
    expect(r.info).toEqual({reason: "key_rejected", httpStatus: 403});
  });

  it("upstream_unavailable: 5xx on every node (the status kept when they agree)", async () => {
    nodes[QUOTE]!.fail = {status: 503};
    nodes[QUOTE2]!.fail = {status: 503};
    expect((await refusedQuote(twoHosts())).info).toEqual({reason: "upstream_unavailable", httpStatus: 503});
    nodes[QUOTE]!.fail = {status: 502};
    const r = await refusedQuote(twoHosts());
    expect(r.text).toBe("thorchain: inbound addresses unavailable from every node");
    expect(r.info).toEqual({reason: "upstream_unavailable"});
  });

  it("upstream_unavailable: a network error on every node, or failures that disagree", async () => {
    nodes[QUOTE]!.fail = "network";
    nodes[QUOTE2]!.fail = "network";
    const r = await refusedQuote(twoHosts());
    expect(r.text).toBe("thorchain: inbound addresses unavailable from every node");
    expect(r.info).toEqual({reason: "upstream_unavailable"});
    nodes[QUOTE2]!.fail = {status: 429, headers: {"retry-after": "5"}};
    expect((await refusedQuote(twoHosts())).info).toEqual({reason: "upstream_unavailable"});
  });

  it("key_rejected / upstream_unavailable: the quoting node's inbound_addresses answers a non-2xx status", async () => {
    nodes[QUOTE]!.answer = {"/thorchain/inbound_addresses": () => new Response("{}", {status: 401})};
    let r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: inbound addresses unavailable from every node");
    expect(r.info).toEqual({reason: "key_rejected", httpStatus: 401});
    nodes[QUOTE]!.answer = {"/thorchain/inbound_addresses": () => new Response("{}", {status: 404})};
    r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: inbound addresses unavailable from every node");
    expect(r.info).toEqual({reason: "upstream_unavailable", httpStatus: 404});
  });

  it("upstream_unavailable: the quoting node's THORChain height is unavailable", async () => {
    nodes[QUOTE]!.answer = {"/thorchain/lastblock": () => new Response("down", {status: 500})};
    const r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: THORChain height (/thorchain/lastblock) unavailable from every node that answered the inbound addresses");
    expect(r.info).toEqual({reason: "upstream_unavailable", httpStatus: 500});
  });
});

describe("getQuote: the module's own checks", () => {
  it("unsupported_pair: no THORChain pool for the pair in the catalog", async () => {
    const r = await refusedQuote(provider(), {destChain: "solana:mainnet", destToken: SOL_USDC, destAddress: "So11111111111111111111111111111111111111112"});
    expect(r.text).toBe(`thorchain: no pool for ETH on eip155:1 → ${SOL_USDC} on solana:mainnet`);
    expect(r.info).toEqual({reason: "unsupported_pair"});
  });

  it("policy_refused: more precision than 8 decimals, a slippage over the cap, a router on a deposit source", async () => {
    let r = await refusedQuote(provider(), {amountIn: "50000000000000001"});
    expect(r.text).toBe("thorchain: amount has more precision than THORChain's 8 decimals — round it to 8 decimals");
    expect(r.info).toEqual({reason: "policy_refused"});
    r = await refusedQuote(provider(), {slippageBps: 501});
    expect(r.text).toBe("thorchain: slippage 501 bps is outside 0–500 bps");
    expect(r.info).toEqual({reason: "policy_refused"});
    nodes[QUOTE]!.quote = {status: 200, body: tronQuote({router: ROUTER})};
    r = await refusedQuote(provider({tronSource: true}), {}, tronParams);
    expect(r.text).toBe("thorchain: quote names a router for a deposit source — execution model changed");
    expect(r.info).toEqual({reason: "policy_refused"});
  });

  it("policy_refused: THORChain fees over this module's 5% cap, whether a fixed outbound fee or a large swap's slip", async () => {
    // A small swap: the fixed outbound fee is most of it.
    nodes[QUOTE]!.quote = {status: 200, body: ethQuote({fees: {total_bps: 1000, slippage_bps: 5, outbound: "9000"}})};
    let r = await refusedQuote(provider(), {slippageBps: 100});
    expect(r.text).toBe("thorchain: THORChain fees 10.00% — too expensive at this amount (cap 5%)");
    expect(r.info).toEqual({reason: "policy_refused"});
    // A large swap through a thin pool (streaming pinned off): the liquidity fee is most of it — sending more would
    // only slip further, so it is not amount_too_small.
    nodes[QUOTE]!.quote = {status: 200, body: ethQuote({fees: {total_bps: 900, slippage_bps: 880, outbound: "20"}})};
    r = await refusedQuote(provider(), {amountIn: "500000000000000000000", slippageBps: 100});
    expect(r.text).toBe("thorchain: THORChain fees 9.00% — too expensive at this amount (cap 5%)");
    expect(r.info).toEqual({reason: "policy_refused"});
  });

  it("amount_too_small: dust, the recommended minimum, an output rounding to zero", async () => {
    nodes[QUOTE] = node({inbound: inbound({eth: {dust_threshold: "10000000"}})});
    let r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: amount at or below THORChain dust threshold");
    expect(r.info).toEqual({reason: "amount_too_small"});
    nodes[QUOTE] = node({quote: {status: 200, body: ethQuote({recommended_min_amount_in: "6000000"})}});
    r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: amount below THORChain recommended minimum");
    expect(r.info).toEqual({reason: "amount_too_small"});
    nodes[QUOTE] = node({quote: {status: 200, body: ethQuote({expected_amount_out: "0"})}});
    r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: expected output rounds to zero");
    expect(r.info).toEqual({reason: "amount_too_small"});
  });

  it("upstream_unavailable: an incomplete quote (with the status of a non-2xx one), an EVM quote without a router", async () => {
    nodes[QUOTE]!.quote = {status: 200, body: {expected_amount_out: "1"}};
    let r = await refusedQuote(provider());
    expect(r.text).toBe(`thorchain: incomplete quote from ${QUOTE} (expected_amount_out / inbound_address / memo / expiry missing)`);
    expect(r.info).toEqual({reason: "upstream_unavailable"});
    nodes[QUOTE]!.quote = {status: 404, body: {}};
    expect((await refusedQuote(provider())).info).toEqual({reason: "upstream_unavailable", httpStatus: 404});
    nodes[QUOTE]!.quote = {status: 200, body: ethQuote({router: undefined})};
    r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: quote has no router for an EVM source");
    expect(r.info).toEqual({reason: "upstream_unavailable"});
  });

  it("recipient_mismatch / recipient_unverifiable / policy_refused / price_check_failed: why the memo failed", async () => {
    const memoRefusal = async (memo: string, p = provider()) => {
      nodes[QUOTE]!.quote = {status: 200, body: ethQuote({memo})};
      return refusedQuote(p);
    };
    let r = await memoRefusal(`=:b:${BTC_OTHER}:95000`);
    expect(r.text).toBe(`thorchain: memo failed verification (=:b:${BTC_OTHER}:95000)`);
    expect(r.info).toEqual({reason: "recipient_mismatch"});
    r = await memoRefusal(`=:b:${BTC_DEST}:95000|0x1:2`);
    expect(r.text).toBe(`thorchain: memo failed verification (=:b:${BTC_DEST}:95000|0x1:2)`);
    expect(r.info).toEqual({reason: "recipient_unverifiable"});
    r = await memoRefusal(`=:b:${BTC_DEST}:95000`, provider({affiliate: "vv", affiliateBps: "10"}));
    expect(r.text).toBe(`thorchain: memo failed verification (=:b:${BTC_DEST}:95000)`);
    expect(r.info).toEqual({reason: "policy_refused"});
    r = await memoRefusal(`=:b:${BTC_DEST}:95000/3/0`);
    expect(r.text).toBe(`thorchain: memo failed verification (=:b:${BTC_DEST}:95000/3/0)`);
    expect(r.info).toEqual({reason: "price_check_failed"});
  });

  it("price_check_failed: the caller's floor, the memo limit against the output and the slippage", async () => {
    let r = await refusedQuote(provider(), {minAmountOut: "96000"});
    expect(r.text).toBe("thorchain: floor breach (limit=95000 < floor=96000, 1e8 units)");
    expect(r.info).toEqual({reason: "price_check_failed"});
    r = await refusedQuote(provider(), {slippageBps: 100});
    expect(r.text).toBe("thorchain: memo limit 95000 is below expected 100000 minus 100 bps slippage (1e8 units)");
    expect(r.info).toEqual({reason: "price_check_failed"});
    nodes[QUOTE]!.quote = {status: 200, body: ethQuote({memo: `=:b:${BTC_DEST}:200000`})};
    r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: memo limit 200000 inconsistent with expected output 100000");
    expect(r.info).toEqual({reason: "price_check_failed"});
  });

  it("chain_halted: on the quoting node's snapshot and on the confirming node", async () => {
    nodes[QUOTE]!.inbound = inbound({btc: {halted: true}});
    let r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: BTC chain is halted / paused on THORChain");
    expect(r.info).toEqual({reason: "chain_halted"});
    nodes[QUOTE]!.inbound = inbound();
    nodes[CONFIRM]!.inbound = inbound({btc: {halted: true}});
    r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: BTC is halted / paused on the confirming node");
    expect(r.info).toEqual({reason: "chain_halted"});
  });

  it("vault_mismatch: vault rotated, router changed, router untrusted, a second node naming another vault", async () => {
    nodes[QUOTE]!.quote = {status: 200, body: ethQuote({inbound_address: OTHER_VAULT})};
    let r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: quote inbound address differs from the node's current inbound (vault rotated) — retry");
    expect(r.info).toEqual({reason: "vault_mismatch"});
    nodes[QUOTE] = node({inbound: inbound({eth: {router: BASE_ROUTER}})});
    r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: quote router differs from the node's current router — retry");
    expect(r.info).toEqual({reason: "vault_mismatch"});
    nodes[QUOTE] = node({inbound: inbound({eth: {router: ATTACKER}}), quote: {status: 200, body: ethQuote({router: ATTACKER})}});
    r = await refusedQuote(provider());
    expect(r.text).toBe(`thorchain: router ${ATTACKER} is not a THORChain router this module trusts on eip155:1 (THORCHAIN_ROUTERS / trustedRouters)`);
    expect(r.info).toEqual({reason: "vault_mismatch"});
    nodes[QUOTE] = node();
    nodes[CONFIRM]!.inbound = inbound({eth: {address: OTHER_VAULT}});
    r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: a second node reports another inbound vault — refused until they agree");
    expect(r.info).toEqual({reason: "vault_mismatch"});
  });

  it("stale_node: the confirming node trails the quoting node", async () => {
    nodes[CONFIRM]!.height = LIVE_HEIGHT - 100;
    const r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: no confirming node is within 50 blocks of the quoting node's THORChain height (behind or unreachable) — refused until one catches up");
    expect(r.info).toEqual({reason: "stale_node"});
  });

  it("upstream_unavailable: no second node answers", async () => {
    nodes[CONFIRM]!.fail = "network";
    const r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: no second node answered to confirm the inbound vault (configure confirmNodeUrl)");
    expect(r.info).toEqual({reason: "upstream_unavailable"});
  });

  it("vault_mismatch: a second node listing the vault as not active, its mimir flagging it, another router", async () => {
    Object.assign(nodes[CONFIRM]!, retiringVault());
    let r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: a second node lists the inbound vault as RetiringVault, not ActiveVault — refused");
    expect(r.info).toEqual({reason: "vault_mismatch"});
    nodes[CONFIRM] = node(compromisedVault());
    r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: a second node's mimir flags the inbound vault as compromised — refused");
    expect(r.info).toEqual({reason: "vault_mismatch"});
    nodes[CONFIRM] = node({inbound: inbound({eth: {router: BASE_ROUTER}})});
    r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: a second node reports another router — refused until they agree");
    expect(r.info).toEqual({reason: "vault_mismatch"});
  });

  it("rate_limited: every confirming node throttled, with the shortest Retry-After; one failing otherwise → upstream_unavailable", async () => {
    nodes[CONFIRM]!.fail = {status: 429, headers: {"retry-after": "30"}};
    nodes[LIQUIFY] = node({fail: {status: 429, headers: {"retry-after": "10"}}});
    nodes[IBS] = node({fail: {status: 429, headers: {"retry-after": "20"}}});
    let r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: no second node answered to confirm the inbound vault (configure confirmNodeUrl)");
    expect(r.info).toEqual({reason: "rate_limited", retryAfterMs: 10_000});
    nodes[IBS] = node({fail: {status: 503}});
    r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: no second node answered to confirm the inbound vault (configure confirmNodeUrl)");
    expect(r.info).toEqual({reason: "upstream_unavailable"});
  });

  it("upstream_unavailable: the confirmation budget runs out before a second node is asked, or before the next one", async () => {
    vi.useFakeTimers({toFake: ["Date"]});
    // The quoting node's height read takes the whole 8 s budget (the clock moves while it answers).
    nodes[QUOTE]!.answer = {"/thorchain/lastblock": () => { vi.setSystemTime(Date.now() + 8_000); return json(lastblockAt(LIVE_HEIGHT)); }};
    let r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: the 8 s confirmation budget ran out before a second node could be asked to confirm the inbound vault — retry");
    expect(r.info).toEqual({reason: "upstream_unavailable"});
    // The first confirming node throttles after using up the budget: the node the budget left unasked did not
    // throttle, so it is not rate_limited.
    nodes[QUOTE] = node();
    const throttled = () => new Response("{}", {status: 429, headers: {"retry-after": "30"}});
    nodes[CONFIRM]!.answer = {
      "/thorchain/lastblock": () => { vi.setSystemTime(Date.now() + 8_000); return throttled(); },
      "/thorchain/inbound_addresses": throttled,
    };
    nodes[LIQUIFY] = node({fail: {status: 429, headers: {"retry-after": "30"}}});
    r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: no second node answered to confirm the inbound vault (configure confirmNodeUrl)");
    expect(r.info).toEqual({reason: "upstream_unavailable"});
  });

  it("quote_expired: the quote's own expiry is too close", async () => {
    vi.useFakeTimers({toFake: ["Date"]});
    vi.setSystemTime(new Date("2026-11-13T12:00:00Z"));
    nodes[QUOTE]!.quote = {status: 200, body: ethQuote({expiry: Math.floor(Date.now() / 1000) + 20})};
    const r = await refusedQuote(provider());
    expect(r.text).toBe("thorchain: quote expires in 20 s — too soon to execute");
    expect(r.info).toEqual({reason: "quote_expired"});
  });
});

describe("buildDeposit and preflightDeposit: the thrown error carries the reason", () => {
  it("unsupported_pair: deposit-address execution without the Tron opt-in, a source chain without executor", async () => {
    const {p, q, tx} = await quoted();
    const {txRequest: _router, ...bare} = q;
    let e = await rejection(p.buildDeposit(bare as Quote));
    expect(e.message).toBe("thorchain: deposit-address execution is only supported for an opted-in Tron source");
    expect(refusalOf(e)).toEqual({reason: "unsupported_pair"});
    e = await rejection(p.preflightDeposit!({...q, providerData: {...q.providerData, sourceChain: "bitcoin:mainnet"}}, tx));
    expect(e.message).toBe("thorchain: source chain has no executor");
    expect(refusalOf(e)).toEqual({reason: "unsupported_pair"});
  });

  it("policy_refused / quote_expired / vault_mismatch: the quote's own metadata", async () => {
    const {p, q, tx} = await quoted();
    let e = await rejection(p.preflightDeposit!({...q, providerData: {...q.providerData, memo: ""}}, tx));
    expect(e.message).toBe("thorchain: quote is missing execution-bound metadata");
    expect(refusalOf(e)).toEqual({reason: "policy_refused"});
    e = await rejection(p.preflightDeposit!({...q, providerData: {...q.providerData, expiry: "1"}}, tx));
    expect(e.message).toBe("thorchain: quote expired before broadcast");
    expect(refusalOf(e)).toEqual({reason: "quote_expired"});
    e = await rejection(p.preflightDeposit!({...q, providerData: {...q.providerData, router: ATTACKER}}, tx));
    expect(e.message).toBe("thorchain: the quote's router is not one this module trusts");
    expect(refusalOf(e)).toEqual({reason: "vault_mismatch"});
  });

  it("chain_halted / vault_mismatch: the snapshot refreshed before broadcast", async () => {
    const {p, q, tx} = await quoted();
    nodes[QUOTE]!.inbound = inbound({btc: {halted: true}});
    let e = await rejection(p.preflightDeposit!(q, tx));
    expect(e.message).toBe("thorchain: source or destination chain trading is paused");
    expect(refusalOf(e)).toEqual({reason: "chain_halted"});
    nodes[QUOTE]!.inbound = inbound({eth: {address: OTHER_VAULT}});
    e = await rejection(p.preflightDeposit!(q, tx));
    expect(e.message).toBe("thorchain: inbound vault rotated after quote");
    expect(refusalOf(e)).toEqual({reason: "vault_mismatch"});
    nodes[QUOTE]!.inbound = inbound();
    e = await rejection(p.preflightDeposit!(q, {...tx, to: BASE_ROUTER}));
    expect(e.message).toBe("thorchain: router rotated after quote");
    expect(refusalOf(e)).toEqual({reason: "vault_mismatch"});
  });

  it("the router call: another vault is vault_mismatch, any other change policy_refused", async () => {
    const {p, q, tx} = await quoted();
    const expiry = BigInt(q.providerData!.expiry!);
    let e = await rejection(p.preflightDeposit!(q, {...tx, data: depositCall(OTHER_VAULT, BigInt(q.sourceAmount), CANONICAL, expiry)}));
    expect(e.message).toBe("thorchain: calldata does not match the validated quote");
    expect(refusalOf(e)).toEqual({reason: "vault_mismatch"});
    e = await rejection(p.preflightDeposit!(q, {...tx, data: depositCall(VAULT, BigInt(q.sourceAmount) * 2n, CANONICAL, expiry)}));
    expect(e.message).toBe("thorchain: calldata does not match the validated quote");
    expect(refusalOf(e)).toEqual({reason: "policy_refused"});
    const {data: _data, ...noData} = tx;
    e = await rejection(p.preflightDeposit!(q, noData));
    expect(e.message).toBe("thorchain: missing depositWithExpiry calldata");
    expect(refusalOf(e)).toEqual({reason: "policy_refused"});
    e = await rejection(p.preflightDeposit!(q, {...tx, data: "0xdeadbeef"}));
    expect(e.message).toBe("thorchain: malformed depositWithExpiry calldata");
    expect(refusalOf(e)).toEqual({reason: "policy_refused"});
    e = await rejection(p.preflightDeposit!(q, {...tx, approvalAddress: ROUTER}));
    expect(e.message).toBe("thorchain: value/approval does not match the validated source asset");
    expect(refusalOf(e)).toEqual({reason: "policy_refused"});
  });

  it("vault_mismatch: a token approval for another spender", async () => {
    const {p, q, tx} = await quoted(provider(), {sourceToken: "USDC", amountIn: "100000000"});
    expect(tx.approvalAddress).toBe(ROUTER);
    const e = await rejection(p.preflightDeposit!(q, {...tx, approvalAddress: ATTACKER}));
    expect(e.message).toBe("thorchain: value/approval does not match the validated source asset");
    expect(refusalOf(e)).toEqual({reason: "vault_mismatch"});
  });

  it("the second-node check before broadcast: vault_mismatch, stale_node, upstream_unavailable", async () => {
    const {p, q, tx} = await quoted();
    nodes[CONFIRM]!.inbound = inbound({eth: {address: OTHER_VAULT}});
    // The quoting node still names the quoted vault; the confirming node names another and holds no such vault.
    let e = await rejection(p.preflightDeposit!(q, tx));
    expect(e.message).toBe("thorchain: a second node reports another inbound vault — refused until they agree");
    expect(refusalOf(e)).toEqual({reason: "vault_mismatch"});
    nodes[CONFIRM] = node({height: LIVE_HEIGHT - 100});
    e = await rejection(p.preflightDeposit!(q, tx));
    expect(e.message).toBe("thorchain: no confirming node is within 50 blocks of the quoting node's THORChain height (behind or unreachable) — refused until one catches up");
    expect(refusalOf(e)).toEqual({reason: "stale_node"});
    nodes[CONFIRM] = node({fail: "network"});
    e = await rejection(p.preflightDeposit!(q, tx));
    expect(e.message).toBe("thorchain: no second node answered to confirm the inbound vault (configure confirmNodeUrl)");
    expect(refusalOf(e)).toEqual({reason: "upstream_unavailable"});
  });

  it("the second-node check before broadcast: chain_halted, rate_limited (every confirming node throttled)", async () => {
    const {p, q, tx} = await quoted();
    nodes[CONFIRM]!.inbound = inbound({btc: {halted: true}});
    let e = await rejection(p.preflightDeposit!(q, tx));
    expect(Object.getPrototypeOf(e)).toBe(Error.prototype);
    expect(e.message).toBe("thorchain: BTC is halted / paused on the confirming node");
    expect(refusalOf(e)).toEqual({reason: "chain_halted"});
    nodes[CONFIRM] = node({fail: {status: 429, headers: {"retry-after": "9"}}});
    nodes[LIQUIFY] = node({fail: {status: 429, headers: {"retry-after": "9"}}});
    nodes[IBS] = node({fail: {status: 429, headers: {"retry-after": "15"}}});
    e = await rejection(p.preflightDeposit!(q, tx));
    expect(Object.getPrototypeOf(e)).toBe(Error.prototype);
    expect(e.message).toBe("thorchain: no second node answered to confirm the inbound vault (configure confirmNodeUrl)");
    expect(refusalOf(e)).toEqual({reason: "rate_limited", retryAfterMs: 9_000});
  });

  it("rate_limited / upstream_unavailable: the snapshot cannot be refreshed from any node", async () => {
    const {p, q, tx} = await quoted();
    nodes[QUOTE]!.fail = {status: 429, headers: {"retry-after": "7"}};
    let e = await rejection(p.preflightDeposit!(q, tx));
    expect(e.message).toBe("thorchain: cannot refresh inbound addresses before broadcast");
    expect(refusalOf(e)).toEqual({reason: "rate_limited", retryAfterMs: 7_000});
    nodes[QUOTE] = node({answer: {"/thorchain/lastblock": () => new Response("down", {status: 502})}});
    e = await rejection(p.preflightDeposit!(q, tx));
    expect(e.message).toBe("thorchain: cannot read THORChain height (/thorchain/lastblock) before broadcast from any node that answered the inbound addresses");
    expect(refusalOf(e)).toEqual({reason: "upstream_unavailable", httpStatus: 502});
  });

  it("a Tron deposit: another recipient is vault_mismatch, another amount or a non-plain send policy_refused, dust amount_too_small", async () => {
    nodes[QUOTE]!.quote = {status: 200, body: tronQuote()};
    const {p, q, tx} = await quoted(provider({tronSource: true}), {}, tronParams);
    expect(tx).toEqual({chain: TRON, to: TRON_VAULT, value: "50000000", memo: `=:ETH.ETH:${ETH_DEST}:2014026`});
    let e = await rejection(p.preflightDeposit!(q, {...tx, to: TRON_OTHER}));
    expect(e.message).toBe("thorchain: deposit does not match the validated quote");
    expect(refusalOf(e)).toEqual({reason: "vault_mismatch"});
    e = await rejection(p.preflightDeposit!(q, {...tx, value: "1"}));
    expect(e.message).toBe("thorchain: deposit does not match the validated quote");
    expect(refusalOf(e)).toEqual({reason: "policy_refused"});
    e = await rejection(p.preflightDeposit!(q, {...tx, data: "0x"}));
    expect(e.message).toBe("thorchain: deposit-address execution must be a plain send with memo");
    expect(refusalOf(e)).toEqual({reason: "policy_refused"});
    nodes[QUOTE]!.inbound = inbound({tron: {dust_threshold: "99999999999"}});
    e = await rejection(p.preflightDeposit!(q, tx));
    expect(e.message).toBe("thorchain: amount at or below THORChain dust threshold");
    expect(refusalOf(e)).toEqual({reason: "amount_too_small"});
  });
});

describe("thorchainPins: reasonOf classifies each text verifyBuild returns", () => {
  const pins = () => thorchainPins({nodeUrl: [CONFIRM, CONFIRM2]});
  beforeEach(() => {
    nodes[CONFIRM2] = node();
  });
  /** verifyBuild's text and its reason for a build changed by `build`; `after` changes the nodes once the quote is in hand. */
  async function verdict(
    build: (b: {q: Quote; tx: UnsignedTx}) => {q?: Quote; tx?: UnsignedTx; p?: QuoteParams | undefined},
    after?: () => void,
  ): Promise<{text: string | null; info: Swap2RefusalInfo | undefined}> {
    const {q, tx} = await quoted();
    after?.();
    const b = build({q, tx});
    const pin = pins();
    const text = await pin.verifyBuild(b.q ?? q, b.tx ?? tx, "p" in b ? b.p : params());
    return {text, info: text === null ? undefined : pin.reasonOf?.(text)};
  }
  const withMemo = (tx: UnsignedTx, q: Quote, memo: string, vault = VAULT): UnsignedTx => ({...tx, data: depositCall(vault, BigInt(q.sourceAmount), memo, BigInt(q.providerData!.expiry!))});

  it("a confirmed build passes; a text these pins did not produce has no reason", async () => {
    expect(await verdict(() => ({}))).toEqual({text: null, info: undefined});
    expect(pins().reasonOf?.("something else")).toBeUndefined();
  });

  it("policy_refused / unsupported_pair: the request unknown, an unknown asset", async () => {
    expect(await verdict(() => ({p: undefined}))).toEqual({text: "the request this quote answered is unknown", info: {reason: "policy_refused"}});
    expect(await verdict(() => ({p: params({destChain: "solana:mainnet", destToken: SOL_USDC})}))).toEqual({text: "unknown source or destination asset", info: {reason: "unsupported_pair"}});
  });

  it("vault_mismatch: a router that is not pinned, a vault no node confirms", async () => {
    expect(await verdict(({tx}) => ({tx: {...tx, to: ATTACKER}}))).toEqual({text: `router ${ATTACKER} is not pinned`, info: {reason: "vault_mismatch"}});
    expect(await verdict(({q, tx}) => ({tx: withMemo(tx, q, CANONICAL, OTHER_VAULT)}))).toEqual({
      text: `a THORNode reports another inbound vault than ${OTHER_VAULT}`, info: {reason: "vault_mismatch"},
    });
  });

  it("the memo: recipient_mismatch, recipient_unverifiable, price_check_failed, policy_refused", async () => {
    const notPaying = `the memo does not pay ${BTC_DEST} in BTC.BTC with this app's refund and affiliate`;
    expect(await verdict(({q, tx}) => ({tx: withMemo(tx, q, `=:BTC.BTC:${BTC_OTHER}:95000`)}))).toEqual({text: notPaying, info: {reason: "recipient_mismatch"}});
    expect(await verdict(({q, tx}) => ({tx: withMemo(tx, q, `${CANONICAL}|0x1:2`)}))).toEqual({text: notPaying, info: {reason: "recipient_unverifiable"}});
    expect(await verdict(({q, tx}) => ({tx: withMemo(tx, q, `${CANONICAL}/3/0`)}))).toEqual({text: notPaying, info: {reason: "price_check_failed"}});
    expect(await verdict(({q, tx}) => ({tx: withMemo(tx, q, `=:b:${BTC_DEST}:95000`)}))).toEqual({text: `the memo is not the canonical ${CANONICAL}`, info: {reason: "policy_refused"}});
    expect(await verdict(({q}) => ({q: {...q, minDestAmount: "96000"}}))).toEqual({text: "the memo's limit 95000 is below the quoted minimum", info: {reason: "price_check_failed"}});
  });

  it("the router call: policy_refused for no calldata or another amount", async () => {
    expect(await verdict(({tx}) => {
      const {data: _data, ...noData} = tx;
      return {tx: noData};
    })).toEqual({text: "no router calldata", info: {reason: "policy_refused"}});
    expect(await verdict(({q, tx}) => ({tx: {...tx, data: depositCall(VAULT, BigInt(q.sourceAmount) + 1n, CANONICAL, BigInt(q.providerData!.expiry!))}}))).toEqual({
      text: "the router call moves 50000000000000001, not the 50000000000000000 input", info: {reason: "policy_refused"},
    });
  });

  it("chain_halted, stale_node, upstream_unavailable: what the nodes report", async () => {
    // The halt appears once the quote is in hand: the pins' nodes report it at build time.
    expect(await verdict(() => ({}), () => { nodes[CONFIRM]!.inbound = inbound({btc: {halted: true}}); })).toEqual({text: "BTC is halted / paused", info: {reason: "chain_halted"}});
    nodes[CONFIRM] = node();
    nodes[CONFIRM2]!.height = LIVE_HEIGHT - 100;
    expect(await verdict(() => ({}))).toEqual({
      text: "two THORNodes within 50 blocks of the highest THORChain height they report could not confirm the inbound vault (behind or unreachable)",
      info: {reason: "stale_node"},
    });
    nodes[CONFIRM2] = node({fail: {status: 503}});
    expect(await verdict(() => ({}))).toEqual({text: "two THORNodes could not confirm the inbound vault", info: {reason: "upstream_unavailable", httpStatus: 503}});
  });

  it("rate_limited: the node that could not confirm throttled (with its Retry-After), on its head or on its vault reads", async () => {
    nodes[CONFIRM2] = node({fail: {status: 429, headers: {"retry-after": "12"}}});
    expect(await verdict(() => ({}))).toEqual({text: "two THORNodes could not confirm the inbound vault", info: {reason: "rate_limited", retryAfterMs: 12_000}});
    // Its head answers, but it names another current vault and then throttles the vault list it is asked next.
    nodes[CONFIRM2] = node({
      inbound: inbound({eth: {address: OTHER_VAULT}}),
      answer: {"/thorchain/vaults/asgard": () => new Response("{}", {status: 429, headers: {"retry-after": "4"}})},
    });
    expect(await verdict(() => ({}))).toEqual({text: "two THORNodes could not confirm the inbound vault", info: {reason: "rate_limited", retryAfterMs: 4_000}});
    // A node that throttled next to one that failed otherwise (once the quote is in hand): upstream_unavailable.
    expect(await verdict(() => ({}), () => { nodes[CONFIRM] = node({fail: {status: 503}}); })).toEqual({
      text: "two THORNodes could not confirm the inbound vault", info: {reason: "upstream_unavailable"},
    });
  });

  it("vault_mismatch: a node listing the vault as not active, its mimir flagging it, another router", async () => {
    const retiring = () => { Object.assign(nodes[CONFIRM]!, retiringVault()); };
    expect(await verdict(() => ({}), retiring)).toEqual({text: "a THORNode lists the inbound vault as RetiringVault, not ActiveVault", info: {reason: "vault_mismatch"}});
    nodes[CONFIRM] = node();
    const flagged = () => { Object.assign(nodes[CONFIRM]!, compromisedVault()); };
    expect(await verdict(() => ({}), flagged)).toEqual({text: "a THORNode's mimir flags the inbound vault as compromised", info: {reason: "vault_mismatch"}});
    nodes[CONFIRM] = node();
    const rerouted = () => { nodes[CONFIRM]!.inbound = inbound({eth: {router: BASE_ROUTER}}); };
    expect(await verdict(() => ({}), rerouted)).toEqual({text: "a THORNode reports another router", info: {reason: "vault_mismatch"}});
  });

  it("policy_refused: undecodable router calldata, a call moving another asset, a Tron deposit without its memo", async () => {
    expect(await verdict(({tx}) => ({tx: {...tx, data: "0xdeadbeef"}}))).toEqual({text: "the router calldata does not decode", info: {reason: "policy_refused"}});
    const token = "0x3333333333333333333333333333333333333333";
    expect(await verdict(({q, tx}) => ({
      tx: {...tx, data: encodeFunctionData({abi: ROUTER_ABI, functionName: "depositWithExpiry", args: [VAULT, token, BigInt(q.sourceAmount), CANONICAL, BigInt(q.providerData!.expiry!)]})},
    }))).toEqual({text: `the router call moves ${token}, not the source asset`, info: {reason: "policy_refused"}});
    nodes[QUOTE]!.quote = {status: 200, body: tronQuote()};
    const {q, tx} = await quoted(provider({tronSource: true}), {}, tronParams);
    const {memo: _memo, ...noMemo} = tx;
    const pin = pins();
    const text = await pin.verifyBuild(q, noMemo, tronParams());
    expect(text).toBe("the deposit is not a send of the input with a memo");
    expect(pin.reasonOf?.(text!)).toEqual({reason: "policy_refused"});
  });

  it("a remote stub's refused build carries the pins' reason", async () => {
    const {q, tx} = await quoted();
    const backend = (async (url: string) => {
      const action = String(url).split("/").pop();
      const body = action === "quote" ? q : action === "build" ? {...tx, to: ATTACKER} : {};
      return new Response(JSON.stringify(body), {status: 200, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
    const stub = remoteProvider({name: "thorchain", baseUrl: "https://backend.invalid/api/swap2", fetchImpl: backend, ...pins()});
    const remoteQuote = (await stub.getQuote(params()))!;
    const e = await rejection(stub.buildDeposit(remoteQuote));
    expect(e.message).toBe(`thorchain: the build fails this app's own check — router ${ATTACKER} is not pinned`);
    expect(refusalOf(e)).toEqual({reason: "vault_mismatch"});
  });
});

describe("not refusals: left unclassified", () => {
  it("configuration errors", () => {
    const thrown = (make: () => unknown): unknown => {
      try {
        make();
      } catch (error) {
        return error;
      }
      throw new Error("expected a throw");
    };
    for (const make of [
      () => thorchainProvider({affiliate: "t"}),
      () => thorchainProvider({nodeUrl: "not a url"}),
      () => thorchainProvider({confirmTimeoutMs: 99}),
      () => thorchainPins({nodeUrl: "http://thor.invalid"}),
    ]) {
      const error = thrown(make);
      expect(error).toBeInstanceOf(Error);
      expect(refusalOf(error)).toBeUndefined();
    }
  });

  it("the caller's own abort is not upstream_unavailable", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const seen: Seen[] = [];
    const e = await rejection(provider().getQuote(params({onRefusal: (text, info) => { seen.push({text, info}); }}), ctrl.signal));
    expect(e.name).toBe("AbortError");
    expect(refusalOf(e)).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("the caller's abort while the quote's body is still being read is not upstream_unavailable", async () => {
    const cases: [number, string, Swap2RefusalInfo | undefined][] = [
      [200, `thorchain: incomplete quote from ${QUOTE} (expected_amount_out / inbound_address / memo / expiry missing)`, undefined],
      [404, "thorchain: HTTP 404", undefined],
      // The status arrived before the abort and classifies on its own.
      [401, "thorchain: HTTP 401", {reason: "key_rejected", httpStatus: 401}],
    ];
    for (const [status, text, info] of cases) {
      const ctrl = new AbortController();
      nodes[QUOTE]!.answer = {"/thorchain/quote/swap": () => {
        // The headers are in; the body stalls and fails once the caller aborts.
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("{\"expected_amount_out\":"));
            ctrl.signal.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
          },
        });
        setTimeout(() => ctrl.abort(), 5);
        return new Response(body, {status});
      }};
      const seen: Seen[] = [];
      await expect(provider().getQuote(params({onRefusal: (t, i) => { seen.push({text: t, info: i}); }}), ctrl.signal)).resolves.toBeNull();
      expect(ctrl.signal.aborted).toBe(true);
      expect(seen).toEqual([{text, info}]);
    }
  });

  it("a malformed source hash (a programming error)", async () => {
    const e = await rejection(provider().trackIntent({intentId: "thor", sourceTxHash: "0xabc"}));
    expect(e.message).toBe("thorchain: source transaction hash must be 32-byte hex");
    expect(refusalOf(e)).toBeUndefined();
  });
});
