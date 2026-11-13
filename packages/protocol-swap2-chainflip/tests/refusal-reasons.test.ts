// CS-13: refusal reasons. Every Chainflip refusal keeps its text; `reason` classifies it. The real provider and pins
// run against a mocked backend (the encoder answers recorded 2026-10-20) — no network, no keys.
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {encodeFunctionData, parseAbi} from "viem";
import {refusalOf, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import type {Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {CF_VAULTS, chainflipPins, chainflipVerifyQuote} from "../src/config.js";
import {toHex, tronToBytes} from "../src/codec.js";
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
const TRANSFER = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

type Answer = () => Response | Promise<Response>;
const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);

/** The Chainflip backend: the quote and encoder answers, each replaceable; every URL it was asked is kept. */
function backend(o: {quote?: Answer; encode?: Answer | Record<string, string>} = {}) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    seen.push(url);
    if (init?.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
    if (url.includes("/v2/quote")) return o.quote ? o.quote() : json(QUOTE);
    if (url.includes("/api/encodeVaultSwapData")) return typeof o.encode === "function" ? o.encode() : json(o.encode ?? fx.tron_usdt);
    return json({}, {status: 404});
  }));
  return seen;
}
afterEach(() => vi.unstubAllGlobals());

/** One getQuote through the real provider: the quote, and the single refusal it heard (text + classification). */
async function quote(params: QuoteParams, provider = chainflipProvider(), signal?: AbortSignal) {
  const heard: {text: string; info: Swap2RefusalInfo | undefined; args: number}[] = [];
  const q = await provider.getQuote({...params, onRefusal: (...args: [string, Swap2RefusalInfo?]) => { heard.push({text: args[0], info: args[1], args: args.length}); }}, signal);
  expect(heard.length).toBeLessThanOrEqual(1);
  return {q, text: heard[0]?.text, info: heard[0]?.info, args: heard[0]?.args};
}

describe("chainflip getQuote: the request", () => {
  it("unsupported_pair: no vault swap from the chain, an unlisted asset, a quote type the module does not take", async () => {
    backend();
    const chain = await quote({...TRON_PARAMS, sourceChain: "solana:mainnet"});
    expect(chain.q).toBeNull();
    expect(chain.text).toBe("chainflip: no vault swap solana:mainnet → eip155:42161");
    expect(chain.info).toEqual({reason: "unsupported_pair"});
    const asset = await quote({...TRON_PARAMS, sourceToken: "DOGE"});
    expect(asset.text).toBe(`chainflip: asset not listed (DOGE on ${TRON} → ${ARB_USDC} on eip155:42161)`);
    expect(asset.info).toEqual({reason: "unsupported_pair"});
    backend({quote: () => json([{...QUOTE[0], type: "DCA"}])});
    const dca = await quote(TRON_PARAMS);
    expect(dca.text).toBe("chainflip: DCA quotes are not supported");
    expect(dca.info).toEqual({reason: "unsupported_pair"});
  });

  it("amount_too_small: below the minimum deposit, before the backend is asked", async () => {
    const seen = backend();
    const r = await quote({...TRON_PARAMS, amountIn: "9000000"});
    expect(r.text).toBe("chainflip: below the minimum deposit (10000000 USDT)");
    expect(r.info).toEqual({reason: "amount_too_small"});
    expect(seen).toEqual([]);
  });

  it("price_check_failed: a floor above the expected output", async () => {
    backend();
    const r = await quote({...TRON_PARAMS, minAmountOut: "30000000"});
    expect(r.text).toBe("chainflip: floor 30000000 above the expected output 19483300");
    expect(r.info).toEqual({reason: "price_check_failed"});
  });

  it("policy_refused: a live quote without a refund address", async () => {
    backend();
    const {refundAddress: _r, ...noRefund} = TRON_PARAMS;
    const r = await quote(noRefund);
    expect(r.text).toBe("chainflip: live quote without a refund address");
    expect(r.info).toEqual({reason: "policy_refused"});
  });

  it("an address that does not parse is the caller's argument: unclassified, onRefusal hears the text alone", async () => {
    backend();
    const dest = await quote({...TRON_PARAMS, destAddress: "0xzz"});
    expect(dest.text).toBe("chainflip: chainflip codec: not hex");
    expect(dest.info).toBeUndefined();
    expect(dest.args).toBe(1);
    const refund = await quote({...TRON_PARAMS, refundAddress: "0xnot-tron"});
    expect(refund.text).toMatch(/^chainflip: refund address: /);
    expect(refund.info).toBeUndefined();
  });
});

