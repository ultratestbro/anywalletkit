// CS-13: every refusal Omniston produces carries a stable `reason` (Swap2RefusalReason) next to its unchanged text — on
// thrown errors (refusalOf), as onRefusal's second argument, and for the texts omnistonVerifyBuild returns
// (omnistonPins(...).reasonOf, which remoteProvider puts on the stub's error). Driven through the real code paths: the
// provider with an injected Omniston SDK client answering live captures, the swap2 server handler and remoteProvider.
// The provider talks to the venue over the SDK's WebSocket (no fetch); its failures are classified from the reason the
// venue gave (OmnistonError.details.error_info), else upstream_unavailable. The TON validators do fetch, but answer
// yes / no: a throttled or failed indexer leaves the target unconfirmed.
import "../src/buffer-global.js";
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {Address, beginCell, type Builder} from "@ton/core";
import {keccak256, toHex} from "viem";
import {OmnistonError} from "@ston-fi/omniston-sdk";
import {refusalOf, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import type {Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {
  inMemorySecretStore, omnistonPins, omnistonProvider, omnistonVerifyBuild, validateEvmToTonOrderExtension, type OmnistonProviderOptions,
} from "../src/provider.js";
import {AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS, AUDITED_OMNISTON_SETTLEMENT_CONTRACTS, createOmnistonTonValidators} from "../src/validators/index.js";

const fixture = (file: string) => JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));
const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const b64 = (value: string) => Buffer.from(value, "hex").toString("base64");
const TON_ATTACKER = new Address(0, Buffer.alloc(32, 0x99)).toString({bounceable: false});
const EVM_ATTACKER = "0xa77ac3e5a77ac3e5a77ac3e5a77ac3e5a77ac3e5";

/** The thrown error: its exact text and the reason it carries. */
async function rejection(promise: Promise<unknown>): Promise<{error: Error; message: string; info: Swap2RefusalInfo | undefined}> {
  const error = await promise.then(() => { throw new Error("expected a refusal"); }, (e: unknown) => e as Error);
  return {error, message: error.message, info: refusalOf(error)};
}

/** A stand-in for the SDK's OmnistonError (numeric `code`, no `reason`): the class must survive the tagging. */
class FakeOmnistonError extends Error {
  readonly code = -1;
  constructor(message: string) { super(message); this.name = "OmnistonError"; }
}

/**
 * The SDK's own OmnistonError as its JSON-RPC wrapper builds it for a venue refusal: the venue's error data as
 * `details`, whose `error_info` names the reason (`{reason, metadata, domain}`).
 */
const venueError = (message: string, reason: string, metadata: Record<string, string> = {}) =>
  new OmnistonError(-32000, message, {details: {error_info: {reason, metadata, domain: "omniston"}}} as never);

