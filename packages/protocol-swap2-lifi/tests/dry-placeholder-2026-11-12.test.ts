// Review r1 of the EVM → Solana change (2026-11-12): a dry EVM → Solana quote with no recipient asked LI.FI to pay the
// Solana placeholder — the public BIP-39 "abandon" account, whose key anyone can derive and sweep — and the provider
// returned the fully built Diamond call from the user's refundAddress, which lifiVerifyQuote accepted. The same held for
// the EVM placeholder (vitalik.eth) standing in for a missing sender, which every refund in the calldata then pays. A dry
// quote the module prices for a placeholder now carries no transaction: `getQuote` keeps only the price, `buildDeposit`
// refuses it, `lifiVerifyQuote` (the remote pin) refuses one that carries a transaction, and the swap2 server refuses to
// build it. Answers are the recorded read-only li.quest/v1/quote fixtures; nothing is signed or sent.
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {remotePinRefusal} from "@anywalletkit/protocol-swap2-core/validate";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {lifiPins, lifiProvider, lifiVerifyQuote} from "../src/provider.js";
import {AUTO, PARAMS, response} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

type Answer = {action: {fromAddress: string; toAddress: string; slippage: number}; transactionRequest: {data?: string}};
type Corridor = {name: string; params: QuoteParams; response: Answer};
const read = (file: string) => (JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")) as {corridors: Corridor[]}).corridors;
const toSolana = read("./fixtures-live-2026-11-12-evm-solana.json");
const nov02 = read("./fixtures-live-2026-11-02.json");
const pick = (list: Corridor[], name: string) => { const c = list.find((k) => k.name === name); if (!c) throw new Error(name); return c; };

const EVM_PLACEHOLDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SOLANA_PLACEHOLDER = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const CARRIES = (role: string) => `a dry quote priced for a placeholder ${role} carries a transaction — it would pay or refund that placeholder, not the wallet that signs it`;
const BUILD = (role: string) => `swap2: this LI.FI quote was priced for a placeholder ${role} (a dry quote without that address) and has no transaction to build — quote again with the sender and the recipient`;

/** Recorded with the placeholders as the addresses (round 1 asked li.quest for them), so a dry request without them matches. */
const polymer = pick(toSolana, "ethereum-usdc>solana-usdc polymerStandard"); // from 0xd8dA…, to HAgk14…
const mayan = pick(toSolana, "base-usdc>solana-sol mayan"); // from 0xd8dA…, to HAgk14…
const evmBridge = pick(nov02, "evm-base-usdc-arb-usdc"); // Polymer, from 0xd8dA…, to 0x3333…
const solSource = pick(nov02, "sol-base-usdc"); // NEAR Intents from Solana, from HAgk14…

/** LI.FI answers with `answer`, echoing the slippage asked (a re-quote at a scaled slippage gets the same answer). */
function replay(answer: unknown) {
  vi.stubGlobal("fetch", async (u: URL | string) => {
    const url = new URL(String(u));
    const a = answer as {action: object};
    return new Response(JSON.stringify({...a, action: {...a.action, slippage: Number(url.searchParams.get("slippage"))}}));
  });
}
async function quote(answer: unknown, params: QuoteParams): Promise<{q: Quote | null; reasons: string[]}> {
  replay(answer);
  const reasons: string[] = [];
  const q = await lifiProvider().getQuote({...params, slippageBps: 300, onRefusal: (r) => reasons.push(r)});
  return {q, reasons};
}
const dry = (params: QuoteParams, drop: {refund?: boolean; dest?: boolean}): QuoteParams => {
  const {refundAddress, ...rest} = params;
  return {...rest, ...(drop.refund ? {} : {refundAddress}), destAddress: drop.dest ? "" : params.destAddress, dry: true};
};
/** EVM → EVM answered for the EVM placeholder as both sender and recipient (Stargate calldata paying and refunding it). */
const toPlaceholder = response({
  action: {...response().action, fromAddress: EVM_PLACEHOLDER, toAddress: EVM_PLACEHOLDER},
  transactionRequest: {...response().transactionRequest, from: EVM_PLACEHOLDER, data: AUTO},
});

describe("a dry quote priced for a placeholder carries no transaction (getQuote)", () => {
  const cases: [string, unknown, QuoteParams, "sender" | "recipient"][] = [
    ["EVM → Solana, the sender's refundAddress but no recipient", polymer.response, dry(polymer.params, {dest: true}), "recipient"],
    ["EVM → Solana (Mayan), the sender's refundAddress but no recipient", mayan.response, dry(mayan.params, {dest: true}), "recipient"],
    ["EVM → Solana, neither address", polymer.response, dry(polymer.params, {refund: true, dest: true}), "sender"],
    ["EVM → EVM, no sender", evmBridge.response, dry(evmBridge.params, {refund: true}), "sender"],
    ["EVM → EVM, neither address (the EVM placeholder is paid and refunded)", toPlaceholder, dry(PARAMS as QuoteParams, {refund: true, dest: true}), "sender"],
    ["Solana → EVM, no sender (the Solana placeholder signs and is refunded)", solSource.response, dry(solSource.params, {refund: true}), "sender"],
  ];
  for (const [name, answer, params, role] of cases) {
    it(name, async () => {
      const {q, reasons} = await quote(answer, params);
      expect([reasons, q?.txRequest, q?.providerData]).toEqual([[], undefined, {placeholder: role}]);
      // The price stays: what is spent, delivered and guaranteed.
      expect(q).toMatchObject({provider: "lifi", sourceAmount: params.amountIn, depositAddress: ""});
      expect(BigInt(q!.minDestAmount)).toBeGreaterThan(0n);
      // Built for nothing, refused by the remote pin only if a transaction is attached.
      await expect(lifiProvider().buildDeposit(q!)).rejects.toThrow(BUILD(role));
      expect(lifiVerifyQuote(params, q!)).toBeNull();
    });
  }

  it("a quote for the request's own addresses still carries its transaction (an explicit address is the caller's, whichever it is)", async () => {
    // Dry EVM → EVM without a recipient prices the sender's own address (PARAMS.refundAddress): nothing to stand in for.
    const own = await quote(response({action: {...response().action, toAddress: PARAMS.refundAddress}}), dry(PARAMS as QuoteParams, {dest: true}));
    expect(own.reasons).toEqual([]);
    expect(own.q?.txRequest?.data).toMatch(/^0x/);
    expect(own.q?.providerData).toBeUndefined();
    await expect(lifiProvider().buildDeposit(own.q!)).resolves.toMatchObject({to: own.q!.txRequest!.to, data: own.q!.txRequest!.data});
    // Live requests that name the addresses — here the recorded ones — are built as before.
    for (const c of [polymer, mayan, evmBridge, solSource]) {
      const live = await quote(c.response, c.params);
      expect([c.name, live.reasons, typeof (live.q?.txRequest?.data ?? live.q?.txRequest?.serializedTx)]).toEqual([c.name, [], "string"]);
      expect(lifiVerifyQuote(c.params, live.q!)).toBeNull();
    }
  });
});

describe("a quote priced for a placeholder is refused at every build and verify entry point", () => {
  it("buildDeposit: refused by name, even with a transaction attached to it", async () => {
    const {q} = await quote(polymer.response, dry(polymer.params, {dest: true}));
    const live = (await quote(polymer.response, polymer.params)).q!;
    await expect(lifiProvider().buildDeposit({...q!, txRequest: live.txRequest!})).rejects.toThrow(BUILD("recipient"));
    await expect(lifiProvider().buildDeposit({...live, providerData: {placeholder: "sender"}})).rejects.toThrow(BUILD("sender"));
    // A quote without the mark and without a transaction keeps the existing refusal.
    const {providerData: _mark, ...unmarked} = q!;
    await expect(lifiProvider().buildDeposit(unmarked)).rejects.toThrow("swap2: LI.FI quote has no transaction request");
  });

  it("lifiVerifyQuote / lifiPins.verifyQuote: a dry request without the sender or the Solana recipient refuses any transaction", async () => {
    expect(lifiPins.verifyQuote).toBe(lifiVerifyQuote);
    for (const [c, drop, role] of [
      [polymer, {dest: true}, "recipient"],
      [mayan, {dest: true}, "recipient"],
      [polymer, {refund: true, dest: true}, "sender"],
      [evmBridge, {refund: true}, "sender"],
      [solSource, {refund: true}, "sender"],
    ] as const) {
      // The transaction LI.FI built for the placeholder (what the old provider handed out), checked against the dry request.
      const built = (await quote(c.response, c.params)).q!;
      expect([c.name, lifiVerifyQuote(dry(c.params, drop), built)]).toEqual([c.name, CARRIES(role)]);
      // dry: undefined counts as dry, as in the provider.
      const {dry: _dry, ...unflagged} = dry(c.params, drop);
      expect([c.name, lifiVerifyQuote(unflagged as QuoteParams, built)]).toEqual([c.name, CARRIES(role)]);
    }
  });

  it("lifiVerifyQuote: a price-only quote is still held to the request's terms; a live request needs its transaction", async () => {
    const params = dry(polymer.params, {dest: true});
    const {q} = await quote(polymer.response, params);
    expect(lifiVerifyQuote(params, q!)).toBeNull();
    expect(lifiVerifyQuote(params, {...q!, sourceAmount: "1"})).toBe(`the quote spends 1, not the ${params.amountIn} input`);
    expect(lifiVerifyQuote({...params, minAmountOut: (BigInt(q!.minDestAmount) + 1n).toString()}, q!)).toBe(`the quoted minimum ${q!.minDestAmount} is below the caller's floor ${BigInt(q!.minDestAmount) + 1n}`);
    expect(lifiVerifyQuote(params, {...q!, intentId: "lifi:1:42161"})).toBe("the intent id does not name this route");
    expect(lifiVerifyQuote(params, {...q!, minDestAmount: "1.5"})).toBe("the quote's amounts are not integers");
    expect(lifiVerifyQuote(params, {...q!, depositAddress: "0x9999999999999999999999999999999999999999"})).toBe("a LI.FI quote pays no deposit address, but this one names 0x9999999999999999999999999999999999999999");
    // The server's tokened intent id names the route too.
    expect(lifiVerifyQuote(params, {...q!, intentId: `${q!.intentId}~${"ab".repeat(16)}`})).toBeNull();
    // With the addresses named, the quote must carry its transaction (existing refusal).
    expect(lifiVerifyQuote(polymer.params, q!)).toBe("the quote carries no transaction");
    expect(lifiVerifyQuote({...params, destAddress: SOLANA_PLACEHOLDER}, q!)).toBe("the quote carries no transaction");
  });

  it("remoteProvider + lifiPins: a backend's placeholder quote with a transaction never reaches the auction; the price-only one does and the server will not build it", async () => {
    const params = dry(polymer.params, {dest: true});
    // A backend (an older server, or a compromised one) that answers the dry request with the placeholder's transaction.
    const built = (await quote(polymer.response, polymer.params)).q!;
    const evil = remoteProvider({name: "lifi", baseUrl: "https://backend.example/api/v2/swap2", ...lifiPins,
      fetchImpl: (async () => new Response(JSON.stringify(built), {status: 200})) as unknown as typeof fetch});
    await expect(evil.getQuote(params)).rejects.toThrow(`lifi: the quote fails this app's own check — ${CARRIES("recipient")}`);

    // The real server handler over this provider: the dry quote comes back price-only, sealed; building it is refused.
    replay(polymer.response);
    const handle = createSwap2Handler<string>({providers: [lifiProvider()], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
      return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
    const stub = remoteProvider({name: "lifi", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, ...lifiPins});
    const q = await stub.getQuote({...params, slippageBps: 300});
    expect(q?.txRequest).toBeUndefined();
    expect(q?.providerData?.placeholder).toBe("recipient");
    expect(remotePinRefusal(stub, q!, params.sourceChain)).toBeNull();
    await expect(stub.buildDeposit(q!)).rejects.toThrow(/422 .*priced for a placeholder recipient/);
  });
});