describe("chainflip getQuote: the backend's answer", () => {
  it("rate_limited: a 429 after the one back-off carries Retry-After and the status", async () => {
    const seen = backend({quote: () => json({message: "Too many requests"}, {status: 429, headers: {"retry-after": "7"}})});
    const r = await quote(TRON_PARAMS);
    expect(r.q).toBeNull();
    expect(r.text).toBe("chainflip: quote 429: Too many requests");
    expect(r.info).toEqual({reason: "rate_limited", retryAfterMs: 7000, httpStatus: 429});
    expect(seen.filter((u) => u.includes("/v2/quote"))).toHaveLength(2); // the back-off is unchanged
  });

  it("upstream_unavailable with the status: 401 / 403 from this keyless backend (a CDN or region block, never key_rejected) and 5xx", async () => {
    backend({quote: () => json({message: "Forbidden"}, {status: 403})});
    const forbidden = await quote(TRON_PARAMS);
    expect(forbidden.text).toBe("chainflip: quote 403: Forbidden");
    expect(forbidden.info).toEqual({reason: "upstream_unavailable", httpStatus: 403});
    backend({quote: () => new Response("<html>denied</html>", {status: 401})});
    const unauthorized = await quote(TRON_PARAMS);
    expect(unauthorized.text).toBe("chainflip: quote 401: ");
    expect(unauthorized.info).toEqual({reason: "upstream_unavailable", httpStatus: 401});
    backend({encode: () => json({message: "Forbidden"}, {status: 403})});
    const encoder = await quote(TRON_PARAMS);
    expect(encoder.text).toBe("chainflip: encode 403: Forbidden");
    expect(encoder.info).toEqual({reason: "upstream_unavailable", httpStatus: 403});
    backend({quote: () => new Response("<html>bad gateway</html>", {status: 502})});
    const down = await quote(TRON_PARAMS);
    expect(down.text).toBe("chainflip: quote 502: ");
    expect(down.info).toEqual({reason: "upstream_unavailable", httpStatus: 502});
  });

  it("the backend's own message wins over the status: limits, liquidity, a halted pool, no quote", async () => {
    const cases: Array<[number, string, Swap2RefusalInfo["reason"]]> = [
      [400, "expected amount is below minimum swap amount (20000000)", "amount_too_small"],
      [400, "amount is lower than estimated ingress fee (3400000)", "amount_too_small"],
      [400, "maximum swap amount is 1000000000000", "amount_too_large"],
      [400, "insufficient liquidity for the requested amount", "insufficient_liquidity"],
      [503, "Swapping is currently disabled for USDT on Tron", "chain_halted"],
      [503, "the state chain is in maintenance", "chain_halted"],
      [404, "no quote available", "no_route"],
      [400, "asset Tron.FOO is not supported", "unsupported_pair"],
    ];
    for (const [status, message, reason] of cases) {
      backend({quote: () => json({message}, {status})});
      const r = await quote(TRON_PARAMS);
      expect(r.text, message).toBe(`chainflip: quote ${status}: ${message}`);
      expect(r.info, message).toEqual({reason});
    }
    // A message that names nothing known, on a status that says nothing: unclassified.
    backend({quote: () => json({message: "invalid request"}, {status: 400})});
    const unknown = await quote(TRON_PARAMS);
    expect(unknown.text).toBe("chainflip: quote 400: invalid request");
    expect(unknown.info).toBeUndefined();
  });

  it("upstream_unavailable: a network failure, malformed JSON; no_route: an empty quote list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const net = await quote(TRON_PARAMS);
    expect(net.text).toBe("chainflip: quote failed: fetch failed");
    expect(net.info).toEqual({reason: "upstream_unavailable"});
    backend({quote: () => new Response("not json")});
    const garbled = await quote(TRON_PARAMS);
    expect(garbled.text).toBe("chainflip: quote without an egress amount");
    expect(garbled.info).toEqual({reason: "upstream_unavailable"});
    backend({quote: () => json([])});
    const none = await quote(TRON_PARAMS);
    expect(none.text).toBe("chainflip: quote without an egress amount");
    expect(none.info).toEqual({reason: "no_route"});
  });

  it("the caller's own abort is not upstream_unavailable", async () => {
    backend();
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await quote(TRON_PARAMS, chainflipProvider(), ctrl.signal);
    expect(r.text).toBe("chainflip: quote failed: This operation was aborted");
    expect(r.info).toBeUndefined();
    expect(r.args).toBe(1);
  });

  it("the encoder: its HTTP failures and network failures as the quote's", async () => {
    backend({encode: () => json({message: "internal error"}, {status: 500})});
    const failed = await quote(TRON_PARAMS);
    expect(failed.text).toBe("chainflip: encode 500: internal error");
    expect(failed.info).toEqual({reason: "upstream_unavailable", httpStatus: 500});
    backend({encode: () => { throw new TypeError("network down"); }});
    const net = await quote(TRON_PARAMS);
    expect(net.text).toBe("chainflip: encode failed: network down");
    expect(net.info).toEqual({reason: "upstream_unavailable"});
  });

  it("an encoder 200 that is not JSON, or names no target, is a malformed answer (upstream_unavailable), not vault_mismatch", async () => {
    const cases: Array<[QuoteParams, Answer, string]> = [
      [TRON_PARAMS, () => new Response("<html>cdn</html>", {status: 200}), "chainflip: encoder targets undefined, not the Tron Vault"],
      [ARB_PARAMS, () => new Response("<html>cdn</html>", {status: 200}), "chainflip: encoder targets undefined, not the Arbitrum Vault"],
      [TRON_PARAMS, () => json({}), "chainflip: encoder targets undefined, not the Tron Vault"],
      [ARB_PARAMS, () => json({...fx.arb_usdc!, to: ""}), "chainflip: encoder targets , not the Arbitrum Vault"],
    ];
    for (const [params, encode, text] of cases) {
      backend({encode});
      const r = await quote(params);
      expect(r.q, text).toBeNull();
      expect(r.text).toBe(text);
      expect(r.info, text).toEqual({reason: "upstream_unavailable"});
    }
  });

  it("the caller's abort while a body is read (it reads as null) stays unclassified, for the quote and the encoder", async () => {
    // Headers arrived, the signal was not aborted at fetch; the caller aborts while the body is read.
    const cutShort = (ctrl: AbortController): Answer => () => ({
      ok: true, status: 200, headers: new Headers(),
      json: async () => { ctrl.abort(); throw new DOMException("This operation was aborted", "AbortError"); },
    }) as unknown as Response;
    const q1 = new AbortController();
    backend({quote: cutShort(q1)});
    const quoted = await quote(TRON_PARAMS, chainflipProvider(), q1.signal);
    expect(quoted.text).toBe("chainflip: quote without an egress amount");
    expect(quoted.info).toBeUndefined();
    expect(quoted.args).toBe(1);
    for (const [params, text] of [[TRON_PARAMS, "chainflip: encoder targets undefined, not the Tron Vault"], [ARB_PARAMS, "chainflip: encoder targets undefined, not the Arbitrum Vault"]] as const) {
      const e1 = new AbortController();
      backend({encode: cutShort(e1)});
      const encoded = await quote(params, chainflipProvider(), e1.signal);
      expect(encoded.text).toBe(text);
      expect(encoded.info).toBeUndefined();
      expect(encoded.args).toBe(1);
    }
  });
});

