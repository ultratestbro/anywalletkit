import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {RELAY_DEPOSIT_ERC20, relayChain} from "../src/config.js";
import {RELAY_STATUS_MAP, relayProvider} from "../src/provider.js";
import {relayPins} from "../src/verify.js";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router";
import {depositOf, loadQuote, protoOf, type QuoteFixture} from "./fixtures.js";

const OTHER = "0x1111111111111111111111111111111111111111";
const USDC = "user.arb-usdc_base-usdc";
const ETH = "user.op-eth_base-eth";

/** The `QuoteParams` a fixture's request is. */
function paramsOf(f: QuoteFixture, over: Partial<QuoteParams> = {}): QuoteParams & {reasons: string[]} {
  const reasons: string[] = [];
  return {
    sourceChain: f.request.sourceChain, destChain: f.request.destChain, sourceToken: f.request.sourceToken, destToken: f.request.destToken,
    amountIn: f.request.amount, destAddress: f.request.recipient, refundAddress: f.request.depositor, dry: false,
    onRefusal: (r) => reasons.push(r), reasons, ...over,
  };
}
interface Seen {url: string; init?: RequestInit}
function serve(body: unknown, seen: Seen[] = [], status = 200): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({url: String(url), ...(init ? {init} : {})});
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {status});
  }) as typeof fetch;
}
const at = (f: QuoteFixture, plusMs = 0) => vi.setSystemTime(f.request.nowMs + plusMs);
async function quoted(name: string, over: Partial<QuoteParams> = {}, edit: (f: QuoteFixture) => void = () => undefined) {
  const f = loadQuote(name);
  edit(f);
  at(f);
  const seen: Seen[] = [];
  const provider = relayProvider({fetchImpl: serve(f.response, seen)});
  const params = paramsOf(f, over);
  const quote = await provider.getQuote(params);
  return {f, provider, params, quote, seen};
}

beforeEach(() => { vi.useFakeTimers({toFake: ["Date"]}); });
afterEach(() => { vi.useRealTimers(); });

