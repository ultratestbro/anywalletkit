// CS-13: refusal reasons. Every CCTP refusal keeps its text; `reason` classifies it. The real provider and pins run
// against the fake Circle API + JSON-RPC of fixtures.ts — no network, no keys.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeFunctionData, pad, type Hex} from "viem";
import {refusalOf, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {cctpPins, cctpProvider, cctpVerifyQuote} from "../src/provider.js";
import {CCTP_DOMAINS, FINALITY_FAST, MESSAGE_TRANSMITTER_V2} from "../src/config.js";
import {MESSENGER_ABI, make, world} from "./fixtures.js";

// One chain whose catalog USDC is not Circle's (Unichain here, in this file only): the provider must refuse it.
const NOT_CIRCLE = "0x00000000000000000000000000000000000000aa";
vi.mock("@anywalletkit/swap2-assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anywalletkit/swap2-assets")>();
  return {
    ...actual,
    ccAsset: (chain: string, symbol: string) =>
      chain === "eip155:130" && symbol === "USDC" ? {...actual.ccAsset(chain, symbol), symbol: "USDC", contract: NOT_CIRCLE} : actual.ccAsset(chain, symbol),
  };
});

const ARB = CCTP_DOMAINS["eip155:42161"]!;
const SENDER = "0x4444444444444444444444444444444444444444";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const SRC_TX = "0x" + "ab".repeat(32);
const NONCE = ("0x" + "11".repeat(32)) as Hex;
const PARAMS: QuoteParams = {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: ARB.usdc, amountIn: "10000000", destAddress: RECIPIENT, refundAddress: SENDER, slippageBps: 0};
const REF = {intentId: `cctp:6:3:${FINALITY_FAST}`, sourceTxHash: SRC_TX};
const FEES_PATH = "/v2/burn/USDC/fees/6/3";

afterEach(() => vi.unstubAllGlobals());

/** One getQuote through the real provider: the quote, and the single refusal it heard (text + classification). */
async function quote(p: ReturnType<typeof cctpProvider>, params: QuoteParams = PARAMS, signal?: AbortSignal) {
  const heard: {text: string; info: Swap2RefusalInfo | undefined; args: number}[] = [];
  const q = await p.getQuote({...params, onRefusal: (...args: [string, Swap2RefusalInfo?]) => { heard.push({text: args[0], info: args[1], args: args.length}); }}, signal);
  expect(heard.length).toBeLessThanOrEqual(1);
  return {q, text: heard[0]?.text, info: heard[0]?.info, args: heard[0]?.args, heard: heard.length};
}

/** The fixtures' Circle API with one path answered differently. */
function circle(path: string, answer: () => Response | Promise<Response>, o: Parameters<typeof world>[0] = {}, cfg: Record<string, unknown> = {}) {
  const w = world(o);
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    return url.startsWith(`https://iris.test${path}`) ? answer() : w.fetchImpl(input, init);
  }) as typeof fetch;
  return cctpProvider({apiUrl: "https://iris.test", fetchImpl, rpcUrls: {"eip155:8453": "http://rpc.base", "eip155:42161": "http://rpc.arb"}, ...cfg});
}

/** The thrown error of a promise that must reject. */
const rejection = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as Error);

