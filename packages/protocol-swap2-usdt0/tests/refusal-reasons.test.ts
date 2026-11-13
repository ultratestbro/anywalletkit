// CS-13: refusal reasons for USDT0 (OFT sends and the Legacy Mesh). Every refusal keeps its text byte for byte;
// `reason` classifies it. The provider runs its real code paths over the fake JSON-RPC, LayerZero Scan and tonapi
// behind one injected fetch (fixtures.ts, mesh-fixtures.ts): viem's real HTTP transport turns the fake endpoints'
// statuses into its own errors, and the remote stub runs the real provider behind the real swap2 handler. No network,
// no keys.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeFunctionData, pad, type Hex} from "viem";
import {refusalOf, Swap2QuoteError, type Swap2RefusalInfo, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import * as config from "../src/config.js";
import {USDT0_MESH_PLACEHOLDER, usdt0Pins, usdt0VerifyQuote} from "../src/config.js";
import {usdt0Provider} from "../src/provider.js";
import {Usdt0Swap2Protocol} from "../src/protocol.js";
import {ARB, HYPE, OFT_ABI, PARAMS, RECIPIENT, RPC, SEALED, SENDER, SRC_TX, GUID, PAYLOAD, make as oftMake, world, type World} from "./fixtures.js";
import {
  ABI as MESH_ABI, ARB as MARB, ATTACKER, TON, TON_TO_RAW, TO_TON, TO_TRON, TRON, TRON_TO, make as meshMake, sealedOf, FEE_TRON, type MeshWorld,
} from "./mesh-fixtures.js";

// The provider's own self-check of a Legacy Mesh send it built (usdt0VerifyMeshSend) cannot fail on a real build; this
// hook lets one test hand it a request that differs, so the refusal it raises is the real one, noted by the real check.
const hooks = vi.hoisted(() => ({meshCheck: null as null | ((params: QuoteParams) => QuoteParams)}));
vi.mock("../src/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...real,
    usdt0VerifyMeshSend: (params: QuoteParams, ...rest: [Quote, config.Usdt0MeshSource, config.Usdt0MeshDestination]) =>
      real.usdt0VerifyMeshSend(hooks.meshCheck ? hooks.meshCheck(params) : params, ...rest),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  hooks.meshCheck = null;
});

const ZERO_EVM = "0x0000000000000000000000000000000000000000";
const ZERO_TEXT = "destination is the zero account — nothing sent there can be recovered";
const OFT: QuoteParams = {...PARAMS, dry: false};

type Got = [string, Swap2RefusalInfo | null];
/** onRefusal's calls: each text with the classification next to it (`null` = a call with the text only). */
function recorder() {
  const got: Got[] = [];
  return {got, onRefusal: (...args: [string, Swap2RefusalInfo?]) => { got.push([args[0], args.length > 1 ? args[1]! : null]); }};
}
async function oftRefusals(params: Partial<QuoteParams>, w: World = {}, cfg: Record<string, unknown> = {}): Promise<Got[]> {
  const {p} = oftMake(w, cfg);
  const r = recorder();
  expect(await p.getQuote({...OFT, ...params, onRefusal: r.onRefusal})).toBeNull();
  return r.got;
}
async function meshRefusals(params: Partial<QuoteParams>, w: MeshWorld = {}, base: QuoteParams = TO_TRON, cfg: Record<string, unknown> = {}): Promise<Got[]> {
  const {p} = meshMake(w, cfg);
  const r = recorder();
  expect(await p.getQuote({...base, ...params, onRefusal: r.onRefusal})).toBeNull();
  return r.got;
}
/** The error a promise rejects with; a promise that resolves fails the test. */
async function rejection<E = Error>(p: Promise<unknown>): Promise<E> {
  return p.then((v) => { throw new Error(`expected a rejection, got ${String(v)}`); }, (e: unknown) => e as E);
}
/** A plain Error (class and name kept) with exactly `text` and the reason. */
function expectRefusal(err: Error, text: string, info: Swap2RefusalInfo) {
  expect(err).toBeInstanceOf(Error);
  expect(err.constructor).toBe(Error);
  expect(err.name).toBe("Error");
  expect(err.message).toBe(text);
  expect(refusalOf(err)).toEqual(info);
}
/** A provider whose fake endpoint at `url` answers `answer` (the rest of the world as fixtures.ts / mesh-fixtures.ts serve it). */
function intercept(base: typeof fetch, prefix: string, answer: (init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    return url.startsWith(prefix) ? answer(init) : base(input, init);
  }) as typeof fetch;
}
const KEYED = "http://rpc.arb.example/key-placeholder/";
/** Arbitrum's RPC replaced by a keyed endpoint that answers `answer`. */
const failingRpc = (answer: (init?: RequestInit) => Response | Promise<Response>) =>
  usdt0Provider({scanUrl: "https://scan.test", fetchImpl: intercept(world().fetchImpl, KEYED, answer), rpcUrls: {...RPC, "eip155:42161": KEYED}});
const RPC_DOWN = "usdt0: RPC for Arbitrum unavailable — try again";
/** A JSON-RPC answer to the request in `init` (`status` 200 unless given). */
const rpcAnswer = (init: RequestInit | undefined, answer: object, status = 200, headers: Record<string, string> = {}) => {
  const {id} = JSON.parse(String(init?.body)) as {id: number};
  return new Response(JSON.stringify({jsonrpc: "2.0", id, ...answer}), {status, headers: {"content-type": "application/json", ...headers}});
};
/** A provider whose OFT answers `answer` to the eth_call of `fn` (the rest of the world as fixtures.ts serves it). */
function oftCallAnswers(fn: string, answer: (init?: RequestInit) => Response): ReturnType<typeof usdt0Provider> {
  const base = world().fetchImpl;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as {method: string; params: [{data?: Hex}]} : undefined;
    if (body?.method === "eth_call") {
      let name = "";
      try { name = decodeFunctionData({abi: OFT_ABI, data: body.params[0].data!}).functionName; } catch { /* not an OFT call */ }
      if (name === fn) return answer(init);
    }
    return base(input, init);
  }) as typeof fetch;
  return usdt0Provider({scanUrl: "https://scan.test", fetchImpl, rpcUrls: RPC});
}