describe("getQuote", () => {
  it("asks Relay for the order itself and returns the deposit built here", async () => {
    const {f, quote, seen, params} = await quoted(USDC);
    expect(params.reasons).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.relay.link/quote/v2");
    const asked = JSON.parse(seen[0]!.init!.body as string) as Record<string, unknown>;
    expect(asked).toEqual({
      user: f.request.depositor, recipient: f.request.recipient, refundTo: f.request.depositor,
      originChainId: 42161, destinationChainId: 8453,
      originCurrency: f.request.sourceToken.toLowerCase(), destinationCurrency: f.request.destToken.toLowerCase(),
      amount: f.request.amount, tradeType: "EXACT_INPUT", includeProtocolData: true,
    });
    expect((seen[0]!.init!.headers as Record<string, string>)["x-api-key"]).toBeUndefined();
    const order = protoOf(f).orderData;
    expect(quote).toMatchObject({
      provider: "relay", intentId: `relay:${f.response.steps.find((s) => s.id === "deposit")!.requestId}`, depositAddress: "",
      sourceAmount: f.request.amount,
      destAmount: order.output.payments[0]!.expectedAmount,
      minDestAmount: order.output.payments[0]!.minimumAmount,
    });
    const dep = relayChain("eip155:42161")!.depository;
    expect(quote!.txRequest).toMatchObject({to: dep, data: depositOf(f).data.toLowerCase(), value: "0", chainId: 42161, approvalAddress: dep});
    expect(quote!.txRequest!.data!.slice(0, 10)).toBe(RELAY_DEPOSIT_ERC20);
    expect(BigInt(quote!.txRequest!.gasLimit!)).toBeGreaterThanOrEqual(180_000n);
    expect(quote!.fees).toEqual([{type: "protocol", amount: "23744", token: f.request.sourceToken.toLowerCase(), included: true, description: "Relay fee"}]);
    expect(quote!.providerData!.orderId).toBe(protoOf(f).orderId);
    expect(quote!.providerData!.placeholder).toBeUndefined();
    // The minimum shown is the order's minimum, never its expected amount.
    expect(BigInt(quote!.minDestAmount!) < BigInt(quote!.destAmount)).toBe(true);
  });
  it("a native deposit carries the amount as value and no approval", async () => {
    const {f, quote} = await quoted(ETH);
    expect(quote!.txRequest).toMatchObject({value: f.request.amount, chainId: 10});
    expect(quote!.txRequest!.approvalAddress).toBeUndefined();
  });
  it("never takes the approval from the API: an approve step naming another spender changes nothing", async () => {
    const {quote, f} = await quoted(USDC, {}, (g) => {
      const approve = g.response.steps.find((s) => s.id === "approve")!;
      approve.items[0]!.data.data = `0x095ea7b3${OTHER.slice(2).padStart(64, "0")}${"f".repeat(64)}`;
      approve.items[0]!.data.to = OTHER;
    });
    expect(quote!.txRequest!.approvalAddress).toBe(relayChain(f.request.sourceChain)!.depository);
  });
  it("sends the key as x-api-key and talks to the configured base URL", async () => {
    const f = loadQuote(ETH);
    at(f);
    const seen: Seen[] = [];
    const provider = relayProvider({baseUrl: "https://proxy.example/relay/", apiKey: "test-key-not-a-real-one", fetchImpl: serve(f.response, seen)});
    expect(await provider.getQuote(paramsOf(f))).not.toBeNull();
    expect(seen[0]!.url).toBe("https://proxy.example/relay/quote/v2");
    expect((seen[0]!.init!.headers as Record<string, string>)["x-api-key"]).toBe("test-key-not-a-real-one");
  });
  it("refuses a bad configuration", () => {
    expect(() => relayProvider({baseUrl: "ftp://x"})).toThrow(/baseUrl/);
    expect(() => relayProvider({quoteTtlMs: 300_001})).toThrow(/quoteTtlMs/);
    expect(() => relayProvider({apiKey: "a\nb"})).toThrow(/apiKey/);
  });
  it("passes the caller's slippage on and holds the order to it", async () => {
    const ok = await quoted(ETH, {slippageBps: 200});
    expect(JSON.parse(ok.seen[0]!.init!.body as string).slippageTolerance).toBe("200");
    expect(ok.quote).not.toBeNull();
    const tight = await quoted(ETH, {slippageBps: 100}); // the order was issued at 200 bps
    expect(tight.quote).toBeNull();
    expect(tight.params.reasons[0]).toMatch(/\[output-minimum\]$/);
  });
  it("holds the order to the caller's floor", async () => {
    const {f} = await quoted(ETH);
    const min = BigInt(protoOf(f).orderData.output.payments[0]!.minimumAmount);
    expect((await quoted(ETH, {minAmountOut: min.toString()})).quote).not.toBeNull();
    const over = await quoted(ETH, {minAmountOut: (min + 1n).toString()});
    expect(over.quote).toBeNull();
    expect(over.params.reasons[0]).toMatch(/\[output-minimum\]$/);
  });

  it.each<[string, Partial<QuoteParams>, RegExp]>([
    ["a non-EVM source", {sourceChain: "solana:mainnet"}, /\[chain-unsupported\]$/],
    ["a non-EVM destination", {destChain: "tron:mainnet"}, /\[chain-unsupported\]$/],
    ["a chain Relay does not serve", {destChain: "eip155:14"}, /\[chain-unsupported\]$/],
    ["the same chain", {destChain: "eip155:42161"}, /\[chain-unsupported\]$/],
    ["a flexible amount", {flex: true}, /\[request-invalid\]$/],
    ["a live quote with no recipient", {destAddress: ""}, /\[request-invalid\]$/],
    ["a live quote with no sender", {refundAddress: ""}, /\[request-invalid\]$/],
    ["a non-EVM recipient", {destAddress: "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE"}, /\[request-invalid\]$/],
    ["a zero amount", {amountIn: "0"}, /\[request-invalid\]$/],
    ["a destination token that is not an address", {destToken: "USDC"}, /\[request-invalid\]$/],
  ])("refuses %s without asking the API", async (_n, over, why) => {
    const {quote, params, seen} = await quoted(USDC, over);
    expect(quote).toBeNull();
    expect(seen).toHaveLength(0);
    expect(params.reasons).toHaveLength(1);
    expect(params.reasons[0]).toMatch(why);
  });

  it.each<[string, (f: QuoteFixture) => void, RegExp]>([
    ["no steps", (f) => { f.response.steps = []; }, /\[quote-steps\]$/],
    ["an unknown step", (f) => { f.response.steps.push({id: "signature", requestId: f.response.steps[0]!.requestId, items: []}); }, /\[quote-steps\]$/],
    ["a swap step", (f) => { f.response.steps.unshift({id: "swap", requestId: f.response.steps[0]!.requestId, items: f.response.steps.at(-1)!.items}); }, /\[quote-steps\]$/],
    ["two deposits", (f) => { f.response.steps.push(f.response.steps.at(-1)!); }, /\[quote-steps\]$/],
    ["a deposit of two transactions", (f) => { const s = f.response.steps.at(-1)!; s.items.push(s.items[0]!); }, /\[quote-steps\]$/],
    ["only an approval", (f) => { f.response.steps = f.response.steps.filter((s) => s.id === "approve"); }, /\[quote-steps\]$/],
    ["no request id", (f) => { (f.response.steps.at(-1) as {requestId?: string}).requestId = "0x12"; }, /\[quote-steps\]$/],
    ["no protocol data", (f) => { delete (f.response as {protocol?: unknown}).protocol; }, /\[protocol-data-missing\]$/],
    ["a deposit into another contract", (f) => { depositOf(f).to = OTHER; }, /\[tx-target\]$/],
    ["the whole-allowance deposit", (f) => { const t = depositOf(f); t.data = `0x5a1ee3ac${t.data.slice(10, 138)}${t.data.slice(-64)}`; }, /\[tx-selector\]$/],
    ["an order paying someone else", (f) => { protoOf(f).orderData.output.payments[0]!.recipient = OTHER; }, /\[output-recipient\]$/],
    ["another order's signature", (f) => { protoOf(f).orderSignature = protoOf(loadQuote(ETH)).orderSignature; }, /\[signature-invalid\]$/],
  ])("refuses a response with %s, by name", async (_n, edit, why) => {
    const {quote, params} = await quoted(USDC, {}, edit);
    expect(quote).toBeNull();
    expect(params.reasons).toHaveLength(1);
    expect(params.reasons[0]).toMatch(/^relay: /);
    expect(params.reasons[0]).toMatch(why);
  });
  it("names an API refusal, a broken answer and a network failure", async () => {
    const f = loadQuote(USDC);
    at(f);
    const run = async (fetchImpl: typeof fetch) => {
      const p = paramsOf(f);
      expect(await relayProvider({fetchImpl}).getQuote(p)).toBeNull();
      return p.reasons[0]!;
    };
    expect(await run(serve({message: "Swap output amount is too small to cover fees", errorCode: "AMOUNT_TOO_LOW"}, [], 400))).toBe("relay: no quote — AMOUNT_TOO_LOW: Swap output amount is too small to cover fees");
    expect(await run(serve("<html>", [], 502))).toBe("relay: no quote — HTTP 502");
    expect(await run(serve("not json"))).toBe("relay: the quote response is not JSON");
    expect(await run((async () => { throw new Error("socket hang up https://proxy.example/secret?key=abc"); }) as typeof fetch)).toMatch(/^relay: quote request failed — socket hang up/);
    expect(await run((async () => { throw new Error("x https://proxy.example/secret?key=abc"); }) as typeof fetch)).not.toMatch(/key=abc/);
  });
  it("routes that swap on the source chain are refused with the router named", async () => {
    for (const name of ["arb-arb_base-eth", "pol-pol_base-eth", "mantle-mnt_base-eth", "ely-hype_arb-usdc"]) {
      const {quote, params} = await quoted(name);
      expect(quote).toBeNull();
      expect(params.reasons[0]).toMatch(/go through a router.*\[tx-target\]$/);
    }
  });
});