type Events = unknown[] | ((observer: {next: (e: unknown) => void; error?: (e: unknown) => void; complete?: () => void}) => void);
function observable(events: Events) {
  return {
    subscribe(observer: {next: (e: unknown) => void; error?: (e: unknown) => void; complete?: () => void}) {
      if (typeof events === "function") events(observer);
      else { for (const e of events) observer.next(e); observer.complete?.(); }
      return {unsubscribe() {}};
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── TON → EVM orders (live 2026-10-10, rev1 minter trusted explicitly) ───────────────────────────────────────────────

const tonEvm = fixture("live-2026-10-10.json").baseUsdc;
const TE = {
  trader: tonEvm.escrowRequest.ownerSrcAddress.chain.value as string,
  recipient: tonEvm.escrowRequest.traderDstAddress.chain.value as string,
  jettonWallet: tonEvm.escrowResponse.messages[0].targetAddress as string,
  trusted: {"ton:-239": ["EQAbWJ3Y1HgIIvcMq1prG1anlDC0T3cZlAU7luPT6LmTpmrZ"], "eip155:8453": ["0xACa3E2F9b61a44892926bC6c3e104192E7D1c3cd"]},
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};
type OmniQuote = Record<string, unknown> & {quoteId: string; rfqId: string; quoteTimestamp: number; outputUnits: string; settlementData: {value: Record<string, unknown>}};
function tonEvmQuote(patch: (q: OmniQuote) => void = () => {}): OmniQuote {
  const q = structuredClone(tonEvm.quoteUpdated.value) as OmniQuote;
  const now = Math.floor(Date.now() / 1000);
  q.quoteTimestamp = now;
  q.settlementData.value.tradeStartDeadline = now + 300;
  patch(q);
  return q;
}
function tonEvmClient(quote: OmniQuote | null, extra: Record<string, unknown> = {}, events?: Events) {
  return {
    requestForQuote: () => observable(events ?? [{$case: "ack", value: {rfqId: quote?.rfqId ?? "r"}}, ...(quote ? [{$case: "quoteUpdated", rfqId: quote.rfqId, value: quote}] : [])]),
    async tonBuildEscrowTransfer() { return structuredClone(tonEvm.escrowResponse); },
    orderTrack: () => observable([]),
    ...extra,
  };
}
function tonEvmProvider(client: unknown, extra: Partial<OmnistonProviderOptions> = {}) {
  return omnistonProvider({
    client: client as never, quoteSettleMs: 0, maxHtlcExecutions: 1, trustedSettlementContracts: TE.trusted,
    validateTonJettonWallet: ({walletAddress}) => walletAddress === TE.jettonWallet,
    validateTonEscrowPayload: () => true, validateEvmOutputPosition: () => true, ...extra,
  });
}
const tonEvmParams = (extra: Record<string, unknown> = {}): QuoteParams => ({
  sourceChain: "ton:-239", sourceToken: "USDT", destChain: "eip155:8453", destToken: TE.usdc,
  amountIn: "5000000", destAddress: TE.recipient, refundAddress: TE.trader, slippageBps: 100, dry: true, ...extra,
} as QuoteParams);
/** Every onRefusal call, with all its arguments. */
async function refusals(provider: ReturnType<typeof omnistonProvider>, params: QuoteParams, signal?: AbortSignal) {
  const calls: unknown[][] = [];
  const quote = await provider.getQuote({...params, onRefusal: (...args: unknown[]) => { calls.push(args); }} as QuoteParams, signal);
  return {quote, calls};
}

describe("getQuote: onRefusal gets the reason as its second argument, the text unchanged", () => {
  it("no_route: the venue acknowledged the RFQ and no resolver quoted", async () => {
    const {quote, calls} = await refusals(tonEvmProvider(tonEvmClient(null)), tonEvmParams());
    expect(quote).toBeNull();
    expect(calls).toEqual([["omniston: no resolver quoted this route/amount", {reason: "no_route"}]]);
    expect(calls[0]![0]).toBe("omniston: no resolver quoted this route/amount");
  });

  it("upstream_unavailable: the RFQ stream closed unanswered, errored, or timed out on the module's own window", async () => {
    const silent = await refusals(tonEvmProvider(tonEvmClient(null, {}, (o) => o.complete?.())), tonEvmParams());
    expect(silent.calls).toEqual([["omniston: no resolver quoted this route/amount", {reason: "upstream_unavailable"}]]);

    const broken = await refusals(tonEvmProvider(tonEvmClient(null, {}, (o) => o.error?.(new FakeOmnistonError("socket closed")))), tonEvmParams());
    expect(broken.calls).toEqual([["omniston: RFQ failed: socket closed", {reason: "upstream_unavailable"}]]);
    expect(broken.calls[0]![0]).toBe("omniston: RFQ failed: socket closed");

    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
    const hanging = refusals(tonEvmProvider(tonEvmClient(null, {}, () => {})), tonEvmParams());
    await vi.advanceTimersByTimeAsync(7_000);
    expect((await hanging).calls).toEqual([["omniston: no resolver quoted this route/amount", {reason: "upstream_unavailable"}]]);
  });

  it("the venue's own reason on the RFQ stream (OmnistonError.details.error_info): swap limit, unsupported route; an invalid argument stays unclassified", async () => {
    const streamFails = async (error: unknown) =>
      (await refusals(tonEvmProvider(tonEvmClient(null, {}, (o) => o.error?.(error))), tonEvmParams())).calls;
    expect(await streamFails(venueError("swap limit exceeded", "SWAP_LIMIT_EXCEEDED", {amount: "5000000", limit: "1000000"})))
      .toEqual([["omniston: RFQ failed: swap limit exceeded", {reason: "amount_too_large"}]]);
    expect(await streamFails(venueError("route is not supported", "UNSUPPORTED", {type: "UNSUPPORTED_ROUTE"})))
      .toEqual([["omniston: RFQ failed: route is not supported", {reason: "unsupported_pair"}]]);
    expect(await streamFails(venueError("bad amount", "INVALID_ARGUMENT", {argument_name: "amount", expected: "uint", actual: "x"})))
      .toEqual([["omniston: RFQ failed: bad amount"]]);
    expect(await streamFails(venueError("validator down", "QUOTE_VALIDATOR_ERROR")))
      .toEqual([["omniston: RFQ failed: validator down", {reason: "upstream_unavailable"}]]);
  });

  it("upstream_unavailable / quote_expired: a rejected resolver update — another shape, or a stale timestamp", async () => {
    const incomplete = await refusals(tonEvmProvider(tonEvmClient(tonEvmQuote((q) => { delete q.settlementData.value.exclusivityTimeout; }))), tonEvmParams());
    expect(incomplete.calls).toEqual([["omniston: resolver quote rejected: incomplete order settlement data", {reason: "upstream_unavailable"}]]);
    const stale = await refusals(tonEvmProvider(tonEvmClient(tonEvmQuote((q) => { q.quoteTimestamp -= 600; }))), tonEvmParams());
    expect(stale.calls).toEqual([["omniston: resolver quote rejected: quote timestamp out of range", {reason: "quote_expired"}]]);
    expect(stale.calls[0]![0]).toBe("omniston: resolver quote rejected: quote timestamp out of range");
  });

  it("vault_mismatch: a settlement contract outside the app's table", async () => {
    const {calls} = await refusals(tonEvmProvider(tonEvmClient(tonEvmQuote()), {
      trustedSettlementContracts: {...TE.trusted, "eip155:8453": ["0x0000000000000000000000000000000000000001"]},
    }), tonEvmParams());
    expect(calls).toEqual([["omniston: untrusted eip155:8453 settlement contract 0xACa3E2F9b61a44892926bC6c3e104192E7D1c3cd", {reason: "vault_mismatch"}]]);
  });

  it("amount_too_large / unsupported_pair: the per-swap cap, a native leg, a catalog miss, a non-corridor, an unconfigured chain or validator", async () => {
    const one = async (params: QuoteParams, extra: Partial<OmnistonProviderOptions> = {}) => (await refusals(tonEvmProvider(tonEvmClient(null), extra), params)).calls;
    expect(await one(tonEvmParams({amountIn: "1000000001"}))).toEqual([["omniston: amount above the 1000 USD per-swap cap", {reason: "amount_too_large"}]]);
    expect(await one(tonEvmParams({destToken: "0x0000000000000000000000000000000000000000"})))
      .toEqual([["omniston: cross-chain orders are token corridors only (no ETH native leg)", {reason: "unsupported_pair"}]]);
    expect(await one(tonEvmParams({destToken: "0x000000000000000000000000000000000000dEaD"}))).toEqual([["omniston: asset is not in the catalog", {reason: "unsupported_pair"}]]);
    expect(await one(tonEvmParams({sourceChain: "eip155:8453", sourceToken: "USDC"}))).toEqual([["omniston: route is not an Omniston order corridor", {reason: "unsupported_pair"}]]);
    expect(await one(tonEvmParams({destChain: "eip155:42161"}))).toEqual([["omniston: no trusted settlement contract configured for eip155:42161", {reason: "unsupported_pair"}]]);
    expect(await one(tonEvmParams(), {validateTonEscrowPayload: undefined} as never))
      .toEqual([["omniston: TON→EVM needs the jetton-wallet, escrow-payload and EVM output-position validators", {reason: "unsupported_pair"}]]);
  });

  it("quote_expired / price_check_failed / policy_refused: a passed deadline, an implausible output, a reused quote id", async () => {
    const deadline = await refusals(tonEvmProvider(tonEvmClient(tonEvmQuote((q) => { q.settlementData.value.tradeStartDeadline = q.quoteTimestamp - 10; }))), tonEvmParams());
    expect(deadline.calls).toEqual([["omniston: quote trade-start deadline already passed", {reason: "quote_expired"}]]);
    const cheap = tonEvmQuote((q) => { q.outputUnits = "1000000"; q.settlementData.value.resolverSendsUnits = "1001486"; });
    expect((await refusals(tonEvmProvider(tonEvmClient(cheap)), tonEvmParams())).calls)
      .toEqual([["omniston: quoted output is outside 0.5x–2x of the input", {reason: "price_check_failed"}]]);
    const secretStore = inMemorySecretStore();
    await secretStore.save(tonEvmQuote().quoteId, ["ab".repeat(32)]);
    expect((await refusals(tonEvmProvider(tonEvmClient(tonEvmQuote()), {secretStore}), tonEvmParams())).calls)
      .toEqual([["omniston: the platform reused a quote id that already belongs to an order", {reason: "policy_refused"}]]);
  });

  it("not refusals: the caller's own invalid amount and missing refundAddress reach onRefusal with the text alone", async () => {
    expect((await refusals(tonEvmProvider(tonEvmClient(null)), tonEvmParams({amountIn: "0"}))).calls).toEqual([["omniston: invalid amount"]]);
    expect((await refusals(tonEvmProvider(tonEvmClient(null)), tonEvmParams({refundAddress: undefined, dry: false}))).calls)
      .toEqual([["omniston: execution quote needs the trader's TON address (refundAddress)"]]);
  });

  it("the caller's own abort is not upstream_unavailable: no refusal at all", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const {quote, calls} = await refusals(tonEvmProvider(tonEvmClient(null, {}, () => {})), tonEvmParams(), controller.signal);
    expect(quote).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("TON → EVM build and tracking: thrown refusals carry the reason, the text unchanged", () => {
  it("policy_refused / vault_mismatch: the escrow payload validator says no; the trader's jetton wallet is not confirmed", async () => {
    const refuse = tonEvmProvider(tonEvmClient(tonEvmQuote()), {validateTonEscrowPayload: () => false});
    const r1 = await rejection(refuse.buildDeposit((await refuse.getQuote(tonEvmParams()))!));
    expect(r1.message).toBe("omniston: TON escrow forward payload failed independent semantic validation");
    expect(r1.info).toEqual({reason: "policy_refused"});
    expect(Object.getPrototypeOf(r1.error)).toBe(Error.prototype);

    const wallet = tonEvmProvider(tonEvmClient(tonEvmQuote()), {validateTonJettonWallet: () => false});
    const r2 = await rejection(wallet.buildDeposit((await wallet.getQuote(tonEvmParams()))!));
    expect(r2.message).toBe("omniston: TON jetton wallet was not independently validated");
    expect(r2.info).toEqual({reason: "vault_mismatch"});
  });

  it("through the validators' real fetch path, a throttled (429 + Retry-After), rejected (401), failing (503) or unreachable indexer leaves the wallet unconfirmed: vault_mismatch", async () => {
    const answers: Array<[string, typeof fetch]> = [
      ["429", (async () => new Response("slow down", {status: 429, headers: {"retry-after": "7"}})) as unknown as typeof fetch],
      ["401", (async () => new Response("no key", {status: 401})) as unknown as typeof fetch],
      ["503", (async () => new Response("down", {status: 503})) as unknown as typeof fetch],
      ["network", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch],
    ];
    for (const [label, fetchImpl] of answers) {
      const {validateTonJettonWallet} = createOmnistonTonValidators({fetch: fetchImpl});
      const p = tonEvmProvider(tonEvmClient(tonEvmQuote()), {validateTonJettonWallet});
      const r = await rejection(p.buildDeposit((await p.getQuote(tonEvmParams()))!));
      expect(r.message, label).toBe("omniston: TON jetton wallet was not independently validated");
      expect(r.info, label).toEqual({reason: "vault_mismatch"});
    }
  });

  it("policy_refused: the resolver's TON execution value above the safety cap", async () => {
    const p = tonEvmProvider(tonEvmClient(tonEvmQuote()), {maxTonExecutionNano: "1"});
    const r = await rejection(p.buildDeposit((await p.getQuote(tonEvmParams()))!));
    expect(r.message).toBe("omniston: resolver TON execution value exceeds the configured safety cap");
    expect(r.info).toEqual({reason: "policy_refused"});
  });

  it("upstream_unavailable: the SDK's escrow call fails without a structured reason — the same error, its class and text kept", async () => {
    const sdkError = new FakeOmnistonError("connection lost");
    const p = tonEvmProvider(tonEvmClient(tonEvmQuote(), {async tonBuildEscrowTransfer() { throw sdkError; }}));
    const r = await rejection(p.buildDeposit((await p.getQuote(tonEvmParams()))!));
    expect(r.error).toBe(sdkError);
    expect(r.error).toBeInstanceOf(FakeOmnistonError);
    expect(r.error.name).toBe("OmnistonError");
    expect(r.message).toBe("connection lost");
    expect(r.info).toEqual({reason: "upstream_unavailable"});
  });

  it("the venue's own reason on the escrow call: a dropped quote is quote_expired, the swap limit amount_too_large, another missing object upstream_unavailable, an invalid argument unclassified", async () => {
    const escrowFails = async (sdkError: Error) => {
      const p = tonEvmProvider(tonEvmClient(tonEvmQuote(), {async tonBuildEscrowTransfer() { throw sdkError; }}));
      const r = await rejection(p.buildDeposit((await p.getQuote(tonEvmParams()))!));
      expect(r.error).toBe(sdkError);
      expect(r.error).toBeInstanceOf(OmnistonError);
      expect(r.message).toBe(sdkError.message);
      return r.info;
    };
    expect(await escrowFails(venueError("Quote not found", "NOT_FOUND", {object_type: "quote", object_id: "q"}))).toEqual({reason: "quote_expired"});
    expect(await escrowFails(venueError("swap limit exceeded", "SWAP_LIMIT_EXCEEDED", {amount: "5000000", limit: "1000000"}))).toEqual({reason: "amount_too_large"});
    expect(await escrowFails(venueError("Order not found", "NOT_FOUND", {object_type: "order", object_id: "o"}))).toEqual({reason: "upstream_unavailable"});
    expect(await escrowFails(venueError("bad address", "INVALID_ARGUMENT", {argument_name: "traderDstAddress", expected: "address", actual: "x"}))).toBeUndefined();
  });

  it("recipient_mismatch: trackIntent with an intent id naming another trader; a malformed intent id stays unclassified", async () => {
    const p = tonEvmProvider(tonEvmClient(tonEvmQuote()));
    const q = (await p.getQuote(tonEvmParams()))!;
    const parts = q.intentId.split("|");
    parts[2] = encodeURIComponent(TON_ATTACKER);
    const r = await rejection(p.trackIntent({intentId: parts.join("|")}));
    expect(r.message).toBe("omniston: intent id does not match the quote it was issued for (trader)");
    expect(r.info).toEqual({reason: "recipient_mismatch"});
    const bad = await rejection(p.trackIntent({intentId: "omn1|q|trader|dest"}));
    expect(bad.message).toBe("omniston: malformed intent id");
    expect(bad.info).toBeUndefined();
  });
});

// ── EVM → TON orders (live 2026-10-16, Base USDT → TON USDT; clock pinned near the quote) ──────────────────────────

const evmTon = fixture("live-evm-ton-2026-10-16.json").chains.base;
const ET = {
  owner: evmTon.buildRequest.ownerSrcAddress as string,
  traderTon: evmTon.buildRequest.traderDstAddress as string,
  secret: hex(evmTon.buildRequest.secretHex),
  lop: "0xe7405fAcDEDB2512e91F2886BDff13231343aF5E",
  factory: "0xACa3E2F9b61a44892926bC6c3e104192E7D1c3cd",
  usdtTon: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs",
  trusted: {"ton:-239": ["EQAbWJ3Y1HgIIvcMq1prG1anlDC0T3cZlAU7luPT6LmTpmrZ"], "eip155:8453": ["0xACa3E2F9b61a44892926bC6c3e104192E7D1c3cd"]},
};
const evmTonPayload = () => ({typedData: evmTon.payload.typedData as string, orderExtension: hex(evmTon.payload.orderExtensionHex), serializedOrderDetails: hex(evmTon.payload.serializedOrderDetailsHex)});
function pinEvmTon() {
  vi.useFakeTimers({toFake: ["Date"], now: (evmTon.quoteUpdated.quoteTimestamp + 5) * 1000});
  vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => { array.set(ET.secret); return array; }) as never);
}
function evmTonClient(extra: Record<string, unknown> = {}) {
  const calls: Record<string, unknown[]> = {};
  const q = structuredClone(evmTon.quoteUpdated);
  return {
    calls,
    requestForQuote: () => observable([{$case: "ack", value: {rfqId: q.rfqId}}, {$case: "quoteUpdated", rfqId: q.rfqId, value: q}]),
    async evmBuildOrderPayload() { return evmTonPayload(); },
    async orderRegisterSignedOrder(request: unknown) { (calls.orderRegisterSignedOrder ??= []).push(request); },
    orderTrack: () => observable([]),
    async orderDiscloseHtlcSecret() {},
    tonBuildEscrowTransfer() { throw new Error("EVM-source orders never build a TON escrow"); },
    ...extra,
  };
}
function evmTonProvider(client: unknown, extra: Partial<OmnistonProviderOptions> = {}) {
  return omnistonProvider({
    client: client as never, quoteSettleMs: 0, maxHtlcExecutions: 1, trustedSettlementContracts: ET.trusted,
    trustedEvmOrderProtocols: {"eip155:8453": [ET.lop]}, validateEvmInputPosition: () => true, validateTonOutputPosition: () => true, ...extra,
  });
}
const evmTonParams = (extra: Record<string, unknown> = {}): QuoteParams => ({
  sourceChain: "eip155:8453", sourceToken: "USDT", destChain: "ton:-239", destToken: ET.usdtTon,
  amountIn: "20000000", destAddress: ET.traderTon, refundAddress: ET.owner, slippageBps: 100, dry: false, ...extra,
} as QuoteParams);

describe("EVM → TON quote, build and registration", () => {
  it("recipient_mismatch / vault_mismatch / unsupported_pair at quote time", async () => {
    pinEvmTon();
    expect((await refusals(evmTonProvider(evmTonClient()), evmTonParams({destAddress: ET.owner}))).calls)
      .toEqual([["omniston: destination is not a TON address", {reason: "recipient_mismatch"}]]);
    expect((await refusals(evmTonProvider(evmTonClient()), evmTonParams({refundAddress: ET.traderTon}))).calls)
      .toEqual([["omniston: refundAddress is not an EVM address", {reason: "recipient_mismatch"}]]);
    expect((await refusals(evmTonProvider(evmTonClient(), {trustedEvmOrderProtocols: {"eip155:8453": ["0x0000000000000000000000000000000000000001"]}}), evmTonParams())).calls)
      .toEqual([[`omniston: untrusted eip155:8453 order protocol ${ET.lop}`, {reason: "vault_mismatch"}]]);
    expect((await refusals(evmTonProvider(evmTonClient(), {validateTonOutputPosition: undefined} as never), evmTonParams())).calls)
      .toEqual([["omniston: EVM→TON needs the EVM input-position and TON output-position validators", {reason: "unsupported_pair"}]]);
  });

  it("policy_refused: the venue's typed order drifts from the quote (maker swapped)", async () => {
    pinEvmTon();
    const drift = evmTonPayload();
    const td = JSON.parse(drift.typedData);
    td.message.maker = EVM_ATTACKER;
    drift.typedData = JSON.stringify(td);
    const p = evmTonProvider(evmTonClient({async evmBuildOrderPayload() { return drift; }}));
    const r = await rejection(p.buildDeposit((await p.getQuote(evmTonParams()))!));
    expect(r.message).toBe("omniston: EVM order fields do not match the validated quote/request");
    expect(r.info).toEqual({reason: "policy_refused"});
  });

  it("upstream_unavailable: the SDK's order-payload call fails — the same error, tagged", async () => {
    pinEvmTon();
    const sdkError = new FakeOmnistonError("resolver offline");
    const p = evmTonProvider(evmTonClient({async evmBuildOrderPayload() { throw sdkError; }}));
    const r = await rejection(p.buildDeposit((await p.getQuote(evmTonParams()))!));
    expect(r.error).toBe(sdkError);
    expect(r.message).toBe("resolver offline");
    expect(r.info).toEqual({reason: "upstream_unavailable"});
  });

  it("quote_expired / recipient_mismatch / policy_refused: an expired quote, an intent bound to another recipient or chain, a replaced or pre-update quote", async () => {
    pinEvmTon();
    const p = evmTonProvider(evmTonClient());
    const q = (await p.getQuote(evmTonParams()))!;
    const expired = await rejection(p.buildDeposit({...q, validUntilMs: Date.now() - 1}));
    expect(expired.message).toBe("omniston: quote expired — request a fresh quote");
    expect(expired.info).toEqual({reason: "quote_expired"});

    const parts = q.intentId.split("|");
    const [dest, digest] = decodeURIComponent(parts[3]!).split("#") as [string, string];
    const withPart = (index: number, value: string) => { const next = [...parts]; next[index] = encodeURIComponent(value); return {...q, intentId: next.join("|")}; };
    const otherDest = await rejection(p.buildDeposit(withPart(3, `${TON_ATTACKER}#${digest}`)));
    expect(otherDest.message).toBe("omniston: intent id does not match the quote it was issued for (dest)");
    expect(otherDest.info).toEqual({reason: "recipient_mismatch"});
    const otherChain = await rejection(p.buildDeposit(withPart(4, "eip155:1")));
    expect(otherChain.message).toBe("omniston: intent id does not match the quote it was issued for (srcChain)");
    expect(otherChain.info).toEqual({reason: "policy_refused"});
    const replaced = await rejection(p.buildDeposit(withPart(3, `${dest}#${"0".repeat(32)}`)));
    expect(replaced.message).toBe("omniston: quote was replaced — request a fresh quote");
    expect(replaced.info).toEqual({reason: "policy_refused"});
    const old = await rejection(p.buildDeposit(withPart(3, dest)));
    expect(old.message).toBe("omniston: this quote was issued before an update — request a fresh quote");
    expect(old.info).toEqual({reason: "quote_expired"});
  });

  it("registerSignedOrder: upstream_unavailable when the SDK fails, quote_expired without the order context, a malformed signature unclassified", async () => {
    pinEvmTon();
    const sdkError = new FakeOmnistonError("signature rejected");
    const p = evmTonProvider(evmTonClient({async orderRegisterSignedOrder() { throw sdkError; }}));
    const q = (await p.getQuote(evmTonParams()))!;
    await p.buildDeposit(q);
    const signature = `0x${"ab".repeat(65)}`;
    const failed = await rejection(p.registerSignedOrder!(q.intentId, signature));
    expect(failed.error).toBe(sdkError);
    expect(failed.message).toBe("signature rejected");
    expect(failed.info).toEqual({reason: "upstream_unavailable"});
    const gone = await rejection(p.registerSignedOrder!(q.intentId.replace(evmTon.quoteUpdated.quoteId, "ff".repeat(32)), signature));
    expect(gone.message).toBe("omniston: no signed-order context for this quote — build the order again");
    expect(gone.info).toEqual({reason: "quote_expired"});
    const malformed = await rejection(p.registerSignedOrder!(q.intentId, "0x1234"));
    expect(malformed.message).toBe("omniston: malformed order signature");
    expect(malformed.info).toBeUndefined();
  });

  it("registerSignedOrder / buildDeposit: the venue's own reason — a quote it no longer holds is quote_expired, an unsupported operation unsupported_pair", async () => {
    pinEvmTon();
    const dropped = venueError("Quote not found", "NOT_FOUND", {object_type: "quote", object_id: evmTon.quoteUpdated.quoteId});
    const p = evmTonProvider(evmTonClient({async orderRegisterSignedOrder() { throw dropped; }}));
    const q = (await p.getQuote(evmTonParams()))!;
    await p.buildDeposit(q);
    const r = await rejection(p.registerSignedOrder!(q.intentId, `0x${"ab".repeat(65)}`));
    expect(r.error).toBe(dropped);
    expect(r.message).toBe("Quote not found");
    expect(r.info).toEqual({reason: "quote_expired"});

    const unsupported = venueError("operation is not supported", "UNSUPPORTED", {type: "UNSUPPORTED_OPERATION"});
    const b = evmTonProvider(evmTonClient({async evmBuildOrderPayload() { throw unsupported; }}));
    const built = await rejection(b.buildDeposit((await b.getQuote(evmTonParams()))!));
    expect(built.error).toBe(unsupported);
    expect(built.message).toBe("operation is not supported");
    expect(built.info).toEqual({reason: "unsupported_pair"});
  });

  it("validateEvmToTonOrderExtension: recipient_mismatch, vault_mismatch, policy_refused; an invalid argument stays unclassified", async () => {
    const q = evmTon.quoteUpdated, s = q.settlementData.value, td = JSON.parse(evmTon.payload.typedData);
    const expected = {
      quoteId: q.quoteId, quoteTimestamp: q.quoteTimestamp, tradeStartDeadline: s.tradeStartDeadline,
      protocolFeePips: s.protocolFeePips, integratorFeePips: s.integratorFeePips ?? 0,
      initialResolverAddress: s.srcInitialResolverAddress.chain.value, outputTokenAddress: ET.usdtTon, traderDstAddress: ET.traderTon,
      takerAsset: td.message.takerAsset, srcSecurityDepositUnits: s.srcHtlcSecurityDepositUnits, dstSecurityDepositUnits: "0",
      secretHash: hex(keccak256(ET.secret).slice(2)), trustedTarget: () => true,
    };
    const ext = () => hex(evmTon.payload.orderExtensionHex);
    await expect(validateEvmToTonOrderExtension(ext(), expected)).resolves.toBeUndefined();
    const recipient = await rejection(validateEvmToTonOrderExtension(ext(), {...expected, traderDstAddress: TON_ATTACKER}));
    expect(recipient.message).toBe("omniston: signed EVM→TON address does not match the validated request");
    expect(recipient.info).toEqual({reason: "recipient_mismatch"});
    const target = await rejection(validateEvmToTonOrderExtension(ext(), {...expected, trustedTarget: () => false}));
    expect(target.message).toBe("omniston: EVM order extension target is not independently trusted");
    expect(target.info).toEqual({reason: "vault_mismatch"});
    const profile = await rejection(validateEvmToTonOrderExtension(ext(), {...expected, quoteTimestamp: q.quoteTimestamp + 61}));
    expect(profile.message).toBe("omniston: EVM amount-getter terms do not match the pinned v1beta8 profile");
    expect(profile.info).toEqual({reason: "policy_refused"});
    const argument = await rejection(validateEvmToTonOrderExtension(ext(), {...expected, dstChainId: -1}));
    expect(argument.message).toBe("omniston: invalid EVM destination chain id");
    expect(argument.info).toBeUndefined();
  });
});

// ── TON ↔ TON swap settlement (DeDust CPMM v2 bodies in the real layout) ─────────────────────────────────────────────

const TT = {
  trader: "UQCbXJ1-Hd_CyyAt3TNgircduNIn5QH5dj1_LBNz__y4fQaq",
  usdt: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs",
  pool: "EQAH4MY1EbqP7Gg2wJkoZvoCG4BYPsEG5lVBXPZn0UqXNz4y",
  quoteId: "ab".repeat(32),
  trusted: {"ton:-239": ["UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ"], "eip155:1": ["0x0000000000000000000000000000000000000001"]},
};
const native = {chain: {$case: "ton", value: {kind: {$case: "native", value: {}}}}};
const jetton = (a: string) => ({chain: {$case: "ton", value: {kind: {$case: "jetton", value: a}}}});
function swapQuote(extra: Record<string, unknown> = {}) {
  return {
    rfqId: "rfq1", quoteId: TT.quoteId, inputAsset: native, outputAsset: jetton(TT.usdt), inputUnits: "1000000000", outputUnits: "1419292",
    protocolFeeUnits: "0", integratorFeeUnits: "0", quoteTimestamp: Math.floor(Date.now() / 1000), gasBudget: "100000000",
    settlementData: {$case: "swap", value: {
      routes: [{steps: [{inputAsset: native, outputAsset: jetton(TT.usdt), chunks: [{protocol: "DeDustCPMMV2", inputUnits: "1000000000", outputUnits: "1419292"}]}]}],
      minOutputAmount: "1418292", recommendedMinOutputAmount: "1418792", recommendedSlippagePips: 5000,
    }},
    ...extra,
  };
}
/** DeDust CPMM v2 pay_native: the payment payload (min out) and the payout config (fulfill → `fulfill`, reject / excess → trader). */
function payNative(minOut: bigint, opts: {fulfill?: string; op?: number} = {}): string {
  const trader = Address.parse(TT.trader);
  const payment = beginCell().storeUint(0xc442500f, 32).storeCoins(minOut).storeUint(0, 40).storeMaybeRef(null).storeBit(false).storeBit(false).endCell();
  const option = (b: Builder, to: Address) => b.storeAddress(to).storeCoins(0).storeMaybeRef(null).storeBit(false);
  const payout = option(option(beginCell(), Address.parse(opts.fulfill ?? TT.trader)), trader).storeAddress(trader).endCell();
  return beginCell().storeUint(opts.op ?? 0xa5a7cbf8, 32).storeUint(1, 64).storeCoins(1000000000n).storeRef(payment).storeRef(payout).endCell().toBoc().toString("hex");
}
function swapClient(quote: unknown, message: {targetAddress: string; sendAmount: string; payload: string} | null, extra: Record<string, unknown> = {}) {
  return {
    requestForQuote: () => observable([{$case: "ack", value: {rfqId: "rfq1"}}, ...(quote ? [{$case: "quoteUpdated", rfqId: "rfq1", value: quote}] : [])]),
    async tonBuildSwap() { return {messages: message ? [message] : []}; },
    swapTrack: () => observable([]),
    orderTrack() { throw new Error("must not track an order for a swap"); },
    tonBuildEscrowTransfer() { throw new Error("must not build an escrow for a swap"); },
    ...extra,
  };
}
function swapProvider(client: unknown, extra: Partial<OmnistonProviderOptions> = {}) {
  return omnistonProvider({
    client: client as never, enabled: true, trustedSettlementContracts: TT.trusted, quoteSettleMs: 0,
    validateTonJettonWallet: () => true, validateTonSwapTarget: () => true, validateTonSwapLeg: () => true, ...extra,
  });
}
const swapParams = (extra: Record<string, unknown> = {}): QuoteParams => ({
  sourceChain: "ton:-239", sourceToken: "GRAM", destChain: "ton:-239", destToken: TT.usdt,
  amountIn: "1000000000", destAddress: TT.trader, refundAddress: TT.trader, dry: false, ...extra,
} as QuoteParams);
const goodMessage = () => ({targetAddress: TT.pool, sendAmount: "1100000000", payload: payNative(1418292n)});
async function buildWith(message: {targetAddress: string; sendAmount: string; payload: string}, extra: Partial<OmnistonProviderOptions> = {}, client?: unknown) {
  const p = swapProvider(client ?? swapClient(swapQuote(), message), extra);
  const q = await p.getQuote(swapParams());
  expect(q).not.toBeNull();
  return rejection(p.buildDeposit(q!));
}

describe("TON ↔ TON swaps: quote refusals and build refusals", () => {
  it("no_route / upstream_unavailable on the swap RFQ", async () => {
    expect((await refusals(swapProvider(swapClient(null, null)), swapParams())).calls)
      .toEqual([["omniston: no TON DEX route quoted this pair/amount", {reason: "no_route"}]]);
    expect((await refusals(swapProvider(swapClient(swapQuote({quoteId: "abc123"}), null)), swapParams())).calls)
      .toEqual([["omniston: swap quote rejected: malformed quote id", {reason: "upstream_unavailable"}]]);
  });

  it("policy_refused: more TON than the quoted gas budget; vault_mismatch: a target the app does not recognize as a DEX", async () => {
    const greedy = await buildWith({...goodMessage(), sendAmount: "1300000000"});
    expect(greedy.message).toBe("omniston: swap message attaches more TON than the quoted gas budget (300000000 > 100000000 nanoTON, cap 2000000000, DeDustCPMMV2)");
    expect(greedy.info).toEqual({reason: "policy_refused"});
    const target = await buildWith(goodMessage(), {validateTonSwapTarget: () => false});
    expect(target.message).toBe("omniston: swap target is not a recognized DEX contract for the quoted protocol");
    expect(target.info).toEqual({reason: "vault_mismatch"});
  });

  it("the decoded body: unknown layout (policy_refused), minimum under the quote (price_check_failed), output elsewhere (recipient_mismatch), DEX leg not confirmed (vault_mismatch)", async () => {
    const layout = await buildWith({...goodMessage(), payload: payNative(1418292n, {op: 0x12345678})});
    expect(layout.message).toBe("omniston: ton-swap-payload unknown-layout — omniston: ton-swap-payload unknown-layout (native DeDust CPMM v2 input op 0x12345678)");
    expect(layout.info).toEqual({reason: "policy_refused"});
    const min = await buildWith({...goodMessage(), payload: payNative(1418000n)});
    expect(min.message).toBe("omniston: ton-swap-payload min-out-below-quote — omniston: ton-swap-payload min-out-below-quote (1418000 < 1418292)");
    expect(min.info).toEqual({reason: "price_check_failed"});
    const receiver = await buildWith({...goodMessage(), payload: payNative(1418292n, {fulfill: TON_ATTACKER})});
    expect(receiver.message).toBe("omniston: ton-swap-payload receiver-not-destination — omniston: ton-swap-payload receiver-not-destination (DeDust CPMM v2 fulfill destination)");
    expect(receiver.info).toEqual({reason: "recipient_mismatch"});
    const leg = await buildWith(goodMessage(), {validateTonSwapLeg: () => false});
    expect(leg.message).toBe(`omniston: ton-swap-payload leg-unverified — dedust-pool v2 pool ${TT.pool}`);
    expect(leg.info).toEqual({reason: "vault_mismatch"});
  });

  it("upstream_unavailable when the SDK's swap build fails; unsupported_pair when the injected client cannot build swaps", async () => {
    const sdkError = new FakeOmnistonError("swap build failed");
    const failed = await buildWith(goodMessage(), {}, swapClient(swapQuote(), goodMessage(), {async tonBuildSwap() { throw sdkError; }}));
    expect(failed.error).toBe(sdkError);
    expect(failed.message).toBe("swap build failed");
    expect(failed.info).toEqual({reason: "upstream_unavailable"});
    const old = await buildWith(goodMessage(), {}, swapClient(swapQuote(), goodMessage(), {tonBuildSwap: undefined}));
    expect(old.message).toBe("omniston: client does not support swap settlement (tonBuildSwap)");
    expect(old.info).toEqual({reason: "unsupported_pair"});
  });

  it("the venue's emulation of the swap build (QUOTE_VALIDATION_FAILED): a failed swap is simulation_failed, a wrong output or a slippage refund price_check_failed, an unsupported token unsupported_pair", async () => {
    const swapBuildFails = async (sdkError: Error) => {
      const r = await buildWith(goodMessage(), {}, swapClient(swapQuote(), goodMessage(), {async tonBuildSwap() { throw sdkError; }}));
      expect(r.error).toBe(sdkError);
      expect(r.message).toBe(sdkError.message);
      return r.info;
    };
    expect(await swapBuildFails(venueError("emulation: swap failed", "QUOTE_VALIDATION_FAILED", {type: "EMULATION_SWAP_FAILED", protocol: "DeDustCPMMV2", status: "failed"})))
      .toEqual({reason: "simulation_failed"});
    expect(await swapBuildFails(venueError("emulation: out of gas", "QUOTE_VALIDATION_FAILED", {type: "EMULATION_SWAP_INSUFFICIENT_GAS"})))
      .toEqual({reason: "simulation_failed"});
    expect(await swapBuildFails(venueError("emulation: wrong output", "QUOTE_VALIDATION_FAILED", {type: "EMULATION_WRONG_OUTPUT_AMOUNT", expected: "1418292", actual: "1000"})))
      .toEqual({reason: "price_check_failed"});
    expect(await swapBuildFails(venueError("emulation: refunded", "QUOTE_VALIDATION_FAILED", {type: "EMULATION_REFUND_SLIPPAGE"})))
      .toEqual({reason: "price_check_failed"});
    expect(await swapBuildFails(venueError("emulation: token", "QUOTE_VALIDATION_FAILED", {type: "EMULATION_UNSUPPORTED_TOKEN", token_address: TT.usdt})))
      .toEqual({reason: "unsupported_pair"});
  });

  it("the swap RFQ stream's venue reason: an unsupported route is unsupported_pair, the text unchanged", async () => {
    const client = swapClient(null, null, {requestForQuote: () => observable((o) => o.error?.(venueError("route is not supported", "UNSUPPORTED", {type: "UNSUPPORTED_ROUTE"})))});
    expect((await refusals(swapProvider(client), swapParams())).calls)
      .toEqual([["omniston: RFQ failed: route is not supported", {reason: "unsupported_pair"}]]);
  });
});

// ── omnistonVerifyBuild + omnistonPins(...).reasonOf (the app's check of a remote build) ───────────────────────────

const pins = omnistonPins(AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS);
/** A verify text and the reason pins.reasonOf gives it. */
async function verified(text: Promise<string | null>): Promise<[string | null, Swap2RefusalInfo | undefined]> {
  const t = await text;
  return [t, t === null ? undefined : pins.reasonOf!(t)];
}

describe("omnistonVerifyBuild: each returned text keeps its wording; omnistonPins(...).reasonOf classifies it", () => {
  async function evmTonBuild() {
    pinEvmTon();
    const real = evmTonProvider(evmTonClient(), {trustedSettlementContracts: {...AUDITED_OMNISTON_SETTLEMENT_CONTRACTS, ...ET.trusted}, trustedEvmOrderProtocols: AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS});
    const params = evmTonParams();
    const quote = (await real.getQuote(params)) as Quote;
    const tx = await real.buildDeposit(quote);
    return {quote, tx, params};
  }
  const withMessage = (tx: UnsignedTx, over: Record<string, string>): UnsignedTx => {
    const td = JSON.parse(tx.typedData!);
    Object.assign(td.message, over);
    return {...tx, typedData: JSON.stringify(td)};
  };

  it("EVM typed orders: price_check_failed, recipient_mismatch, vault_mismatch, quote_expired, policy_refused", async () => {
    const {quote, tx, params} = await evmTonBuild();
    const verify = omnistonVerifyBuild({...createOmnistonTonValidators()});
    expect(await verify(quote, tx, params)).toBeNull();
    expect(await verified(verify(quote, withMessage(tx, {takingAmount: "1"}), params)))
      .toEqual(["takingAmount 1 is below the quote's minimum 20344594", {reason: "price_check_failed"}]);
    expect(await verified(verify(quote, withMessage(tx, {receiver: EVM_ATTACKER}), params)))
      .toEqual(["the order's receiver is not the resolver its extension whitelists", {reason: "recipient_mismatch"}]);
    expect(await verified(verify(quote, tx, {...params, destAddress: TON_ATTACKER})))
      .toEqual(["signed EVM→TON address does not match the validated request", {reason: "recipient_mismatch"}]);
    expect(await verified(omnistonVerifyBuild({validateTonSwapTarget: () => true, trustedEvmOrderProtocols: {}})(quote, tx, params)))
      .toEqual(["0xe7405facdedb2512e91f2886bdff13231343af5e is not a trusted order protocol on eip155:8453", {reason: "vault_mismatch"}]);
    expect(await verified(omnistonVerifyBuild({validateTonSwapTarget: () => true, trustedSettlementContracts: {}})(quote, tx, params)))
      .toEqual([`the extension targets ${ET.factory}, not a trusted escrow factory on eip155:8453`, {reason: "vault_mismatch"}]);
    const traits = BigInt(JSON.parse(tx.typedData!).message.makerTraits);
    expect(await verified(verify(quote, withMessage(tx, {makerTraits: toHex(traits | (((1n << 40n) - 1n) << 80n))}), params)))
      .toEqual(["the order's expiry is not minutes away", {reason: "policy_refused"}]);
    const recommit = {...withMessage(tx, {salt: toHex((BigInt(JSON.parse(tx.typedData!).message.salt) & ~((1n << 160n) - 1n)) | (BigInt(keccak256("0x00")) & ((1n << 160n) - 1n)))}), orderExtension: "0x00"};
    expect(await verified(verify(quote, recommit, params))).toEqual(["malformed EVM order extension", {reason: "policy_refused"}]);
    expect(await verified(verify(quote, tx))).toEqual(["the request this quote answered is unknown", {reason: "policy_refused"}]);
    vi.setSystemTime(Number((traits >> 80n) & ((1n << 40n) - 1n)) * 1000 + 1000);
    expect(await verified(verify(quote, tx, params))).toEqual(["the order's expiry is not minutes away", {reason: "quote_expired"}]);
  });

  it("TON → EVM escrow bodies: vault_mismatch, price_check_failed, policy_refused, recipient_unverifiable, unsupported_pair", async () => {
    const message = tonEvm.escrowResponse.messages[0];
    const resolverSends = tonEvm.quoteUpdated.value.settlementData.value.resolverSendsUnits as string;
    const quote = {intentId: "omniston:order", sourceAmount: "5000000", minDestAmount: resolverSends} as Quote;
    const tx: UnsignedTx = {chain: "ton:-239", to: message.targetAddress, value: message.sendAmount, bodyBoc: b64(message.payload)};
    const params = tonEvmParams({dry: false});
    const rev1 = {trustedProtocolAddresses: ["EQAbWJ3Y1HgIIvcMq1prG1anlDC0T3cZlAU7luPT6LmTpmrZ"]};
    expect(await omnistonVerifyBuild({...createOmnistonTonValidators(rev1)})(quote, tx, params)).toBeNull();
    expect(await verified(omnistonVerifyBuild({...createOmnistonTonValidators()})(quote, tx, params)))
      .toEqual(["the escrow transfer pays EQAbWJ3Y1HgIIvcMq1prG1anlDC0T3cZlAU7luPT6LmTpmrZ, not an Omniston protocol contract this app trusts", {reason: "vault_mismatch"}]);
    const above = (BigInt(resolverSends) + 1n).toString();
    expect(await verified(omnistonVerifyBuild({...createOmnistonTonValidators(rev1)})({...quote, minDestAmount: above}, tx, params)))
      .toEqual([`the resolver is bound to deliver ${resolverSends}, under the quote's minimum ${above}`, {reason: "price_check_failed"}]);
    expect(await verified(omnistonVerifyBuild({...createOmnistonTonValidators(rev1)})(quote, tx, {...params, destAddress: EVM_ATTACKER})))
      .toEqual(["the escrow body is not this swap's (owner, destination chain, address or token) or not the audited escrow (code, authority, timelocks)", {reason: "policy_refused"}]);
    expect(await verified(omnistonVerifyBuild({...createOmnistonTonValidators(rev1)})(quote, tx, {...params, refundAddress: undefined} as never)))
      .toEqual(["the trader's TON address (refundAddress) is unknown", {reason: "recipient_unverifiable"}]);
    expect(await verified(omnistonVerifyBuild({validateTonSwapTarget: () => true})(quote, tx, params)))
      .toEqual(["a TON → EVM escrow body needs verifyTonEscrowBuild (createOmnistonTonValidators)", {reason: "unsupported_pair"}]);
    expect(await verified(omnistonVerifyBuild({validateTonSwapTarget: () => true, verifyTonEscrowBuild: () => { throw new Error("boom"); }})(quote, tx, params)))
      .toEqual(["the escrow body could not be checked", {reason: "policy_refused"}]);
    expect(await verified(omnistonVerifyBuild({validateTonSwapTarget: () => true})(quote, tx, {...params, destChain: "ton:-239"})))
      .toEqual(["only TON swap and TON → EVM escrow bodies can be checked on the client", {reason: "unsupported_pair"}]);
  });

  it("TON swap bodies: vault_mismatch (target, leg), unsupported_pair (no leg check), price_check_failed (decoded minimum)", async () => {
    const p = swapProvider(swapClient(swapQuote(), goodMessage()));
    const params = swapParams();
    const quote = (await p.getQuote(params))!;
    const tx = await p.buildDeposit(quote);
    expect(await omnistonVerifyBuild({validateTonSwapTarget: () => true, validateTonSwapLeg: () => true})(quote, tx, params)).toBeNull();
    expect(await verified(omnistonVerifyBuild({validateTonSwapTarget: () => false, validateTonSwapLeg: () => true})(quote, tx, params)))
      .toEqual([`${TT.pool} is not a recognized DEX contract for DeDustCPMMV2`, {reason: "vault_mismatch"}]);
    expect(await verified(omnistonVerifyBuild({validateTonSwapTarget: () => true})(quote, tx, params)))
      .toEqual(["a TON swap body needs validateTonSwapLeg (createOmnistonTonValidators)", {reason: "unsupported_pair"}]);
    expect(await verified(omnistonVerifyBuild({validateTonSwapTarget: () => true, validateTonSwapLeg: () => false})(quote, tx, params)))
      .toEqual(["dedust-pool v2 leg not verified", {reason: "vault_mismatch"}]);
    const low = {...tx, bodyBoc: b64(payNative(1418000n))};
    expect(await verified(omnistonVerifyBuild({validateTonSwapTarget: () => true, validateTonSwapLeg: () => true})(quote, low, params)))
      .toEqual(["ton-swap-payload min-out-below-quote (1418000 < 1418292)", {reason: "price_check_failed"}]);
    expect(pins.reasonOf!("a text these pins never produced")).toBeUndefined();
  });

  it("one set of notes per realm: pins from one copy of the module read the texts another copy's omnistonVerifyBuild returned (the CommonJS build bundles a copy per entry)", async () => {
    vi.resetModules();
    const other = await import("../src/provider.js");
    expect(other.omnistonPins).not.toBe(omnistonPins);
    expect(other.omnistonVerifyBuild).not.toBe(omnistonVerifyBuild);
    const message = tonEvm.escrowResponse.messages[0];
    const quote = {intentId: "omniston:order", sourceAmount: "5000000", minDestAmount: "1"} as Quote;
    const tx: UnsignedTx = {chain: "ton:-239", to: message.targetAddress, value: message.sendAmount, bodyBoc: b64(message.payload)};
    const params = tonEvmParams({dry: false});
    const fromOther = "the escrow transfer pays EQ-only-the-second-copy, not an Omniston protocol contract this app trusts";
    expect(await other.omnistonVerifyBuild({validateTonSwapTarget: () => true, verifyTonEscrowBuild: () => fromOther})(quote, tx, params)).toBe(fromOther);
    expect(pins.reasonOf!(fromOther)).toEqual({reason: "vault_mismatch"});
    const fromThis = "the resolver is bound to deliver 1, under the quote's minimum 2 (only the first copy)";
    expect(await omnistonVerifyBuild({validateTonSwapTarget: () => true, verifyTonEscrowBuild: () => fromThis})(quote, tx, params)).toBe(fromThis);
    expect(other.omnistonPins(AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS).reasonOf!(fromThis)).toEqual({reason: "price_check_failed"});
  });
});

// ── End to end: the real provider behind the swap2 server handler, the app's remoteProvider with the pins ───────────

describe("remote: the reason reaches the app's stub (server handler → remoteProvider + omnistonPins + omnistonVerifyBuild)", () => {
  function stub(backendOptions: Partial<OmnistonProviderOptions>, tamper?: (tx: UnsignedTx) => UnsignedTx) {
    const real = evmTonProvider(evmTonClient(), {
      trustedSettlementContracts: {...AUDITED_OMNISTON_SETTLEMENT_CONTRACTS, ...ET.trusted}, trustedEvmOrderProtocols: AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS, ...backendOptions,
    });
    const handle = createSwap2Handler<string>({providers: [real], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const action = String(url).split("/").pop()!;
      const res = await handle(action, JSON.parse(String(init.body)), "alice");
      const body = action === "build" && tamper && res.status === 200 ? tamper(res.body as UnsignedTx) : res.body;
      return new Response(JSON.stringify(body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
    return remoteProvider({
      name: "omniston", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl,
      ...omnistonPins(AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS), verifyBuild: omnistonVerifyBuild({...createOmnistonTonValidators()}),
    });
  }

  it("a backend refusal (an untrusted order protocol) arrives as the stub's error with its reason", async () => {
    pinEvmTon();
    const r = await rejection(stub({trustedEvmOrderProtocols: {"eip155:8453": ["0x0000000000000000000000000000000000000001"]}}).getQuote(evmTonParams()));
    expect(r.message).toBe(`omniston: untrusted eip155:8453 order protocol ${ET.lop}`);
    expect(r.info).toEqual({reason: "vault_mismatch"});
  });

  it("a tampered build fails the app's own check: the stub's error carries the reason pins.reasonOf gives", async () => {
    pinEvmTon();
    const evil = stub({}, (tx) => {
      const td = JSON.parse(tx.typedData!);
      td.message.takingAmount = "1";
      return {...tx, typedData: JSON.stringify(td)};
    });
    const quote = (await evil.getQuote(evmTonParams()))!;
    const r = await rejection(evil.buildDeposit(quote));
    expect(r.message).toBe("omniston: the build fails this app's own check — takingAmount 1 is below the quote's minimum 20344594");
    expect(r.info).toEqual({reason: "price_check_failed"});
  });
});

describe("not refusals: configuration errors stay unclassified", () => {
  it("constructor option validation throws plain, unclassified errors", () => {
    for (const options of [{maxHtlcExecutions: 0}, {apiUrl: "https://omni.invalid"}, {integratorAddress: "UQfees"}, {trustedSettlementContracts: {"eip155:1": ["not-an-address"]}}]) {
      let thrown: unknown;
      try { omnistonProvider(options as OmnistonProviderOptions); } catch (e) { thrown = e; }
      expect(thrown, JSON.stringify(options)).toBeInstanceOf(Error);
      expect(refusalOf(thrown), JSON.stringify(options)).toBeUndefined();
    }
  });
});