/** Re-encode one field of a Legacy Mesh quote's send. */
function edit(q: Quote, f: (sp: Record<string, unknown>, rest: {fee: {nativeFee: bigint; lzTokenFee: bigint}; refund: string}) => void): Quote {
  const d = decodeFunctionData({abi: MESH_ABI, data: q.txRequest!.data as Hex});
  const [sp0, fee, refund] = d.args as unknown as [Record<string, unknown>, {nativeFee: bigint; lzTokenFee: bigint}, string];
  const sp = {...sp0};
  const rest = {fee: {...fee}, refund};
  f(sp, rest);
  return {...q, txRequest: {...q.txRequest!, data: encodeFunctionData({abi: MESH_ABI, functionName: "send", args: [sp as never, rest.fee, rest.refund as Hex]})}};
}

describe("getQuote (OFT send): each refusal carries its reason next to the unchanged text", () => {
  it("unsupported_pair: flexible amounts, chains without USDT0, the same chain, other tokens, no RPC, an LZ-token fee", async () => {
    expect(await oftRefusals({flex: true})).toEqual([["the amount is sealed into the calldata (no flexible deposits)", {reason: "unsupported_pair"}]]);
    expect(await oftRefusals({sourceChain: "eip155:8453"})).toEqual([["USDT0 is not deployed on this chain", {reason: "unsupported_pair"}]]);
    expect(await oftRefusals({sourceChain: "tron:728126428", sourceToken: "USDT"})).toEqual([["USDT0 is not deployed on this chain", {reason: "unsupported_pair"}]]);
    expect(await oftRefusals({destChain: "eip155:42161", destToken: ARB.token})).toEqual([["same-chain transfers are not a bridge", {reason: "unsupported_pair"}]]);
    expect(await oftRefusals({sourceToken: "USDC"})).toEqual([[`source token USDC is not USDT0 (${ARB.token}) on Arbitrum`, {reason: "unsupported_pair"}]]);
    expect(await oftRefusals({destToken: ZERO_EVM})).toEqual([[`destination token ${ZERO_EVM} is not USDT0 (${HYPE.token}) on HyperEVM`, {reason: "unsupported_pair"}]]);
    expect(await oftRefusals({sourceChain: "eip155:137", sourceToken: "USDT"})).toEqual([["no RPC configured for eip155:137", {reason: "unsupported_pair"}]]);
    expect(await oftRefusals({}, {lzTokenFee: 1n})).toEqual([["OFT asks for a fee in LZ token — unsupported", {reason: "unsupported_pair"}]]);
  });

  it("amount_too_small / amount_too_large: zero, the OFT's limits, dust", async () => {
    expect(await oftRefusals({amountIn: "0"})).toEqual([["amount must be positive", {reason: "amount_too_small"}]]);
    expect(await oftRefusals({}, {minAmount: 20_000_000n})).toEqual([["amount 10000000 is below the OFT minimum 20000000", {reason: "amount_too_small"}]]);
    expect(await oftRefusals({}, {maxAmount: 5n})).toEqual([["amount 10000000 exceeds the OFT maximum 5", {reason: "amount_too_large"}]]);
    expect(await oftRefusals({amountIn: "5"}, {received: () => 0n})).toEqual([["amount is below the OFT dust threshold — nothing would arrive", {reason: "amount_too_small"}]]);
  });

  it("price_check_failed: the caller's floor above the output, an OFT that pays out more than it takes", async () => {
    expect(await oftRefusals({minAmountOut: "10000001"})).toEqual([["received 10000000 is below the caller's floor 10000001", {reason: "price_check_failed"}]]);
    expect(await oftRefusals({}, {received: (a) => a + 1n})).toEqual([["OFT reports more received than sent — refusing", {reason: "price_check_failed"}]]);
  });

  it("recipient_mismatch / policy_refused: an address that cannot receive; a live quote without its addresses", async () => {
    expect(await oftRefusals({destAddress: "not-an-address"})).toEqual([["destination must be an EVM address", {reason: "recipient_mismatch"}]]);
    expect(await oftRefusals({destAddress: ZERO_EVM})).toEqual([[ZERO_TEXT, {reason: "recipient_mismatch"}]]);
    expect(await oftRefusals({refundAddress: TRON_TO})).toEqual([["refund address must be an EVM address", {reason: "recipient_mismatch"}]]);
    expect(await oftRefusals({destAddress: ""})).toEqual([["a live quote needs a recipient", {reason: "policy_refused"}]]);
    expect(await oftRefusals({refundAddress: ""})).toEqual([["a live quote needs a refund address", {reason: "policy_refused"}]]);
  });

  it("vault_mismatch / unsupported_pair: the chain contradicts a pinned address; a peer that is not wired at all", async () => {
    expect(await oftRefusals({}, {token: RECIPIENT})).toEqual([[`usdt0: OFT ${ARB.oft} on Arbitrum reports token ${RECIPIENT}, expected ${ARB.token}`, {reason: "vault_mismatch"}]]);
    expect(await oftRefusals({}, {approvalRequired: true})).toEqual([[`usdt0: OFT ${ARB.oft} on Arbitrum reports approvalRequired=true, expected false`, {reason: "vault_mismatch"}]]);
    const notWired = "usdt0: Arbitrum OFT has no peer for HyperEVM (eid 30367) — route not wired";
    expect(await oftRefusals({}, {peer: pad(RECIPIENT, {size: 32})})).toEqual([[notWired, {reason: "vault_mismatch"}]]);
    expect(await oftRefusals({}, {peer: null})).toEqual([[notWired, {reason: "unsupported_pair"}]]);
  });

  it("simulation_failed: the OFT's read reverts", async () => {
    const reverting = (base: typeof fetch): typeof fetch => (async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as {id: number; method: string; params: [{data?: Hex}]} : undefined;
      if (body?.method === "eth_call") {
        let fn = "";
        try { fn = decodeFunctionData({abi: OFT_ABI, data: body.params[0].data!}).functionName; } catch { /* not an OFT call */ }
        if (fn === "quoteOFT") return new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, error: {code: 3, message: "execution reverted"}}));
      }
      return base(input, init);
    }) as typeof fetch;
    const p = usdt0Provider({scanUrl: "https://scan.test", fetchImpl: reverting(world().fetchImpl), rpcUrls: RPC});
    const r = recorder();
    expect(await p.getQuote({...OFT, onRefusal: r.onRefusal})).toBeNull();
    expect(r.got).toHaveLength(1);
    expect(r.got[0]![0]).toMatch(/^The contract function "quoteOFT" reverted\./);
    expect(r.got[0]![0]).not.toMatch(/rpc\.arb|URL:/);
    expect(r.got[0]![1]).toEqual({reason: "simulation_failed"});
  });

  it("simulation_failed for a revert without data (-32000); upstream_unavailable for a read that returns no data", async () => {
    const reverted = recorder();
    expect(await oftCallAnswers("quoteOFT", (init) => rpcAnswer(init, {error: {code: -32000, message: "execution reverted"}})).getQuote({...OFT, onRefusal: reverted.onRefusal})).toBeNull();
    expect(reverted.got).toHaveLength(1);
    expect(reverted.got[0]![0]).toMatch(/^Execution reverted for an unknown reason\.\n/);
    expect(reverted.got[0]![0]).not.toMatch(/rpc\.arb|URL:/);
    expect(reverted.got[0]![1]).toEqual({reason: "simulation_failed"});
    const empty = recorder();
    expect(await oftCallAnswers("quoteOFT", (init) => rpcAnswer(init, {result: "0x"})).getQuote({...OFT, onRefusal: empty.onRefusal})).toBeNull();
    expect(empty.got).toHaveLength(1);
    expect(empty.got[0]![0]).toMatch(/^The contract function "quoteOFT" returned no data \("0x"\)\.\n/);
    expect(empty.got[0]![0]).not.toMatch(/rpc\.arb|URL:/);
    expect(empty.got[0]![1]).toEqual({reason: "upstream_unavailable"});
  });
});