describe("a quote priced without addresses", () => {
  it("is marked, is not remembered, and is never built or signed", async () => {
    const f = loadQuote("base-eth_arb-eth"); // asked with the pricing placeholder as both parties
    at(f);
    const provider = relayProvider({fetchImpl: serve(f.response)});
    const quote = await provider.getQuote(paramsOf(f, {dry: true, destAddress: "", refundAddress: ""}));
    expect(quote).not.toBeNull();
    expect(quote!.providerData!.placeholder).toBe("1");
    await expect(provider.buildDeposit(quote!)).rejects.toThrow(/\[request-invalid\]$/);
    // Stripping the mark does not help: the placeholder is never a party to a deposit.
    const stripped = {...quote!, providerData: {...quote!.providerData!}};
    delete stripped.providerData.placeholder;
    await expect(provider.buildDeposit(stripped)).rejects.toThrow(/\[request-invalid\]$/);
    await expect(provider.preflightDeposit!(stripped, {chain: f.request.sourceChain, ...(quote!.txRequest as {to: string; value: string})} as UnsignedTx)).rejects.toThrow(/\[request-invalid\]$/);
  });
  it("a dry quote asked with the real addresses is a real order", async () => {
    const {quote, provider} = await quoted(ETH, {dry: true});
    expect(quote!.providerData!.placeholder).toBeUndefined();
    await expect(provider.buildDeposit(quote!)).resolves.toMatchObject({chain: "eip155:10"});
  });
});