describe("cctp getQuote", () => {
  it("unsupported_pair: a catalog USDC that is not Circle's, no fee list, a finality Circle does not offer", async () => {
    const catalog = await quote(make().p, {...PARAMS, sourceChain: "eip155:130"});
    expect(catalog.q).toBeNull();
    expect(catalog.text).toBe("catalog USDC on the source chain is not Circle's native USDC");
    expect(catalog.info).toEqual({reason: "unsupported_pair"});
    for (const fees of [[], undefined]) {
      const none = await quote(fees ? make({fees}).p : circle(FEES_PATH, () => new Response("", {status: 404})));
      expect(none.text).toBe("Circle publishes no fee for this pair");
      expect(none.info).toEqual({reason: "unsupported_pair"});
    }
    const std = await quote(make({fees: [{finalityThreshold: 1000, minimumFee: 1.3}]}, {mode: "standard"}).p);
    expect(std.text).toBe("Standard Transfer is not offered for this pair");
    expect(std.info).toEqual({reason: "unsupported_pair"});
    const fast = await quote(make({fees: [{finalityThreshold: 2000, minimumFee: 0}]}, {mode: "fast"}).p);
    expect(fast.text).toBe("Fast Transfer is not offered for this pair");
    expect(fast.info).toEqual({reason: "unsupported_pair"});
    const neither = await quote(make({fees: [{finalityThreshold: 1500, minimumFee: 0}]}).p);
    expect(neither.text).toBe("neither Fast nor Standard is offered");
    expect(neither.info).toEqual({reason: "unsupported_pair"});
  });

  it("upstream_unavailable: a fee answer of another shape", async () => {
    const r = await quote(make({fees: {rows: []}}).p);
    expect(r.text).toBe("Circle publishes no fee for this pair");
    expect(r.info).toEqual({reason: "upstream_unavailable"});
  });

  it("insufficient_liquidity: the Fast allowance cannot cover the burn", async () => {
    const r = await quote(make({allowance: 5}, {mode: "fast"}).p);
    expect(r.text).toBe("Fast Transfer allowance is exhausted");
    expect(r.info).toEqual({reason: "insufficient_liquidity"});
  });

  it("amount_too_small: the Fast fee takes the whole amount", async () => {
    const r = await quote(make().p, {...PARAMS, amountIn: "1"});
    expect(r.text).toBe("amount is below the Fast Transfer fee");
    expect(r.info).toEqual({reason: "amount_too_small"});
  });

  it("policy_refused: a live quote without a recipient; an address that does not parse stays unclassified", async () => {
    const live = await quote(make().p, {...PARAMS, dry: false, destAddress: ""});
    expect(live.text).toBe("a live quote needs a recipient");
    expect(live.info).toEqual({reason: "policy_refused"});
    const bad = await quote(make().p, {...PARAMS, destAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL"});
    expect(bad.text).toBe("destination must be an EVM address");
    expect(bad.info).toBeUndefined();
    expect(bad.args).toBe(1);
  });

  it("the bare nulls stay bare: a failure while quoting, or the caller's abort, says nothing (as before)", async () => {
    const down = await quote(circle(FEES_PATH, () => { throw new TypeError("fetch failed"); }));
    expect([down.q, down.heard]).toEqual([null, 0]);
    const ctrl = new AbortController();
    ctrl.abort();
    const aborted = await quote(circle(FEES_PATH, () => { throw new DOMException("This operation was aborted", "AbortError"); }), PARAMS, ctrl.signal);
    expect([aborted.q, aborted.heard]).toEqual([null, 0]);
  });
});

describe("cctp buildDeposit and preflightDeposit", () => {
  const live = async (o: Parameters<typeof world>[0] = {}) => {
    const {p} = make(o);
    const q = (await p.getQuote(PARAMS))!;
    return {p, q, tx: await p.buildDeposit(q)};
  };

  it("policy_refused: a quote with no transaction request, a malformed intent id", async () => {
    const {p, q, tx} = await live();
    const {txRequest: _tx, ...bare} = q;
    const noTx = await rejection(p.buildDeposit(bare));
    expect(noTx.constructor).toBe(Error);
    expect(noTx.message).toBe("swap2: CCTP quote has no transaction request");
    expect(refusalOf(noTx)).toEqual({reason: "policy_refused"});
    const malformed = await rejection(p.preflightDeposit!({...q, intentId: "cctp:x"}, tx));
    expect(malformed.message).toBe("cctp: malformed intent id");
    expect(refusalOf(malformed)).toEqual({reason: "policy_refused"});
  });

  it("vault_mismatch: another deposit target, a TokenMessenger pointing elsewhere, a transmitter of another domain", async () => {
    const {p, q, tx} = await live();
    const target = await rejection(p.preflightDeposit!(q, {...tx, to: RECIPIENT}));
    expect(target.message).toBe("cctp: deposit target is not the TokenMessengerV2 of the source domain");
    expect(refusalOf(target)).toEqual({reason: "vault_mismatch"});
    const pointer = await rejection(make({transmitter: ATTACKER}).p.preflightDeposit!(q, tx));
    expect(pointer.message).toBe("cctp: TokenMessengerV2 does not point at the expected MessageTransmitterV2");
    expect(refusalOf(pointer)).toEqual({reason: "vault_mismatch"});
    const domain = await rejection(make({domain: 3}).p.preflightDeposit!(q, tx));
    expect(domain.message).toBe("cctp: MessageTransmitterV2 reports domain 3, expected 6");
    expect(refusalOf(domain)).toEqual({reason: "vault_mismatch"});
  });

  it("quote_expired: Circle's Fast fee moved above the quoted maxFee, or is no longer published — re-quote", async () => {
    const {q, tx} = await live();
    const above = await rejection(make({fees: [{finalityThreshold: 1000, minimumFee: 5}]}).p.preflightDeposit!(q, tx));
    expect(above.message).toBe("cctp: Circle's Fast Transfer fee 5000 (5 bps) exceeds the quoted maxFee 1430 — re-quote");
    expect(refusalOf(above)).toEqual({reason: "quote_expired"});
    const gone = await rejection(make({fees: [{finalityThreshold: 2000, minimumFee: 0}]}).p.preflightDeposit!(q, tx));
    expect(gone.message).toBe("cctp: Circle no longer publishes a Fast Transfer fee for this pair — re-quote");
    expect(refusalOf(gone)).toEqual({reason: "quote_expired"});
  });

  it("Circle's HTTP failures through the real fetch path: 429 with Retry-After, 401 / 403 and 5xx; any other status unclassified", async () => {
    const {q, tx} = await live();
    // Circle's API takes no key: a 401 / 403 is a block in front of it (upstream_unavailable), never key_rejected.
    const cases: Array<[Response, Swap2RefusalInfo | undefined]> = [
      [new Response("slow down", {status: 429, headers: {"retry-after": "30"}}), {reason: "rate_limited", retryAfterMs: 30_000, httpStatus: 429}],
      [new Response("", {status: 401}), {reason: "upstream_unavailable", httpStatus: 401}],
      [new Response("", {status: 403}), {reason: "upstream_unavailable", httpStatus: 403}],
      [new Response("", {status: 503}), {reason: "upstream_unavailable", httpStatus: 503}],
      [new Response("", {status: 400}), undefined],
    ];
    for (const [res, info] of cases) {
      const err = await rejection(circle(FEES_PATH, () => res).preflightDeposit!(q, tx));
      expect(err.constructor).toBe(Error);
      expect(err.message).toBe(`cctp: ${FEES_PATH} → ${res.status}`);
      expect(refusalOf(err)).toEqual(info);
    }
  });

  it("upstream_unavailable: a network failure or an answer that is not JSON — the same error, tagged", async () => {
    const {q, tx} = await live();
    const net = new TypeError("fetch failed");
    const down = await rejection(circle(FEES_PATH, () => { throw net; }).preflightDeposit!(q, tx));
    expect(down).toBe(net);
    expect(down.message).toBe("fetch failed");
    expect(refusalOf(down)).toEqual({reason: "upstream_unavailable"});
    const garbled = await rejection(circle(FEES_PATH, () => new Response("<html>")).preflightDeposit!(q, tx));
    expect(garbled).toBeInstanceOf(SyntaxError);
    expect(refusalOf(garbled)).toEqual({reason: "upstream_unavailable"});
  });

  it("the source RPC: an eth_call that reverts or finds no code is simulation_failed; a node that fails is upstream_unavailable", async () => {
    const {q, tx} = await live();
    const rpc = (answer: (body: {id: number; method: string}) => Response) => {
      const w = world();
      const fetchImpl = (async (input: string, init?: RequestInit) => {
        if (String(input).startsWith("http://rpc.")) {
          const body = JSON.parse(String(init?.body)) as {id: number; method: string};
          if (body.method === "eth_call") return answer(body);
        }
        return w.fetchImpl(input, init);
      }) as typeof fetch;
      return cctpProvider({apiUrl: "https://iris.test", fetchImpl, rpcUrls: {"eip155:8453": "http://rpc.base"}});
    };
    const reverted = await rejection(rpc((b) => new Response(JSON.stringify({jsonrpc: "2.0", id: b.id, error: {code: 3, message: "execution reverted", data: "0x"}}))).preflightDeposit!(q, tx));
    expect(reverted.name).toBe("ContractFunctionExecutionError");
    expect(refusalOf(reverted)).toEqual({reason: "simulation_failed"});
    const empty = await rejection(rpc((b) => new Response(JSON.stringify({jsonrpc: "2.0", id: b.id, result: "0x"}))).preflightDeposit!(q, tx));
    expect(empty.name).toBe("ContractFunctionExecutionError");
    expect(refusalOf(empty)).toEqual({reason: "simulation_failed"});
    const down = await rejection(rpc(() => new Response("bad gateway", {status: 502})).preflightDeposit!(q, tx));
    expect(down.name).toBe("ContractFunctionExecutionError");
    expect(refusalOf(down)).toEqual({reason: "upstream_unavailable"});
  });
});

describe("cctp buildClaim", () => {
  const message = (decoded: Record<string, unknown>) => ({message: "0x" + "22".repeat(200), attestation: "0x" + "33".repeat(130), status: "complete", cctpVersion: 2, eventNonce: "9682", decodedMessage: {nonce: NONCE, ...decoded}});

  it("recipient_mismatch: an attestation minting on another domain; policy_refused: one from another source", async () => {
    const dest = await rejection(make({message: message({sourceDomain: "6", destinationDomain: "7"})}).p.buildClaim!(REF));
    expect(dest.message).toBe("cctp: attested message is for another destination domain");
    expect(refusalOf(dest)).toEqual({reason: "recipient_mismatch"});
    const source = await rejection(make({message: message({sourceDomain: "0", destinationDomain: "3"})}).p.buildClaim!(REF));
    expect(source.message).toBe("cctp: attested message is for another source domain");
    expect(refusalOf(source)).toEqual({reason: "policy_refused"});
    // The honest message still builds the claim.
    expect((await make({message: message({sourceDomain: "6", destinationDomain: "3"})}).p.buildClaim!(REF))?.to).toBe(MESSAGE_TRANSMITTER_V2);
  });

  it("upstream_unavailable: Circle's messages endpoint failing, or blocked (403: no key exists to reject)", async () => {
    const err = await rejection(circle("/v2/messages/", () => new Response("", {status: 500})).buildClaim!(REF));
    expect(err.message).toBe(`cctp: /v2/messages/6?transactionHash=${SRC_TX} → 500`);
    expect(refusalOf(err)).toEqual({reason: "upstream_unavailable", httpStatus: 500});
    const blocked = await rejection(circle("/v2/messages/", () => new Response("", {status: 403})).buildClaim!(REF));
    expect(blocked.constructor).toBe(Error);
    expect(blocked.message).toBe(`cctp: /v2/messages/6?transactionHash=${SRC_TX} → 403`);
    expect(refusalOf(blocked)).toEqual({reason: "upstream_unavailable", httpStatus: 403});
  });
});

describe("cctpPins", () => {
  const reencode = (q: Quote, index: number, value: unknown): Quote => {
    const d = decodeFunctionData({abi: MESSENGER_ABI, data: q.txRequest!.data as Hex});
    const args = [...(d.args as readonly unknown[])];
    args[index] = value;
    return {...q, txRequest: {...q.txRequest!, data: encodeFunctionData({abi: MESSENGER_ABI, functionName: "depositForBurn", args: args as never})}};
  };

  it("reasonOf classifies every text cctpVerifyQuote returns", async () => {
    const q = (await make().p.getQuote(PARAMS))!;
    expect(cctpVerifyQuote(PARAMS, q)).toBeNull();
    const {txRequest: tx0, ...bare} = q;
    const tx = tx0!;
    const cases: Array<[QuoteParams, Quote, string, Swap2RefusalInfo["reason"]]> = [
      [{...PARAMS, sourceChain: "eip155:56"}, q, "not a CCTP route between two domains", "unsupported_pair"],
      [{...PARAMS, sourceToken: "USDT"}, q, "not USDC to USDC", "unsupported_pair"],
      [PARAMS, bare, "the quote carries no TokenMessenger call", "policy_refused"],
      [PARAMS, {...q, txRequest: {...tx, to: ATTACKER}}, `the call targets ${ATTACKER}, not the TokenMessengerV2`, "vault_mismatch"],
      [PARAMS, {...q, txRequest: {...tx, value: "1"}}, "a burn attaches no value", "policy_refused"],
      [PARAMS, {...q, txRequest: {...tx, approvalAddress: ATTACKER}}, "the burn approves another spender than the TokenMessengerV2", "vault_mismatch"],
      [PARAMS, {...q, txRequest: {...tx, chainId: 1}}, "the call is for chain 1, not 8453", "policy_refused"],
      [PARAMS, {...q, txRequest: {...tx, data: encodeFunctionData({abi: MESSENGER_ABI, functionName: "localMessageTransmitter"})}}, "localMessageTransmitter is not depositForBurn", "policy_refused"],
      [PARAMS, {...q, txRequest: {...tx, data: "0xdeadbeef"}}, "the call is not depositForBurn", "policy_refused"],
      [PARAMS, {...q, minDestAmount: "most"}, "the request does not name amounts", "upstream_unavailable"],
      [{...PARAMS, amountIn: "20000000"}, q, "the burn moves 10000000, not the 20000000 input", "policy_refused"],
      [{...PARAMS, destChain: "eip155:10", destToken: "USDC"}, q, "the burn mints on domain 3, not OP Mainnet (2)", "recipient_mismatch"],
      [{...PARAMS, destAddress: ATTACKER}, q, `the burn mints to ${pad(RECIPIENT, {size: 32})}, not the recipient`, "recipient_mismatch"],
      [PARAMS, reencode(q, 3, ATTACKER), `the burn spends ${ATTACKER}, not the source domain's USDC`, "policy_refused"],
      [PARAMS, reencode(q, 4, pad(ATTACKER, {size: 32})), "the burn names a destination caller", "policy_refused"],
      [PARAMS, reencode(q, 6, 1500), "finality threshold 1500 is neither Fast nor Standard", "policy_refused"],
      [PARAMS, reencode(q, 5, 10_000_000n), "the burn's maxFee 10000000 leaves less than the 9998570 minimum", "price_check_failed"],
      [PARAMS, {...q, intentId: "cctp:6:3:2000"}, "the intent id does not name this burn", "policy_refused"],
      [PARAMS, {...q, providerData: {...q.providerData, maxFee: "1"}}, "the quoted maxFee is not the burn's", "policy_refused"],
    ];
    for (const [params, quoted, text, reason] of cases) {
      const got = cctpVerifyQuote(params, quoted);
      expect(got, text).toBe(text);
      expect(cctpPins.reasonOf!(got!), text).toEqual({reason});
    }
    // A recipient that does not parse is the caller's argument: the text, unclassified.
    const bad = cctpVerifyQuote({...PARAMS, destAddress: "not-an-address"}, q);
    expect(bad).toBe("the recipient is not an EVM address");
    expect(cctpPins.reasonOf!(bad!)).toBeUndefined();
  });

  it("a remote stub's refusal carries the pins' reason, its text unchanged", async () => {
    const q = (await make().p.getQuote(PARAMS))!;
    const stub = remoteProvider({name: "cctp", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl: (async () => new Response(JSON.stringify(q))) as unknown as typeof fetch, ...cctpPins});
    const err = await rejection(stub.getQuote({...PARAMS, destAddress: ATTACKER}));
    expect(err.message).toBe(`cctp: the quote fails this app's own check — the burn mints to ${pad(RECIPIENT, {size: 32})}, not the recipient`);
    expect(refusalOf(err)).toEqual({reason: "recipient_mismatch"});
    expect(await stub.getQuote(PARAMS)).toMatchObject({intentId: q.intentId});
  });
});

describe("configuration is not a refusal", () => {
  it("constructor option errors throw unclassified", () => {
    for (const cfg of [{apiUrl: "ftp://iris.test"}, {mode: "slow"}, {feeBufferPct: 500}, {quoteTtlMs: 0}]) {
      let err: unknown;
      try { cctpProvider(cfg as never); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(Error);
      expect(refusalOf(err)).toBeUndefined();
    }
  });
});