describe("chainflip getQuote: what the encoder returned", () => {
  const tamperNote = (f: (n: string) => string) => ({...fx.tron_usdt!, note: f(fx.tron_usdt!.note!)});
  const vaultHex = toHex(tronToBytes(CF_VAULTS[TRON]!));
  const cases: Array<[string, QuoteParams, Record<string, string>, string, Swap2RefusalInfo["reason"], Parameters<typeof chainflipProvider>[0]?]> = [
    ["Tron: another vault", TRON_PARAMS, {...fx.tron_usdt!, to: ATTACKER_TRON}, `chainflip: encoder targets ${ATTACKER_TRON}, not the Tron Vault`, "vault_mismatch"],
    ["Arbitrum: another contract", ARB_PARAMS, {...fx.arb_usdc!, to: EVM_DEST}, `chainflip: encoder targets ${EVM_DEST}, not the Arbitrum Vault`, "vault_mismatch"],
    ["Tron: no note binds the destination", TRON_PARAMS, {...fx.tron_usdt!, note: ""}, "chainflip: Tron vault swap without a note", "recipient_unverifiable"],
    ["Tron: the note pays someone else", TRON_PARAMS, tamperNote((n) => n.replace("1111111111111111111111111111111111111111", "9999999999999999999999999999999999999999")), "chainflip: note names another destination", "recipient_mismatch"],
    ["Arbitrum: another destination", {...ARB_PARAMS, destAddress: ATTACKER_TRON}, fx.arb_usdc!, "chainflip: encoded destination differs from the request", "recipient_mismatch"],
    ["Tron: the refund goes elsewhere", TRON_PARAMS, tamperNote((n) => n.replace("8840e6c55b9ada326d211d818c34a994aeced808", "1234567890123456789012345678901234567890")), "chainflip: refund address 0x1234567890123456789012345678901234567890 is not the sender", "recipient_mismatch"],
    ["Tron: a lower minimum price", TRON_PARAMS, tamperNote((n) => n.replace("f5285c8fc2f5285c8fc2f5285c8fc2f5", "00000000000000000000000000000000")), "chainflip: minimum price is below the one requested", "price_check_failed"],
    ["Tron: another oracle guard", TRON_PARAMS, fx.tron_usdt!, "chainflip: oracle slippage guard differs from the request", "price_check_failed", {maxOraclePriceSlippageBps: 50}],
    ["Tron: a broker fee", TRON_PARAMS, tamperNote((n) => n.replace(/0000(00)$/, "6400$1")), "chainflip: broker takes 100 bps", "policy_refused"],
    // The note's parameters: compact length "8901" (98 bytes), version 01, retry window u32 LE "32000000" (50 blocks),
    // refund, minimum price, refund CCM 00, oracle "016400", DCA 00, boost 00, broker account + fee "0000", affiliates 00.
    ["Tron: a retry window above 600 blocks", TRON_PARAMS, tamperNote((n) => n.replace("8901013200000088", "8901015902000088")), "chainflip: retry window 601 blocks is too long", "policy_refused"],
    ["Tron: DCA parameters", TRON_PARAMS, tamperNote((n) => n.replace("8901", "a901").replace("016400000070d0cd", "01640001020000000a0000000070d0cd")), "chainflip: unexpected DCA parameters", "policy_refused"],
    ["Tron: a boost fee", TRON_PARAMS, tamperNote((n) => n.replace("016400000070d0cd", "016400000570d0cd")), "chainflip: unexpected boost fee", "policy_refused"],
    ["Tron: an affiliate", TRON_PARAMS, tamperNote((n) => n.replace("8901", "9501").replace(/00$/, "04010a00")), "chainflip: unexpected affiliates", "policy_refused"],
    ["Tron: another source token", TRON_PARAMS, {...fx.tron_usdt!, sourceTokenAddress: ATTACKER_TRON}, `chainflip: source token ${ATTACKER_TRON} is not USDT`, "policy_refused"],
    ["Tron: a TRC-20 transfer of another amount", TRON_PARAMS, {...fx.tron_usdt!, calldata: encodeFunctionData({abi: TRANSFER, functionName: "transfer", args: [vaultHex, 1n]})}, "chainflip: TRC-20 transfer is not the amount to the Vault", "policy_refused"],
    ["Tron: a TRC-20 transfer to someone else", TRON_PARAMS, {...fx.tron_usdt!, calldata: encodeFunctionData({abi: TRANSFER, functionName: "transfer", args: [EVM_DEST, 20_000_000n]})}, "chainflip: TRC-20 transfer is not the amount to the Vault", "vault_mismatch"],
    ["Arbitrum: a token call moving another amount", {...ARB_PARAMS, amountIn: "30000000", minAmountOut: "1"}, fx.arb_usdc!, "chainflip: token vault call with a different token or amount", "policy_refused"],
    ["Tron: a note that does not decode", TRON_PARAMS, {...fx.tron_usdt!, note: "0xzz"}, "chainflip: encoder output does not decode: chainflip codec: not hex", "upstream_unavailable"],
  ];
  it.each(cases)("%s", async (_what, params, encode, text, reason, config) => {
    backend({encode});
    const r = await quote(params, chainflipProvider(config));
    expect(r.q).toBeNull();
    expect(r.text).toBe(text);
    expect(r.info).toEqual({reason});
  });

  it("Ethereum ETH: a native vault call with another value is policy_refused (the recorded call itself passes)", async () => {
    // Recorded ETH → BTC xSwapNative: 0.0211 ETH, a minimum price guaranteeing 60 134 sats, refund 0x2222…, the oracle guard at 100 bps.
    const ETH_PARAMS: QuoteParams = {sourceChain: "eip155:1", sourceToken: "ETH", destChain: "bitcoin:mainnet", destToken: "BTC", amountIn: "21100000000000000", destAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", refundAddress: ARB_SELF, minAmountOut: "60134", dry: false};
    const btcQuote = () => json([{...QUOTE[0], egressAmount: "61000"}]);
    backend({quote: btcQuote, encode: fx.eth_eth!});
    const honest = await quote(ETH_PARAMS);
    expect(honest.text).toBeUndefined();
    expect(honest.q?.txRequest).toMatchObject({to: CF_VAULTS["eip155:1"], value: "21100000000000000"});
    backend({quote: btcQuote, encode: {...fx.eth_eth!, value: "1"}});
    const r = await quote(ETH_PARAMS);
    expect(r.q).toBeNull();
    expect(r.text).toBe("chainflip: native vault call with a different amount");
    expect(r.info).toEqual({reason: "policy_refused"});
  });
});

describe("chainflip buildDeposit", () => {
  it("policy_refused: a quote that is not a live vault swap; plain Errors with the same text", async () => {
    const p = chainflipProvider();
    const base = {provider: "chainflip", intentId: "cfvault:tron:728126428", depositAddress: "", depositMemo: null, sourceAmount: "1", destAmount: "1", minDestAmount: "1", feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: 0} as Quote;
    const cases: Array<[Quote, string]> = [
      [{...base, providerData: {kind: "evm"}}, "chainflip: quote has no vault call"],
      [{...base, providerData: {kind: "tron"}}, "chainflip: Tron quote without vault or note"],
      [base, "chainflip: not a live vault-swap quote"],
    ];
    for (const [q, text] of cases) {
      const err = await p.buildDeposit(q).then(() => undefined, (e: unknown) => e as Error);
      expect(err?.constructor).toBe(Error);
      expect(err?.message).toBe(text);
      expect(refusalOf(err)).toEqual({reason: "policy_refused"});
    }
  });
});

describe("chainflipPins", () => {
  const live = async (params: QuoteParams, encode: Record<string, string>) => {
    backend({encode});
    return (await chainflipProvider().getQuote(params))!;
  };
  it("reasonOf classifies every text chainflipVerifyQuote and verifyBuild return", async () => {
    const tron = await live(TRON_PARAMS, fx.tron_usdt!);
    const arb = await live(ARB_PARAMS, fx.arb_usdc!);
    const {txRequest: _tx, ...arbNoTx} = arb;
    const cases: Array<[string, QuoteParams, Quote, string, Swap2RefusalInfo["reason"]]> = [
      ["a source the release does not sign", {...TRON_PARAMS, sourceChain: "solana:mainnet"}, tron, "not a vault swap this release signs", "unsupported_pair"],
      ["no refund address", {...TRON_PARAMS, refundAddress: ""}, tron, "a live quote needs the refund address", "policy_refused"],
      ["a Tron deposit elsewhere", TRON_PARAMS, {...tron, depositAddress: ATTACKER_TRON}, "a Tron vault swap is a send to the Tron Vault with its note", "vault_mismatch"],
      ["a Tron deposit without its note", TRON_PARAMS, {...tron, depositMemo: null}, "a Tron vault swap is a send to the Tron Vault with its note", "recipient_unverifiable"],
      ["a Tron route turned into calldata", TRON_PARAMS, {...tron, txRequest: arb.txRequest!}, "a Tron vault swap is a send to the Tron Vault with its note", "policy_refused"],
      ["a note paying someone else", TRON_PARAMS, {...tron, depositMemo: tron.depositMemo!.replace("1111111111111111111111111111111111111111", "9999999999999999999999999999999999999999")}, "the note names another destination", "recipient_mismatch"],
      ["a note refunding elsewhere", TRON_PARAMS, {...tron, depositMemo: tron.depositMemo!.replace("8840e6c55b9ada326d211d818c34a994aeced808", "1234567890123456789012345678901234567890")}, "the refund address is not the sender", "recipient_mismatch"],
      ["a minimum the note does not guarantee", TRON_PARAMS, {...tron, minDestAmount: "19483300"}, "the minimum price does not guarantee the quoted minimum", "price_check_failed"],
      ["a broker fee in the note", TRON_PARAMS, {...tron, depositMemo: tron.depositMemo!.replace(/0000(00)$/, "6400$1")}, "DCA, boost, a broker fee or affiliates", "policy_refused"],
      ["a note that does not decode", TRON_PARAMS, {...tron, depositMemo: "0xzz"}, "the vault swap does not decode (chainflip codec: not hex)", "upstream_unavailable"],
      ["an EVM route as a deposit", ARB_PARAMS, {...arbNoTx, depositAddress: EVM_DEST}, "an EVM vault swap is a vault call, not a deposit", "policy_refused"],
      ["an EVM call to another contract", ARB_PARAMS, {...arb, txRequest: {...arb.txRequest!, to: EVM_DEST}}, `the call targets ${EVM_DEST}, not the Vault`, "vault_mismatch"],
      ["an EVM call for another destination", {...ARB_PARAMS, destAddress: ATTACKER_TRON}, arb, "the vault call names another destination", "recipient_mismatch"],
      ["a native call moving a token", {...ARB_PARAMS, sourceToken: "ETH"}, arb, "the native vault call moves another amount", "policy_refused"],
      ["an EVM call approving another spender", ARB_PARAMS, {...arb, txRequest: {...arb.txRequest!, approvalAddress: EVM_DEST}}, "the token vault call moves another token or amount", "policy_refused"],
    ];
    for (const [what, params, q, text, reason] of cases) {
      const got = chainflipVerifyQuote(params, q);
      expect(got, what).toBe(text);
      expect(chainflipPins.reasonOf!(got!), what).toEqual({reason});
      // The pins' own verifyQuote is the same function.
      expect(chainflipPins.verifyQuote!(params, q), what).toBe(text);
    }
    expect(chainflipVerifyQuote(TRON_PARAMS, tron)).toBeNull();
    const build = await chainflipPins.verifyBuild!(tron, {chain: "", to: CF_VAULTS[TRON]!, value: "20000000", memo: tron.depositMemo!} as UnsignedTx);
    expect(build).toBe("the Tron note is not sent as hex bytes");
    expect(chainflipPins.reasonOf!(build!)).toEqual({reason: "policy_refused"});
    expect(chainflipPins.reasonOf!("a text these pins never returned")).toBeUndefined();
  });

  it("a decode failure of the app's own field stays unclassified; the same text for a quote that does not decode is upstream_unavailable", async () => {
    const tron = await live(TRON_PARAMS, fx.tron_usdt!);
    const text = "the vault swap does not decode (chainflip codec: not hex)";
    const quoteSide = chainflipVerifyQuote(TRON_PARAMS, {...tron, depositMemo: "0xzz"});
    expect(quoteSide).toBe(text);
    expect(chainflipPins.reasonOf!(text)).toEqual({reason: "upstream_unavailable"});
    // The app's own destination does not parse: the same text, unclassified (the latest verdict wins).
    expect(chainflipVerifyQuote({...TRON_PARAMS, destAddress: "0xzz"}, tron)).toBe(text);
    expect(chainflipPins.reasonOf!(text)).toBeUndefined();
    const refund = chainflipVerifyQuote({...TRON_PARAMS, refundAddress: "0xnot-tron"}, tron);
    expect(refund).toMatch(/^the vault swap does not decode \(/);
    expect(chainflipPins.reasonOf!(refund!)).toBeUndefined();
    const amount = chainflipVerifyQuote({...TRON_PARAMS, amountIn: "lots"}, tron);
    expect(amount).toMatch(/^the vault swap does not decode \(/);
    expect(chainflipPins.reasonOf!(amount!)).toBeUndefined();
    // And back: the quote's own failure is classified again.
    expect(chainflipVerifyQuote(TRON_PARAMS, {...tron, depositMemo: "0xzz"})).toBe(text);
    expect(chainflipPins.reasonOf!(text)).toEqual({reason: "upstream_unavailable"});
  });

  it("a remote stub's refusal carries the pins' reason, its text unchanged", async () => {
    const arb = await live(ARB_PARAMS, fx.arb_usdc!);
    const tampered = {...arb, txRequest: {...arb.txRequest!, to: EVM_DEST}};
    const stub = remoteProvider({name: "chainflip", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl: (async () => json(tampered)) as unknown as typeof fetch, ...chainflipPins});
    const err = await stub.getQuote(ARB_PARAMS).then(() => undefined, (e: unknown) => e as Error);
    expect(err?.message).toBe(`chainflip: the quote fails this app's own check — the call targets ${EVM_DEST}, not the Vault`);
    expect(refusalOf(err)).toEqual({reason: "vault_mismatch"});
  });
});

describe("configuration is not a refusal", () => {
  it("a base URL that does not parse throws unclassified", () => {
    let err: unknown;
    try { chainflipProvider({apiUrl: "not a url"}); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TypeError);
    expect(refusalOf(err)).toBeUndefined();
  });
});