describe("buildDeposit and preflightDeposit", () => {
  const built = async (name: string) => {
    const q = await quoted(name);
    const tx = await q.provider.buildDeposit(q.quote!);
    return {...q, quote: q.quote!, tx};
  };
  it("the build is the quote's own transaction", async () => {
    const {quote, tx} = await built(USDC);
    expect(tx).toEqual({chain: "eip155:42161", to: quote.txRequest!.to, value: "0", data: quote.txRequest!.data, chainId: 42161, gasLimit: quote.txRequest!.gasLimit, approvalAddress: quote.txRequest!.approvalAddress});
  });
  it("clears an order for one deposit, once", async () => {
    const {provider, quote, tx} = await built(ETH);
    await expect(provider.preflightDeposit!(quote, tx)).resolves.toBeUndefined();
    await expect(provider.preflightDeposit!(quote, tx)).rejects.toThrow(/\[order-reused\]$/);
  });
  it("a refused preflight does not use the order up", async () => {
    const {provider, quote, tx} = await built(ETH);
    await expect(provider.preflightDeposit!(quote, {...tx, value: "1"})).rejects.toThrow(/\[tx-value\]$/);
    await expect(provider.preflightDeposit!(quote, tx)).resolves.toBeUndefined();
  });

  it.each<[string, (tx: UnsignedTx) => UnsignedTx, RegExp]>([
    ["another target", (t) => ({...t, to: OTHER}), /\[tx-target\]$/],
    ["another chain label", (t) => ({...t, chain: "eip155:8453"}), /\[tx-chain\]$/],
    ["another chain id", (t) => ({...t, chainId: 8453}), /\[tx-chain\]$/],
    ["no chain id", (t) => { const {chainId: _c, ...rest} = t; return rest; }, /\[tx-chain\]$/],
    ["other calldata", (t) => ({...t, data: `${t.data!.slice(0, -2)}00`}), /\[tx-id\]$/],
    ["no calldata", (t) => { const {data: _d, ...rest} = t; return rest; }, /\[tx-calldata\]$/],
    ["a value", (t) => ({...t, value: "1"}), /\[tx-value\]$/],
    ["another spender", (t) => ({...t, approvalAddress: OTHER}), /\[quote-approval\]$/],
    ["no spender", (t) => { const {approvalAddress: _a, ...rest} = t; return rest; }, /\[quote-approval\]$/],
    ["a serialized transaction beside it", (t) => ({...t, serializedTx: "AA=="}), /\[quote-shape\]$/],
    ["typed data beside it", (t) => ({...t, typedData: "{}"}), /\[quote-shape\]$/],
    ["a memo beside it", (t) => ({...t, memo: "x"}), /\[quote-shape\]$/],
  ])("refuses to sign a transaction with %s", async (_n, edit, why) => {
    const {provider, quote, tx} = await built(USDC);
    await expect(provider.preflightDeposit!(quote, edit(tx))).rejects.toThrow(why);
  });

  it.each<[string, (q: Quote, other: Quote) => Quote, RegExp]>([
    ["another order sealed into it", (q, o) => ({...q, providerData: {...q.providerData!, orderData: o.providerData!.orderData!, orderId: o.providerData!.orderId!, orderSignature: o.providerData!.orderSignature!, paymentDetails: o.providerData!.paymentDetails!}}), /\[output-recipient\]$/],
    ["another recipient sealed into it", (q) => ({...q, providerData: {...q.providerData!, recipient: OTHER}}), /\[request-invalid\]$/],
    ["another sender sealed into it", (q) => ({...q, providerData: {...q.providerData!, depositor: OTHER}}), /\[request-invalid\]$/],
    ["another amount sealed into it", (q) => ({...q, providerData: {...q.providerData!, amount: "1"}}), /\[request-invalid\]$/],
    ["a lower minimum shown", (q) => ({...q, minDestAmount: "1"}), /\[quote-amounts\]$/],
    ["a higher estimate shown", (q) => ({...q, destAmount: `${q.destAmount}0`}), /\[quote-amounts\]$/],
    ["a deposit address", (q) => ({...q, depositAddress: OTHER}), /\[quote-shape\]$/],
    ["a native fee", (q) => ({...q, txRequest: {...q.txRequest!, nativeFee: "1"} as never}), /\[quote-shape\]$/],
    ["another provider's name", (q) => ({...q, provider: "lifi"}), /\[quote-shape\]$/],
    ["no order", (q) => { const {orderData: _o, ...pd} = q.providerData!; return {...q, providerData: pd}; }, /\[protocol-data-missing\]$/],
    ["an order that is not JSON", (q) => ({...q, providerData: {...q.providerData!, orderData: "{"}}), /\[protocol-data-missing\]$/],
  ])("refuses to build or sign a quote with %s", async (_n, edit, why) => {
    const {provider, quote, tx} = await built(USDC);
    const other = (await quoted(ETH)).quote!;
    at(loadQuote(USDC));
    const bad = edit(quote, other);
    await expect(provider.buildDeposit(bad)).rejects.toThrow(why);
    await expect(provider.preflightDeposit!(bad, tx)).rejects.toThrow(why);
  });

  it("a quote of another request cannot ride on this instance's intent id", async () => {
    // Two quotes issued by the same instance; the second's order under the first's intent id.
    const a = loadQuote(USDC);
    const b = loadQuote(ETH);
    let which = a;
    at(a);
    const provider = relayProvider({fetchImpl: (async () => new Response(JSON.stringify(which.response))) as typeof fetch});
    const qa = (await provider.getQuote(paramsOf(a)))!;
    which = b;
    at(b);
    const qb = (await provider.getQuote(paramsOf(b)))!;
    const forged = {...qb, intentId: qa.intentId};
    await expect(provider.buildDeposit(forged)).rejects.toThrow(/\[request-invalid\]$/);
  });
  it("an order grows stale: ten minutes after it was issued it is not signed", async () => {
    const {provider, quote, tx, f} = await built(ETH);
    at(f, 9 * 60_000);
    await expect(provider.buildDeposit(quote)).resolves.toBeDefined();
    at(f, 11 * 60_000);
    await expect(provider.buildDeposit(quote)).rejects.toThrow(/\[output-deadline\]$/);
    await expect(provider.preflightDeposit!(quote, tx)).rejects.toThrow(/\[output-deadline\]$/);
  });
  it("another instance (no memory of the quote) still verifies the order against what the quote seals", async () => {
    const {quote, tx, f} = await built(ETH);
    const fresh = relayProvider({fetchImpl: serve({})});
    await expect(fresh.buildDeposit(quote)).resolves.toEqual(tx);
    const moved = {...quote, providerData: {...quote.providerData!, recipient: f.request.depositor.toLowerCase()}};
    await expect(fresh.buildDeposit(moved)).rejects.toThrow(/\[output-recipient\]$/);
  });
});