describe("getQuote: the RPC's own failure through viem's real HTTP transport (the text stays the fixed one)", () => {
  const down = async (answer: (init?: RequestInit) => Response | Promise<Response>) => {
    const r = recorder();
    expect(await failingRpc(answer).getQuote({...OFT, onRefusal: r.onRefusal})).toBeNull();
    return r.got;
  };

  it("HTTP 429 with Retry-After → rate_limited with the wait", async () => {
    expect(await down(() => new Response("slow down", {status: 429, headers: {"retry-after": "1"}}))).toEqual([[RPC_DOWN, {reason: "rate_limited", httpStatus: 429, retryAfterMs: 1000}]]);
  });

  it("HTTP 401 / 403 → key_rejected", async () => {
    expect(await down(() => new Response("bad key", {status: 401}))).toEqual([[RPC_DOWN, {reason: "key_rejected", httpStatus: 401}]]);
    expect(await down(() => new Response("forbidden", {status: 403}))).toEqual([[RPC_DOWN, {reason: "key_rejected", httpStatus: 403}]]);
  });

  it("HTTP 5xx → upstream_unavailable with the status", async () => {
    expect(await down(() => new Response("down", {status: 500}))).toEqual([[RPC_DOWN, {reason: "upstream_unavailable", httpStatus: 500}]]);
  });

  it("a network failure → upstream_unavailable; a node's limit-exceeded answer → rate_limited", async () => {
    expect(await down(() => Promise.reject(new TypeError("fetch failed")))).toEqual([[RPC_DOWN, {reason: "upstream_unavailable"}]]);
    const limited = (init?: RequestInit) => {
      const {id} = JSON.parse(String(init?.body)) as {id: number};
      return new Response(JSON.stringify({jsonrpc: "2.0", id, error: {code: -32005, message: "limit exceeded"}}));
    };
    expect(await down(limited)).toEqual([[RPC_DOWN, {reason: "rate_limited"}]]);
  });

  it("a 429 code in the JSON-RPC answer → rate_limited, as wrap reads the same answer", async () => {
    expect(await down((init) => rpcAnswer(init, {error: {code: 429, message: "exceeded its compute units per second capacity"}}))).toEqual([[RPC_DOWN, {reason: "rate_limited"}]]);
  });

  it("a failing HTTP status with a JSON-RPC body: the status classifies it (429 with its Retry-After, 401 key_rejected)", async () => {
    const limited = (init?: RequestInit) => rpcAnswer(init, {error: {code: 429, message: "exceeded its compute units per second capacity"}}, 429, {"retry-after": "1"});
    expect(await down(limited)).toEqual([[RPC_DOWN, {reason: "rate_limited", httpStatus: 429, retryAfterMs: 1000}]]);
    const keyed = (init?: RequestInit) => rpcAnswer(init, {error: {code: -32002, message: "rejected due to project ID settings"}}, 401);
    expect(await down(keyed)).toEqual([[RPC_DOWN, {reason: "key_rejected", httpStatus: 401}]]);
  });

  it("viem's own timeout (12 s per request, retried) → upstream_unavailable", async () => {
    vi.useFakeTimers();
    try {
      // The endpoint never answers: the request ends only when viem's timeout aborts it.
      const hang = (init?: RequestInit) => new Promise<Response>((_, reject) => {
        const s = init?.signal;
        if (s?.aborted) return reject(s.reason);
        s?.addEventListener("abort", () => reject(s.reason), {once: true});
      });
      const r = recorder();
      let settled = false;
      const pending = failingRpc(hang).getQuote({...OFT, onRefusal: r.onRefusal}).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(11_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await pending).toBeNull();
      expect(r.got).toEqual([[RPC_DOWN, {reason: "upstream_unavailable"}]]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getQuote (Legacy Mesh): each refusal carries its reason next to the unchanged text", () => {
  it("unsupported_pair: other tokens, no RPC, an LZ-token fee, a peer not wired at all", async () => {
    expect(await meshRefusals({sourceToken: "USDC"})).toEqual([[`source token USDC is not USDT0 (${MARB.token}) on Arbitrum`, {reason: "unsupported_pair"}]]);
    expect(await meshRefusals({destToken: "TRX"})).toEqual([[`destination token TRX is not USDT0 (${TRON.token}) on Tron`, {reason: "unsupported_pair"}]]);
    expect(await meshRefusals({sourceChain: "eip155:1", sourceToken: "USDT"}, {}, TO_TON, {rpcUrls: {"eip155:42161": "http://rpc.arb"}})).toEqual([["no RPC configured for eip155:1", {reason: "unsupported_pair"}]]);
    expect(await meshRefusals({}, {lzTokenFee: 1n})).toEqual([["OFT asks for a fee in LZ token — unsupported", {reason: "unsupported_pair"}]]);
    expect(await meshRefusals({}, {peer: `0x${"00".repeat(32)}`})).toEqual([["usdt0: Arbitrum Legacy Mesh OFT has no pinned peer for Tron (eid 30420) — route not wired", {reason: "unsupported_pair"}]]);
  });

  it("vault_mismatch: another peer, token or approval mode than the pins", async () => {
    expect(await meshRefusals({}, {peer: pad("0x1111111111111111111111111111111111111111", {size: 32})})).toEqual([["usdt0: Arbitrum Legacy Mesh OFT has no pinned peer for Tron (eid 30420) — route not wired", {reason: "vault_mismatch"}]]);
    expect(await meshRefusals({}, {token: ATTACKER})).toEqual([[`usdt0: Legacy Mesh OFT ${MARB.oft} on Arbitrum reports token ${ATTACKER}, expected ${MARB.token}`, {reason: "vault_mismatch"}]]);
    expect(await meshRefusals({}, {approvalRequired: false})).toEqual([[`usdt0: Legacy Mesh OFT ${MARB.oft} on Arbitrum reports approvalRequired=false, expected true`, {reason: "vault_mismatch"}]]);
  });

  it("amount_too_small / insufficient_liquidity: zero, the OFT minimum, dust; the pool's credit toward the destination", async () => {
    expect(await meshRefusals({amountIn: "0"})).toEqual([["amount must be positive", {reason: "amount_too_small"}]]);
    expect(await meshRefusals({}, {oftMin: 20_000_000n})).toEqual([["amount 10000000 is below the OFT minimum 20000000", {reason: "amount_too_small"}]]);
    expect(await meshRefusals({}, {received: () => 0n})).toEqual([["amount is below the OFT dust threshold — nothing would arrive", {reason: "amount_too_small"}]]);
    expect(await meshRefusals({}, {credits: 9_999_999n})).toEqual([["amount 10000000 exceeds the OFT maximum 9999999", {reason: "insufficient_liquidity"}]]);
  });

  it("insufficient_liquidity: quoteSend reverts with InsufficientCredits (viem's text, URLs redacted)", async () => {
    const got = await meshRefusals({}, {quoteSendFails: "credits"});
    expect(got).toHaveLength(1);
    expect(got[0]![0]).toMatch(/^The contract function "quoteSend" reverted\.\n\nError: InsufficientCredits\(uint32 eid, uint256 credits, uint256 amountWithdraw\)/);
    expect(got[0]![1]).toEqual({reason: "insufficient_liquidity"});
  });

  it("price_check_failed / unsupported_pair: quoteSend reverts with SlippageExceeded / TONComposeNotSupported (viem's text, URLs redacted)", async () => {
    const slippage = await meshRefusals({}, {quoteSendFails: "slippage"});
    expect(slippage).toHaveLength(1);
    expect(slippage[0]![0]).toMatch(/^The contract function "quoteSend" reverted\.\n\nError: SlippageExceeded\(uint256 amountReceived, uint256 minAmount\)/);
    expect(slippage[0]![0]).not.toMatch(/rpc\.arb|URL:/);
    expect(slippage[0]![1]).toEqual({reason: "price_check_failed"});
    const tonCompose = await meshRefusals({}, {quoteSendFails: "tonCompose"}, TO_TON);
    expect(tonCompose).toHaveLength(1);
    expect(tonCompose[0]![0]).toMatch(/^The contract function "quoteSend" reverted\.\n\nError: TONComposeNotSupported\(\)/);
    expect(tonCompose[0]![0]).not.toMatch(/rpc\.arb|URL:/);
    expect(tonCompose[0]![1]).toEqual({reason: "unsupported_pair"});
  });

  it("price_check_failed: the caller's floor, an OFT that pays out more than it takes", async () => {
    expect(await meshRefusals({minAmountOut: "9997001"})).toEqual([["received 9997000 is below the caller's floor 9997001", {reason: "price_check_failed"}]]);
    expect(await meshRefusals({}, {received: (a) => a + 1n})).toEqual([["OFT reports more received than sent — refusing", {reason: "price_check_failed"}]]);
  });

  it("recipient_mismatch / policy_refused: recipients the destination cannot pay, the zero account; missing live addresses", async () => {
    expect(await meshRefusals({destAddress: SENDER})).toEqual([["destination must be a Tron address (base58check T…)", {reason: "recipient_mismatch"}]]);
    expect(await meshRefusals({destAddress: TRON_TO}, {}, TO_TON)).toEqual([["destination must be a TON address (raw 0:… or user-friendly EQ…/UQ…)", {reason: "recipient_mismatch"}]]);
    expect(await meshRefusals({destAddress: `-1:${TON_TO_RAW.slice(2)}`}, {}, TO_TON)).toEqual([["destination must be a TON workchain 0 address — the USDT0 Legacy Mesh pays on the basechain only, not workchain -1", {reason: "recipient_mismatch"}]]);
    expect(await meshRefusals({destAddress: USDT0_MESH_PLACEHOLDER.tron})).toEqual([[ZERO_TEXT, {reason: "recipient_mismatch"}]]);
    expect(await meshRefusals({refundAddress: TRON_TO})).toEqual([["refund address must be an EVM address", {reason: "recipient_mismatch"}]]);
    expect(await meshRefusals({destAddress: ""})).toEqual([["a live quote needs a recipient", {reason: "policy_refused"}]]);
    expect(await meshRefusals({refundAddress: ""})).toEqual([["a live quote needs a refund address", {reason: "policy_refused"}]]);
  });

  it("upstream_unavailable: the source RPC answers 500 (fixed text, the status kept)", async () => {
    expect(await meshRefusals({}, {quoteSendFails: "http"})).toEqual([[RPC_DOWN, {reason: "upstream_unavailable", httpStatus: 500}]]);
  });

  it("the provider's self-check of its own build reports the check's reason", async () => {
    hooks.meshCheck = (params) => ({...params, refundAddress: ATTACKER});
    expect(await meshRefusals({})).toEqual([[`usdt0: the built Legacy Mesh send does not match the request — the send refunds ${SENDER}, not the trader`, {reason: "recipient_mismatch"}]]);
    hooks.meshCheck = (params) => ({...params, minAmountOut: "9997001"});
    expect(await meshRefusals({destAddress: "", refundAddress: "", dry: true})).toEqual([["usdt0: the built Legacy Mesh send does not match the request — the quoted minimum 9997000 is below the caller's floor 9997001", {reason: "price_check_failed"}]]);
  });
});

describe("buildDeposit and preflightDeposit (OFT send)", () => {
  it("each throw is a plain Error with its text and reason", async () => {
    const {p} = oftMake();
    const q = (await p.getQuote(OFT))!;
    const tx = await p.buildDeposit(q);
    const {refundAddress: _r, ...noRefund} = OFT;
    const dry = (await p.getQuote({...noRefund, destAddress: "", dry: true}))!;
    expectRefusal(await rejection(p.buildDeposit(dry)), "swap2: this USDT0 quote was priced for a placeholder recipient (a dry quote without that address) and has no transaction to build — quote again with the recipient and the refund address", {reason: "policy_refused"});
    expectRefusal(await rejection(p.buildDeposit({...q, intentId: "cctp:6:3:1000"})), "swap2: USDT0 quote has no transaction request", {reason: "policy_refused"});
    expectRefusal(await rejection(p.preflightDeposit!(dry, tx)), "usdt0: this quote was priced for a placeholder recipient (a dry quote without that address) and has nothing to sign — quote again with the recipient and the refund address", {reason: "policy_refused"});
    expectRefusal(await rejection(p.preflightDeposit!({...q, intentId: "usdt0:1:2"}, tx)), "usdt0: malformed intent id", {reason: "policy_refused"});
    expectRefusal(await rejection(p.preflightDeposit!(q, {...tx, to: RECIPIENT})), `usdt0: deposit target ${RECIPIENT} is not the Arbitrum OFT`, {reason: "vault_mismatch"});
    expectRefusal(await rejection(p.preflightDeposit!({...q, providerData: {}}, tx)), "usdt0: quote carries no sealed send parameters", {reason: "policy_refused"});
    expectRefusal(await rejection(p.preflightDeposit!({...q, providerData: {...q.providerData, recipient: ZERO_EVM}}, tx)), `usdt0: ${ZERO_TEXT}`, {reason: "recipient_mismatch"});
    expectRefusal(await rejection(oftMake({}, {rpcUrls: {"eip155:999": "http://rpc.hype"}}).p.preflightDeposit!(q, tx)), "usdt0: no RPC for eip155:42161", {reason: "unsupported_pair"});
    expectRefusal(await rejection(oftMake({fee: SEALED + 1n}).p.preflightDeposit!(q, tx)), `usdt0: LayerZero fee rose to ${SEALED + 1n} above the sealed ${SEALED} (quote + 25 % headroom) — re-quote`, {reason: "quote_expired"});
    expectRefusal(await rejection(p.preflightDeposit!(q, {...tx, value: "1"})), `usdt0: transaction value 1 is not the quoted fee ${SEALED}`, {reason: "policy_refused"});
    await expect(p.preflightDeposit!(q, tx)).resolves.toBeUndefined();
  });

  it("an inner classification survives the re-thrown text: a lost peer, the RPC rejecting the key", async () => {
    const {p} = oftMake();
    const q = (await p.getQuote(OFT))!;
    const tx = await p.buildDeposit(q);
    expectRefusal(await rejection(oftMake({peer: null}).p.preflightDeposit!(q, tx)), "usdt0: Arbitrum OFT has no peer for HyperEVM (eid 30367) — route not wired", {reason: "unsupported_pair"});
    expectRefusal(await rejection(failingRpc(() => new Response("bad key", {status: 401})).preflightDeposit!(q, tx)), RPC_DOWN, {reason: "key_rejected", httpStatus: 401});
  });
});

describe("preflightDeposit (Legacy Mesh)", () => {
  it("each throw is a plain Error with its text and reason", async () => {
    const {p} = meshMake();
    const q = (await p.getQuote(TO_TRON))!;
    const tx = await p.buildDeposit(q);
    const sealed = sealedOf(FEE_TRON);
    const data = (f: Parameters<typeof edit>[1]) => edit(q, f).txRequest!.data!;
    expectRefusal(await rejection(p.preflightDeposit!(q, {...tx, to: ATTACKER})), `usdt0: deposit target ${ATTACKER} is not the Arbitrum Legacy Mesh OFT`, {reason: "vault_mismatch"});
    expectRefusal(await rejection(p.preflightDeposit!({...q, providerData: {...q.providerData, recipient: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj"}}, tx)), "usdt0: quote carries no sealed send parameters", {reason: "policy_refused"});
    expectRefusal(await rejection(p.preflightDeposit!({...q, providerData: {...q.providerData, recipient: USDT0_MESH_PLACEHOLDER.tron, recipientBytes32: `0x${"00".repeat(32)}`}}, tx)), `usdt0: ${ZERO_TEXT}`, {reason: "recipient_mismatch"});
    expectRefusal(await rejection(p.preflightDeposit!(q, {...tx, data: "0x1234"})), "usdt0: the deposit is not the sealed Legacy Mesh send", {reason: "policy_refused"});
    expectRefusal(await rejection(p.preflightDeposit!(q, {...tx, data: data((sp) => { sp.amountLD = 1n; })})), "usdt0: the deposit is not the sealed Legacy Mesh send", {reason: "policy_refused"});
    const [sp] = decodeFunctionData({abi: MESH_ABI, data: tx.data as Hex}).args as unknown as [never];
    const quoteSend = encodeFunctionData({abi: MESH_ABI, functionName: "quoteSend", args: [sp, false]});
    expectRefusal(await rejection(p.preflightDeposit!(q, {...tx, data: quoteSend})), "usdt0: the deposit calls quoteSend, not send(SendParam, MessagingFee, refund)", {reason: "policy_refused"});
    expectRefusal(await rejection(p.preflightDeposit!(q, {...tx, data: data((s) => { s.extraOptions = "0x0003"; })})), "usdt0: the deposit's SendParam.extraOptions 0x0003 is not the sealed 0x", {reason: "policy_refused"});
    expectRefusal(await rejection(p.preflightDeposit!(q, {...tx, data: data((_s, r) => { r.fee.nativeFee = 1n; })})), `usdt0: the deposit's MessagingFee.nativeFee 1 is not the sealed ${sealed}`, {reason: "policy_refused"});
    expectRefusal(await rejection(p.preflightDeposit!(q, {...tx, data: data((_s, r) => { r.fee.lzTokenFee = 1n; })})), "usdt0: the deposit's MessagingFee.lzTokenFee 1 is not 0", {reason: "policy_refused"});
    const {refundAddress: _gone, ...noRefund} = q.providerData!;
    expectRefusal(await rejection(p.preflightDeposit!({...q, providerData: noRefund}, tx)), "usdt0: quote carries no sealed refund address", {reason: "policy_refused"});
    expectRefusal(await rejection(p.preflightDeposit!(q, {...tx, data: data((_s, r) => { r.refund = ATTACKER; })})), `usdt0: the deposit refunds ${ATTACKER}, not the sealed refund address ${SENDER}`, {reason: "recipient_mismatch"});
    expectRefusal(await rejection(p.preflightDeposit!(q, {...tx, chainId: 1})), "usdt0: the deposit is for eip155:42161 (chainId 1), not Arbitrum (eip155:42161)", {reason: "policy_refused"});
    expectRefusal(await rejection(meshMake({}, {rpcUrls: {"eip155:1": "http://rpc.eth"}}).p.preflightDeposit!(q, tx)), "usdt0: no RPC for eip155:42161", {reason: "unsupported_pair"});
    expectRefusal(await rejection(meshMake({fee: sealed + 1n}).p.preflightDeposit!(q, tx)), `usdt0: LayerZero fee rose to ${sealed + 1n} above the sealed ${sealed} (quote + 25 % headroom) — re-quote`, {reason: "quote_expired"});
    expectRefusal(await rejection(p.preflightDeposit!(q, {...tx, value: "1"})), `usdt0: transaction value 1 is not the quoted fee ${sealed}`, {reason: "policy_refused"});
    expectRefusal(await rejection(meshMake({quoteSendFails: "http"}).p.preflightDeposit!(q, tx)), RPC_DOWN, {reason: "upstream_unavailable", httpStatus: 500});
    await expect(p.preflightDeposit!(q, tx)).resolves.toBeUndefined();
  });

  it("the pool's credits run out before signing: InsufficientCredits → insufficient_liquidity, the revert text kept", async () => {
    const {p} = meshMake();
    const q = (await p.getQuote(TO_TRON))!;
    const tx = await p.buildDeposit(q);
    const err = await rejection(meshMake({quoteSendFails: "credits"}).p.preflightDeposit!(q, tx));
    expect(err.constructor).toBe(Error);
    expect(err.message).toMatch(/^The contract function "quoteSend" reverted\.\n\nError: InsufficientCredits\(/);
    expect(refusalOf(err)).toEqual({reason: "insufficient_liquidity"});
  });
});

describe("buildClaim: LayerZero Scan through the real fetch path", () => {
  const ref = {intentId: `usdt0:${ARB.eid}:${HYPE.eid}`, sourceTxHash: SRC_TX};
  const stored = (extra: Record<string, unknown> = {}) => ({
    pathway: {srcEid: ARB.eid, dstEid: HYPE.eid, sender: {address: ARB.oft.toLowerCase()}, receiver: {address: HYPE.oft.toLowerCase()}, nonce: 4242},
    source: {status: "SUCCEEDED", tx: {txHash: SRC_TX, payload: PAYLOAD, options: {lzReceive: {gas: "80000", value: "0"}}}},
    destination: {status: "WAITING"}, guid: GUID, status: {name: "PAYLOAD_STORED", message: "PAYLOAD_STORED"}, ...extra,
  });
  const scanAnswers = (answer: () => Response | Promise<Response>) =>
    usdt0Provider({scanUrl: "https://scan.test", fetchImpl: intercept(world().fetchImpl, "https://scan.test", answer), rpcUrls: RPC});

  it("HTTP 429 with Retry-After → rate_limited; 401 / 403 → key_rejected; 5xx and other statuses → upstream_unavailable", async () => {
    expectRefusal(await rejection(scanAnswers(() => new Response("", {status: 429, headers: {"retry-after": "9"}})).buildClaim!(ref)), "usdt0: LayerZero Scan → 429", {reason: "rate_limited", httpStatus: 429, retryAfterMs: 9000});
    for (const status of [401, 403]) {
      expectRefusal(await rejection(scanAnswers(() => new Response("", {status})).buildClaim!(ref)), `usdt0: LayerZero Scan → ${status}`, {reason: "key_rejected", httpStatus: status});
    }
    for (const status of [500, 503, 400]) {
      expectRefusal(await rejection(scanAnswers(() => new Response("", {status})).buildClaim!(ref)), `usdt0: LayerZero Scan → ${status}`, {reason: "upstream_unavailable", httpStatus: status});
    }
  });

  it("a network failure, this module's timeout and a body that is not JSON: the same error, upstream_unavailable", async () => {
    const network = await rejection(scanAnswers(() => Promise.reject(new TypeError("fetch failed"))).buildClaim!(ref));
    expect(network).toBeInstanceOf(TypeError);
    expect(network.message).toBe("fetch failed");
    expect(refusalOf(network)).toEqual({reason: "upstream_unavailable"});
    const timeout = await rejection(scanAnswers(() => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))).buildClaim!(ref));
    expect(timeout.name).toBe("TimeoutError");
    expect(timeout.message).toBe("The operation was aborted due to timeout");
    expect(refusalOf(timeout)).toEqual({reason: "upstream_unavailable"});
    const garbled = await rejection(scanAnswers(() => new Response("<html>")).buildClaim!(ref));
    expect(garbled).toBeInstanceOf(SyntaxError);
    expect(refusalOf(garbled)).toEqual({reason: "upstream_unavailable"});
  });

  it("an incomplete packet → upstream_unavailable; a payload stored for another receiver → vault_mismatch", async () => {
    expectRefusal(await rejection(oftMake({message: stored({guid: undefined})}).p.buildClaim!(ref)), "usdt0: LayerZero Scan has no complete packet for the stored payload", {reason: "upstream_unavailable"});
    const other = stored({pathway: {srcEid: ARB.eid, dstEid: HYPE.eid, sender: {address: ARB.oft}, receiver: {address: RECIPIENT}, nonce: 1}});
    expectRefusal(await rejection(oftMake({message: other}).p.buildClaim!(ref)), "usdt0: stored payload is addressed to another receiver", {reason: "vault_mismatch"});
    expect(await oftMake({message: stored()}).p.buildClaim!(ref)).not.toBeNull();
  });

  it("tracking never throws: a failing Scan is still pending", async () => {
    expect(await scanAnswers(() => new Response("", {status: 429})).trackIntent(ref)).toEqual({state: "pending"});
  });
});

describe("usdt0VerifyQuote: every text it returns, with usdt0Pins.reasonOf", () => {
  const check = (params: QuoteParams, quote: Quote, text: string, reason: Swap2RefusalReason) => {
    const got = usdt0VerifyQuote(params, quote);
    expect(got, text).toBe(text);
    expect(usdt0Pins.reasonOf?.(got!), text).toEqual({reason});
  };

  it("an OFT send: route, tokens, recipient, call, target, chain, spender, amounts, options, refund, fees, intent", async () => {
    const {p} = oftMake();
    const q = (await p.getQuote(OFT))!;
    const tx = q.txRequest!;
    const send = (f: (sp: Record<string, unknown>, rest: {fee: {nativeFee: bigint; lzTokenFee: bigint}; refund: string}) => void): Quote => {
      const d = decodeFunctionData({abi: OFT_ABI, data: tx.data as Hex});
      const [sp0, fee, refund] = d.args as unknown as [Record<string, unknown>, {nativeFee: bigint; lzTokenFee: bigint}, string];
      const sp = {...sp0};
      const rest = {fee: {...fee}, refund};
      f(sp, rest);
      return {...q, txRequest: {...tx, data: encodeFunctionData({abi: OFT_ABI, functionName: "send", args: [sp as never, rest.fee, rest.refund as Hex]})}};
    };
    expect(usdt0VerifyQuote(OFT, q)).toBeNull();
    check({...OFT, destChain: "eip155:8453"}, q, "not a USDT0 route between two deployments", "unsupported_pair");
    check({...OFT, sourceToken: "USDC"}, q, `source token USDC is not USDT0 (${ARB.token}) on Arbitrum`, "unsupported_pair");
    check({...OFT, destToken: "USDC"}, q, `destination token USDC is not USDT0 (${HYPE.token}) on HyperEVM`, "unsupported_pair");
    check({...OFT, destAddress: ZERO_EVM}, q, ZERO_TEXT, "recipient_mismatch");
    const {refundAddress: _noRefund, ...noRefundParams} = OFT;
    check({...noRefundParams, dry: true}, q, "a dry quote priced for a placeholder refund address carries a transaction — it would pay or refund that placeholder, not the wallet that signs it", "recipient_mismatch");
    check(OFT, {...q, txRequest: {...tx, serializedTx: "0x00"}}, "the quote carries no OFT call", "policy_refused");
    check(OFT, {...q, txRequest: {...tx, to: RECIPIENT}}, `the call targets ${RECIPIENT}, not the Arbitrum OFT`, "vault_mismatch");
    check(OFT, {...q, txRequest: {...tx, chainId: 1}}, "the call is for chain 1, not 42161", "policy_refused");
    check(OFT, {...q, txRequest: {...tx, approvalAddress: ARB.oft}}, "an OFT send needs no approval", "vault_mismatch");
    check({...OFT, sourceChain: "eip155:1", sourceToken: "USDT", destChain: "eip155:42161", destToken: ARB.token}, {...q, txRequest: {...tx, to: config.USDT0_CHAINS["eip155:1"]!.oft, chainId: 1}}, "the Ethereum send approves another spender than the adapter", "vault_mismatch");
    check(OFT, {...q, txRequest: {...tx, data: encodeFunctionData({abi: OFT_ABI, functionName: "token"})}}, "the call is not send(SendParam, MessagingFee, refund)", "policy_refused");
    check(OFT, {...q, minDestAmount: "x"}, "the request does not name amounts", "upstream_unavailable");
    check(OFT, send((sp) => { sp.dstEid = 30101; }), "the send goes to eid 30101, not HyperEVM (30367)", "recipient_mismatch");
    check(OFT, send((sp) => { sp.amountLD = 1n; }), "the send moves 1, not the 10000000 input", "policy_refused");
    check(OFT, send((sp) => { sp.minAmountLD = 1n; }), "the send's minAmountLD 1 is below the 10000000 minimum", "price_check_failed");
    check(OFT, send((sp) => { sp.composeMsg = "0x01"; }), "the send carries options, a compose message or an OFT command", "policy_refused");
    check({...OFT, destAddress: "garbage"}, q, "the recipient is not an EVM address", "recipient_mismatch");
    check(OFT, send((sp) => { sp.to = pad(ATTACKER, {size: 32}); }), `the send delivers to ${pad(ATTACKER, {size: 32})}, not the recipient`, "recipient_mismatch");
    check({...OFT, refundAddress: TRON_TO}, q, "the refund address is not an EVM address", "recipient_mismatch");
    check(OFT, send((_sp, r) => { r.refund = ATTACKER; }), `the send refunds ${ATTACKER}, not the trader`, "recipient_mismatch");
    check(OFT, send((_sp, r) => { r.fee.lzTokenFee = 1n; }), "the send pays an LZ-token fee", "policy_refused");
    check(OFT, {...q, txRequest: {...tx, value: "1"}}, "msg.value is not the declared native fee of the send", "policy_refused");
    check(OFT, {...q, intentId: "usdt0:30110:30101"}, "the intent id does not name this send", "policy_refused");
  });

  it("a price-only quote (a dry request priced for a stand-in): deposit address, amounts, floor, intent", async () => {
    const {p} = oftMake();
    const {refundAddress: _r, ...noRefund} = OFT;
    const params: QuoteParams = {...noRefund, destAddress: "", dry: true};
    const q = (await p.getQuote(params))!;
    expect(usdt0VerifyQuote(params, q)).toBeNull();
    check(params, {...q, depositAddress: ATTACKER}, `a USDT0 quote pays no deposit address, but this one names ${ATTACKER}`, "vault_mismatch");
    check(params, {...q, sourceAmount: "1"}, "the quote spends 1, not the 10000000 input", "policy_refused");
    check(params, {...q, destAmount: "x"}, "the quote's amounts are not integers", "upstream_unavailable");
    check(params, {...q, destAmount: "10000001"}, "the quote delivers more than the 10000000 input", "price_check_failed");
    check({...params, minAmountOut: "10000001"}, q, "the quoted minimum 10000000 is below the caller's floor 10000001", "price_check_failed");
    check(params, {...q, intentId: "usdt0:1:2"}, "the intent id does not name this send", "policy_refused");
  });

  it("a Legacy Mesh send: route, recipient spelling, spender, eid, refund", async () => {
    const {p} = meshMake();
    const q = (await p.getQuote(TO_TRON))!;
    expect(usdt0VerifyQuote(TO_TRON, q)).toBeNull();
    check({...TO_TRON, sourceChain: "eip155:999"}, q, "not a USDT0 route between two deployments", "unsupported_pair");
    check({...TO_TRON, destToken: "TRX"}, q, `destination token TRX is not USDT0 (${TRON.token}) on Tron`, "unsupported_pair");
    check({...TO_TRON, destAddress: USDT0_MESH_PLACEHOLDER.tron}, q, ZERO_TEXT, "recipient_mismatch");
    check(TO_TRON, {...q, txRequest: {...q.txRequest!, to: ARB.oft}}, `the call targets ${ARB.oft}, not the Arbitrum Legacy Mesh OFT`, "vault_mismatch");
    check(TO_TRON, {...q, txRequest: {...q.txRequest!, approvalAddress: ATTACKER}}, "the Legacy Mesh send approves another spender than its OFT", "vault_mismatch");
    check({...TO_TRON, destAddress: "garbage"}, q, "destination must be a Tron address (base58check T…)", "recipient_mismatch");
    check(TO_TRON, edit(q, (sp) => { sp.dstEid = TON.eid; }), "the send goes to eid 30343, not Tron (30420)", "recipient_mismatch");
    check(TO_TRON, edit(q, (_sp, r) => { r.refund = ATTACKER; }), `the send refunds ${ATTACKER}, not the trader`, "recipient_mismatch");
    check(TO_TRON, edit(q, (sp) => { sp.oftCmd = "0x01"; }), "the send carries options, a compose message or an OFT command", "policy_refused");
    check(TO_TRON, {...q, intentId: "usdt0:30110:30420"}, "the intent id does not name this send", "policy_refused");
    expect(usdt0Pins.reasonOf?.("a text these pins never returned")).toBeUndefined();
  });

  it("a backend's sourceAmount that is not an integer: the check throws as before, its text classified upstream_unavailable", async () => {
    const oft = (await oftMake().p.getQuote(OFT))!;
    const mesh = (await meshMake().p.getQuote(TO_TRON))!;
    for (const [params, q] of [[OFT, oft], [TO_TRON, mesh]] as const) {
      let thrown: unknown;
      try { usdt0VerifyQuote(params, {...q, sourceAmount: "abc"}); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(SyntaxError);
      expect((thrown as Error).message).toBe("Cannot convert abc to a BigInt");
      expect(usdt0Pins.reasonOf?.((thrown as Error).message)).toEqual({reason: "upstream_unavailable"});
    }
    // The amountLD comparison still comes first: a send that moves another amount is refused without reading sourceAmount.
    const moved = (q: Quote) => ({...edit(q, (sp) => { sp.amountLD = 1n; }), sourceAmount: "abc"});
    expect(usdt0VerifyQuote(TO_TRON, moved(mesh))).toBe("the send moves 1, not the 10000000 input");
  });
});

describe("through the remote stub and the engine", () => {
  it("a backend's quote that fails usdt0VerifyQuote: the stub's error carries the pins' reason", async () => {
    const handle = createSwap2Handler<string>({providers: [meshMake().p], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
    const tampered = (async (url: string, init: RequestInit) => {
      const action = String(url).split("/").pop()!;
      const res = await handle(action, JSON.parse(String(init.body)), "alice");
      const body = action === "quote" ? edit(res.body as Quote, (_sp, r) => { r.refund = ATTACKER; }) : res.body;
      return new Response(JSON.stringify(body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
    const stub = remoteProvider({name: "usdt0", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl: tampered, ...usdt0Pins});
    const err = await rejection(stub.getQuote(TO_TON));
    expect(err.message).toBe(`usdt0: the quote fails this app's own check — the send refunds ${ATTACKER}, not the trader`);
    expect(refusalOf(err)).toEqual({reason: "recipient_mismatch"});
  });

  it("a backend's quote whose sourceAmount is not an integer: the stub's error carries upstream_unavailable", async () => {
    const handle = createSwap2Handler<string>({providers: [meshMake().p], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
    const tampered = (async (url: string, init: RequestInit) => {
      const action = String(url).split("/").pop()!;
      const res = await handle(action, JSON.parse(String(init.body)), "alice");
      const body = action === "quote" ? {...(res.body as Quote), sourceAmount: "abc"} : res.body;
      return new Response(JSON.stringify(body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
    const stub = remoteProvider({name: "usdt0", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl: tampered, ...usdt0Pins});
    const err = await rejection(stub.getQuote(TO_TON));
    expect(err.message).toBe("usdt0: the quote fails this app's own check — Cannot convert abc to a BigInt");
    expect(refusalOf(err)).toEqual({reason: "upstream_unavailable"});
  });

  it("the backend's own provider refusal comes back with its reason", async () => {
    const handle = createSwap2Handler<string>({providers: [meshMake({credits: 5n}).p], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
    const backend = (async (url: string, init: RequestInit) => {
      const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
      return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
    const stub = remoteProvider({name: "usdt0", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl: backend, ...usdt0Pins});
    const err = await rejection(stub.getQuote(TO_TON));
    expect(err.message).toBe("amount 10000000 exceeds the OFT maximum 5");
    expect(refusalOf(err)).toEqual({reason: "insufficient_liquidity"});
  });

  it("the standalone protocol's no route carries the venue's reason; the message reads as before", async () => {
    const w = world({minAmount: 20_000_000n});
    const account = {getAddress: async () => SENDER, getChainId: async () => 42161, getAllowance: async () => 0n};
    const proto = new Usdt0Swap2Protocol(account as never, {fromChain: "eip155:42161", rpcUrls: RPC, scanUrl: "https://scan.test", fetchImpl: w.fetchImpl});
    const e = await rejection<Swap2QuoteError>(proto.quoteSwap2({fromToken: "USDT0", toToken: HYPE.token, toChain: 999, recipient: RECIPIENT, fromTokenAmount: 10_000_000n, minAmountOut: 10_000_000n} as never));
    expect(e).toBeInstanceOf(Swap2QuoteError);
    expect(e.message).toBe("swap2: no route available for the requested pair :: usdt0: amount 10000000 is below the OFT minimum 20000000");
    expect(e.reason).toBe("amount_too_small");
    expect(e.refusals).toEqual([{message: "usdt0: amount 10000000 is below the OFT minimum 20000000", provider: "usdt0", reason: "amount_too_small"}]);
  });
});

describe("what stays unclassified", () => {
  it("configuration errors", () => {
    for (const bad of [{scanUrl: "ftp://x"}, {tonApiUrl: "ftp://x"}, {quoteTtlMs: 0}, {meshDestinations: ["sol"] as never}]) {
      let thrown: unknown;
      try { usdt0Provider(bad); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(Error);
      expect(refusalOf(thrown)).toBeUndefined();
    }
  });

  it("a developer's non-integer amount reaches onRefusal with the text only", async () => {
    expect(await oftRefusals({amountIn: "1.5"})).toEqual([["amount must be a base-unit integer", null]]);
    expect(await meshRefusals({amountIn: "1e7"})).toEqual([["amount must be a base-unit integer", null]]);
  });

  it("the caller's abort is no failure of the venue: the quote does not read the signal, nothing is refused", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = recorder();
    const q = await oftMake().p.getQuote({...OFT, onRefusal: r.onRefusal}, ctrl.signal);
    expect(q?.sourceAmount).toBe("10000000");
    expect(r.got).toEqual([]);
  });
});