describe("remote pins", () => {
  it("pin the depository as the only call target and spender", () => {
    expect(relayPins.callTargets!("eip155:5000")).toEqual(["0x59916da825d2d2ec1bf878d71c88826f6633ecca"]);
    expect(relayPins.spenders!("eip155:8453")).toEqual(["0x4cd00e387622c35bddb9b4c962c136462338bc31"]);
    expect(relayPins.callTargets!("eip155:14")).toEqual([]);
    expect(relayPins.callTargets!("__proto__")).toEqual([]);
  });
  it("verify a remote quote and build against the caller's own request", async () => {
    const {quote, params, provider, f} = await quoted(USDC);
    const tx = await provider.buildDeposit(quote!);
    expect(relayPins.verifyQuote!(params, quote!)).toBeNull();
    expect(relayPins.verifyBuild!(quote!, tx, params)).toBeNull();
    expect(relayPins.verifyQuote!({...params, destAddress: OTHER}, quote!)).toMatch(/\[output-recipient\]$/);
    expect(relayPins.verifyQuote!({...params, amountIn: "24999999"}, quote!)).toMatch(/\[input-amount\]$/);
    expect(relayPins.verifyQuote!({...params, destChain: "eip155:10"}, quote!)).toMatch(/\[output-chain\]$/);
    expect(relayPins.verifyQuote!({...params, refundAddress: OTHER}, quote!)).toMatch(/\[refund-recipient\]$/);
    expect(relayPins.verifyBuild!(quote!, tx)).toMatch(/\[request-invalid\]$/);
    expect(relayPins.verifyBuild!(quote!, {...tx, to: OTHER}, params)).toMatch(/\[tx-target\]$/);
    expect(relayPins.verifyBuild!(quote!, {...tx, chain: "eip155:1"}, params)).toMatch(/\[tx-chain\]$/);
    expect(relayPins.verifyBuild!(quote!, tx, {...params, destAddress: f.request.sourceToken})).toMatch(/\[output-recipient\]$/);
    // A server that swaps in its own transaction while keeping the verified order.
    const lying = {...quote!, txRequest: {...quote!.txRequest!, to: OTHER}};
    expect(relayPins.verifyQuote!(params, lying)).toMatch(/\[tx-target\]$/);
  });
});

describe("trackIntent", () => {
  const ID = `relay:0x${"ab".repeat(32)}`;
  const HASH = `0x${"cd".repeat(32)}`;
  const track = async (body: unknown, status = 200, ref: {sourceTxHash?: string | null; destTxHash?: string} = {sourceTxHash: HASH}) => {
    const seen: Seen[] = [];
    const out = await relayProvider({fetchImpl: serve(body, seen, status)}).trackIntent({intentId: ID, ...ref});
    return {out, seen};
  };
  it("asks by request id", async () => {
    const {seen} = await track({status: "pending"});
    expect(seen[0]!.url).toBe(`https://api.relay.link/intents/status/v3?requestId=0x${"ab".repeat(32)}`);
  });
  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ["waiting", {status: "waiting"}, {state: "pending"}],
    ["unknown", {status: "unknown"}, {state: "pending"}],
    ["depositing", {status: "depositing"}, {state: "pending", depositReceived: true}],
    ["pending", {status: "pending"}, {state: "pending", depositReceived: true}],
    ["submitted", {status: "submitted"}, {state: "pending", depositReceived: true}],
    ["delayed", {status: "delayed"}, {state: "pending", depositReceived: true}],
    ["success", {status: "success", txHashes: [HASH, `0x${"ef".repeat(32)}`]}, {state: "completed", depositReceived: true, destTxHash: `0x${"ef".repeat(32)}`}],
    ["success with no hashes", {status: "success"}, {state: "completed", depositReceived: true}],
    ["success with junk hashes", {status: "success", txHashes: ["javascript:alert(1)", 7]}, {state: "completed", depositReceived: true}],
    ["refund", {status: "refund"}, {state: "refunded", depositReceived: true}],
    ["refunded", {status: "refunded"}, {state: "refunded", depositReceived: true}],
    ["failure, refund on its way", {status: "failure", refundFailReason: "N/A"}, {state: "refund-pending", depositReceived: true}],
    ["failure with no reason field", {status: "failure"}, {state: "refund-pending", depositReceived: true}],
    ["failure whose refund failed", {status: "failure", refundFailReason: "REFUND_BELOW_MINIMUM"}, {state: "failed", depositReceived: true}],
    ["a state this module has never seen", {status: "reticulating"}, {state: "pending", depositReceived: true}],
    ["a prototype key as state", {status: "constructor"}, {state: "pending", depositReceived: true}],
    ["no state", {}, {state: "pending"}],
    ["upper case", {status: "SUCCESS"}, {state: "completed", depositReceived: true}],
  ])("%s", async (_n, body, want) => expect((await track(body)).out).toEqual(want));
  it("every state Relay documents is mapped", () => {
    for (const s of ["waiting", "depositing", "pending", "submitted", "success", "delayed", "refunded", "refund", "failure"]) expect(RELAY_STATUS_MAP[s]).toBeDefined();
  });
  it("stays pending on an HTTP error, a broken answer or a network failure — never a made-up terminal state", async () => {
    expect((await track({status: "success"}, 500)).out).toEqual({state: "pending"});
    expect((await track("oops")).out).toEqual({state: "pending"});
    const out = await relayProvider({fetchImpl: (async () => { throw new Error("down"); }) as typeof fetch}).trackIntent({intentId: ID, sourceTxHash: HASH});
    expect(out).toEqual({state: "pending"});
  });
  it("does not ask before a deposit was sent, and fails ids that are not its own", async () => {
    const before = await track({status: "success"}, 200, {sourceTxHash: null});
    expect(before.out).toEqual({state: "pending"});
    expect(before.seen).toHaveLength(0);
    const p = relayProvider({fetchImpl: serve({status: "success"})});
    expect(await p.trackIntent({intentId: "lifi:abc", sourceTxHash: HASH})).toEqual({state: "failed"});
    expect(await p.trackIntent({intentId: "relay:0x12&requestId=other", sourceTxHash: HASH})).toEqual({state: "failed"});
  });
});

describe("router", () => {
  it("the dispatch snapshot forwards every Relay method, and a routed quote is the verified order", async () => {
    const f = loadQuote(USDC);
    at(f);
    const router = new CrossChainRouter([relayProvider({fetchImpl: serve(f.response)})]);
    const p = router.getProvider("relay")!;
    for (const m of ["getQuote", "buildDeposit", "preflightDeposit", "trackIntent", "describeActivity", "supportsChain", "supportsChainPair", "supportsRoute"]) {
      expect(typeof (p as unknown as Record<string, unknown>)[m], m).toBe("function");
    }
    // Nothing this provider does not have is invented on the way (no claim: a refund is Relay's to send).
    expect((p as unknown as Record<string, unknown>).buildClaim).toBeUndefined();
    expect(router.supportsChainPair("eip155:42161", "eip155:8453")).toBe(true);
    expect(router.supportsChainPair("eip155:42161", "eip155:14")).toBe(false);
    const params = paramsOf(f);
    const best = await router.getBestQuote(params);
    expect(params.reasons).toEqual([]);
    expect(best?.provider).toBe("relay");
    expect(relayPins.verifyQuote!(params, best!)).toBeNull();
    const tx = await p.buildDeposit(best!);
    expect(tx).toMatchObject({to: relayChain("eip155:42161")!.depository, approvalAddress: relayChain("eip155:42161")!.depository});
    await expect(p.preflightDeposit!(best!, tx)).resolves.toBeUndefined();
  });

  it("an order for someone else never comes out of the router: the refusal is named, there is no quote", async () => {
    const f = loadQuote(USDC);
    at(f);
    const router = new CrossChainRouter([relayProvider({fetchImpl: serve(f.response)})]);
    const params = paramsOf(f, {destAddress: OTHER});
    expect(await router.getBestQuote(params)).toBeNull();
    expect(params.reasons.join(" ")).toMatch(/\[output-recipient\]/);
  });
});
