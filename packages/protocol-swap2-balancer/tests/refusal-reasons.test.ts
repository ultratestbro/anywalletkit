// CS-13: every Balancer v2 refusal keeps its text and carries a stable `reason` (Swap2RefusalReason). The real provider,
// verifier, pins and engine run against a fake SOR (Balancer API) and JSON-RPC: no network, no keys.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, parseAbi, type Hex} from "viem";
import {refusalOf, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {Swap2QuoteError} from "@anywalletkit/protocol-swap2-core";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {BALANCER_MAX_SWAPS, balancerPins, balancerProvider, balancerVerifyQuote} from "../src/provider.js";
import {BalancerSwap2Protocol} from "../src/protocol.js";
import {BAL, ME, POOL_A, POOL_B, RPC, USDC, VAULT, WETH} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const ATTACKER = "0x9999999999999999999999999999999999999999";
const ONE = "1000000000000000000";
const base = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME, sourceToken: "WETH", destToken: USDC, amountIn: ONE};
const SWAP_STEP = "(bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)";
const FUNDS = "(address sender, bool fromInternalBalance, address recipient, bool toInternalBalance)";
const ABI = parseAbi([
  `function batchSwap(uint8 kind, ${SWAP_STEP}[] swaps, address[] assets, ${FUNDS} funds, int256[] limits, uint256 deadline) payable returns (int256[] assetDeltas)`,
  `function queryBatchSwap(uint8 kind, ${SWAP_STEP}[] swaps, address[] assets, ${FUNDS} funds) returns (int256[] assetDeltas)`,
  `function swap((bytes32 poolId, uint8 kind, address assetIn, address assetOut, uint256 amount, bytes userData) singleSwap, ${FUNDS} funds, uint256 limit, uint256 deadline) payable returns (uint256)`,
]);
type Step = {poolId: Hex; assetInIndex: bigint; assetOutIndex: bigint; amount: bigint; userData: Hex};

type Http = {status: number; headers?: Record<string, string>} | "down" | {raw: string};
interface Fake {
  /** The SOR's answers, consumed in order (then the paths below). */
  sor?: Http[];
  sorErrors?: {message: string}[];
  paths?: {pools: string[]; tokens: string[]; amountIn: string}[];
  /** The RPC's answers, consumed in order (then the Vault below). */
  rpc?: Http[];
  weth?: string;
  vaultIn?: bigint;
  vaultOut?: bigint;
  intermediate?: bigint;
  /** queryBatchSwap reverts with this JSON-RPC error message. */
  revert?: string;
  /** queryBatchSwap answers this JSON-RPC error body (a node's own code and message). */
  rpcError?: {code?: number; message: string};
  /** queryBatchSwap answers this raw result. */
  queryResult?: Hex;
}

function answer(h: Http): Response {
  if (h === "down") throw new TypeError("fetch failed");
  if ("raw" in h) return new Response(h.raw);
  return new Response("{}", {status: h.status, headers: h.headers ?? {}});
}

/** The SOR (`api-v3.balancer.fi`) and the RPC, as the provider's existing tests fake them; the caller's abort honoured. */
function fake(o: Fake = {}): typeof fetch {
  const sor = [...(o.sor ?? [])];
  const rpc = [...(o.rpc ?? [])];
  const paths = o.paths ?? [{pools: [POOL_A], tokens: [WETH, USDC], amountIn: ONE}];
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
    const body = JSON.parse(String(init?.body));
    if (String(url).includes("balancer")) {
      const next = sor.shift();
      if (next) return answer(next);
      if (o.sorErrors) return new Response(JSON.stringify({errors: o.sorErrors}));
      return new Response(JSON.stringify({data: {sorGetSwapPaths: {protocolVersion: 2, paths: paths.map((p) => ({pools: p.pools, tokens: p.tokens.map((a) => ({address: a.toLowerCase(), decimals: 18})), inputAmountRaw: p.amountIn, outputAmountRaw: "1", protocolVersion: 2}))}}}));
    }
    const next = rpc.shift();
    if (next) return answer(next);
    if (body.method === "eth_getTransactionReceipt") return new Response(JSON.stringify({result: {status: "0x1"}}));
    const data = body.params[0].data as Hex;
    if (data.startsWith("0xad5c4648")) return new Response(JSON.stringify({result: encodeAbiParameters([{type: "address"}], [(o.weth ?? WETH) as Hex])}));
    if (o.revert) return new Response(JSON.stringify({jsonrpc: "2.0", id: 1, error: {code: 3, message: o.revert}}));
    if (o.rpcError) return new Response(JSON.stringify({jsonrpc: "2.0", id: 1, error: o.rpcError}));
    if (o.queryResult) return new Response(JSON.stringify({result: o.queryResult}));
    const call = decodeFunctionData({abi: VAULT, data});
    if (call.functionName !== "queryBatchSwap") throw new Error("unexpected call");
    const [, swaps, assets] = call.args;
    const amountIn = swaps.reduce((s, x) => s + x.amount, 0n);
    const deltas = assets.map((_, i) => (i === Number(swaps[0]!.assetInIndex) ? o.vaultIn ?? amountIn : i === assets.length - 1 ? -(o.vaultOut ?? 2_000_000n) : o.intermediate ?? 0n));
    return new Response(JSON.stringify({result: encodeFunctionResult({abi: VAULT, functionName: "queryBatchSwap", result: deltas})}));
  }) as typeof fetch;
}

/** getQuote: the onRefusal text and its classification. */
async function quote(o: Fake, over: Record<string, unknown> = {}, signal?: AbortSignal) {
  vi.stubGlobal("fetch", fake(o));
  const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
  const q = await balancerProvider({rpcUrls: RPC}).getQuote({...base, ...over, onRefusal: (text: string, info?: Swap2RefusalInfo) => { heard.push([text, info]); }} as never, signal);
  expect(q).toBeNull();
  expect(heard).toHaveLength(1);
  return {text: heard[0]![0], info: heard[0]![1]};
}

async function rejection(run: () => unknown): Promise<Error> {
  try { await run(); } catch (e) { return e as Error; }
  throw new Error("expected a rejection");
}

describe("balancer getQuote: the request this venue does not serve", () => {
  const throughWeth: Fake = {paths: [{pools: [POOL_A, POOL_B, POOL_A], tokens: [WETH, BAL, WETH, USDC], amountIn: ONE}]};
  const cases: Array<[string, Record<string, unknown>, string, Swap2RefusalInfo["reason"], Fake?]> = [
    ["an amount-flexible deposit", {flex: true}, "balancer: amount-flexible deposits are not supported", "unsupported_pair"],
    ["a cross-chain request", {destChain: "eip155:10"}, "balancer: same-chain swaps only", "unsupported_pair"],
    ["a chain without a Vault or RPC", {sourceChain: "eip155:8453", destChain: "eip155:8453"}, "balancer: no Balancer v2 Vault or RPC for eip155:8453", "unsupported_pair"],
    ["a token the catalog does not list", {sourceToken: "NOPE"}, "balancer: unknown source token NOPE", "unsupported_pair"],
    ["a destination token that is not an EVM address", {destToken: "So11111111111111111111111111111111111111112"}, "balancer: destination token must be an EVM address", "unsupported_pair"],
    ["a wrap", {sourceToken: "ETH", destToken: WETH}, "balancer: that is a wrap/unwrap, not a swap", "unsupported_pair"],
    ["the same token in and out", {sourceToken: "USDC", destToken: USDC}, "balancer: same token in and out", "unsupported_pair"],
    ["a recipient that cannot receive on an EVM chain", {destAddress: "UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG"}, "balancer: recipient must be an EVM address", "recipient_mismatch"],
    ["a native route through the wrapped native", {sourceToken: "ETH"}, "balancer: this route passes through the wrapped native — pick the wrapped token instead", "unsupported_pair", throughWeth],
  ];
  for (const [what, over, text, reason, o] of cases) {
    it(`${what} → ${reason}, the text unchanged`, async () => {
      expect(await quote(o ?? {}, over)).toEqual({text, info: {reason}});
    });
  }

  it("an invalid argument from the developer stays unclassified", async () => {
    expect(await quote({}, {amountIn: "1.5"})).toEqual({text: "balancer: amount is not an integer", info: undefined});
    expect(await quote({}, {amountIn: "0"})).toEqual({text: "balancer: amount must be positive", info: undefined});
  });
});

describe("balancer getQuote: the Vault and the RPC, through the real fetch path", () => {
  it("a Vault that wraps another WETH → vault_mismatch", async () => {
    expect(await quote({weth: "0x000000000000000000000000000000000000dEaD"})).toEqual({text: "balancer: the Vault on chain 1 is not the pinned deployment — refusing", info: {reason: "vault_mismatch"}});
  });

  it("RPC 429 with Retry-After → rate_limited; 403 → key_rejected; 5xx and the network → upstream_unavailable", async () => {
    expect(await quote({rpc: [{status: 429, headers: {"retry-after": "9"}}]})).toEqual({text: "balancer: no RPC answered on chain 1 (HTTP 429)", info: {reason: "rate_limited", httpStatus: 429, retryAfterMs: 9000}});
    expect(await quote({rpc: [{status: 403}]})).toEqual({text: "balancer: no RPC answered on chain 1 (HTTP 403)", info: {reason: "key_rejected", httpStatus: 403}});
    expect(await quote({rpc: [{status: 500}]})).toEqual({text: "balancer: no RPC answered on chain 1 (HTTP 500)", info: {reason: "upstream_unavailable", httpStatus: 500}});
    expect(await quote({rpc: ["down"]})).toEqual({text: "balancer: no RPC answered on chain 1 (fetch failed)", info: {reason: "upstream_unavailable"}});
  });

  it("the Vault reverting the batch (queryBatchSwap) → simulation_failed", async () => {
    expect(await quote({revert: "execution reverted: BAL#304"})).toEqual({text: "balancer: execution reverted: BAL#304", info: {reason: "simulation_failed"}});
    // A revert without data (geth's -32000), Nethermind's VM execution error.
    expect(await quote({rpcError: {code: -32000, message: "execution reverted"}})).toEqual({text: "balancer: execution reverted", info: {reason: "simulation_failed"}});
    expect(await quote({rpcError: {code: -32015, message: "VM execution error."}})).toEqual({text: "balancer: VM execution error.", info: {reason: "simulation_failed"}});
  });

  it("a node fault answered as a JSON-RPC error on queryBatchSwap → upstream_unavailable, not a revert (the node's text unchanged)", async () => {
    const faults: Array<{code?: number; message: string}> = [
      {code: -32000, message: "header not found"},
      {code: -32000, message: "missing trie node 7d3f (path )"},
      {code: -32005, message: "limit exceeded"},
      {code: -32603, message: "internal error"},
      {message: "request timed out"},
    ];
    for (const rpcError of faults) {
      expect(await quote({rpcError}), rpcError.message).toEqual({text: `balancer: ${rpcError.message}`, info: {reason: "upstream_unavailable"}});
    }
  });
});

describe("balancer getQuote: the SOR, through the real fetch path", () => {
  it("HTTP 429 with Retry-After → rate_limited; 401 → key_rejected; 5xx → upstream_unavailable; another 4xx unclassified", async () => {
    expect(await quote({sor: [{status: 429, headers: {"retry-after": "4"}}]})).toEqual({text: "balancer: SOR answered HTTP 429", info: {reason: "rate_limited", httpStatus: 429, retryAfterMs: 4000}});
    expect(await quote({sor: [{status: 401}]})).toEqual({text: "balancer: SOR answered HTTP 401", info: {reason: "key_rejected", httpStatus: 401}});
    expect(await quote({sor: [{status: 502}]})).toEqual({text: "balancer: SOR answered HTTP 502", info: {reason: "upstream_unavailable", httpStatus: 502}});
    // A 404 is a misconfigured apiUrl: configuration, not a venue refusal.
    expect(await quote({sor: [{status: 404}]})).toEqual({text: "balancer: SOR answered HTTP 404", info: undefined});
  });

  it("the network failing, an answer that is not JSON, a GraphQL error → upstream_unavailable", async () => {
    expect(await quote({sor: ["down"]})).toEqual({text: "balancer: fetch failed", info: {reason: "upstream_unavailable"}});
    const notJson = await new Response("<html>").json().then(() => "", (e: Error) => e.message);
    expect(await quote({sor: [{raw: "<html>"}]})).toEqual({text: `balancer: ${notJson}`, info: {reason: "upstream_unavailable"}});
    expect(await quote({sorErrors: [{message: "Invalid token"}]})).toEqual({text: "balancer: SOR: Invalid token", info: {reason: "upstream_unavailable"}});
  });

  it("the caller's own abort is not upstream_unavailable", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await quote({}, {}, ctrl.signal)).toEqual({text: "balancer: This operation was aborted", info: undefined});
  });

  it("the SOR's paths: none → no_route; a split off the amount → price_check_failed; other tokens or too many hops → policy_refused; a bad pool id → upstream_unavailable", async () => {
    expect(await quote({paths: []})).toEqual({text: "balancer: no Balancer v2 pool route for this pair and amount", info: {reason: "no_route"}});
    expect(await quote({paths: [{pools: [POOL_A], tokens: [WETH, USDC], amountIn: "1"}]})).toEqual({text: "balancer: the SOR split does not add up to the amount", info: {reason: "price_check_failed"}});
    expect(await quote({paths: [{pools: [POOL_A], tokens: [BAL, USDC], amountIn: ONE}]})).toEqual({text: "balancer: the SOR path does not start/end at the requested tokens", info: {reason: "policy_refused"}});
    expect(await quote({paths: [{pools: ["0x1234"], tokens: [WETH, USDC], amountIn: ONE}]})).toEqual({text: "balancer: malformed pool id from the SOR", info: {reason: "upstream_unavailable"}});
    const hops = BALANCER_MAX_SWAPS + 1;
    const tokens = [WETH, ...Array.from({length: hops - 1}, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`), USDC];
    expect(await quote({paths: [{pools: Array.from({length: hops}, () => POOL_A), tokens, amountIn: ONE}]})).toEqual({text: `balancer: the SOR route has ${hops} pool hops, more than ${BALANCER_MAX_SWAPS}`, info: {reason: "policy_refused"}});
  });
});

describe("balancer getQuote: the Vault's price", () => {
  it("another input → price_check_failed; zero output → amount_too_small; an intermediate balance → policy_refused; the floor → price_check_failed", async () => {
    expect(await quote({vaultIn: 5n})).toEqual({text: `balancer: the Vault would take 5, not ${ONE}`, info: {reason: "price_check_failed"}});
    expect(await quote({vaultOut: 0n})).toEqual({text: "balancer: the Vault prices this route at zero output", info: {reason: "amount_too_small"}});
    expect(await quote({intermediate: 7n, paths: [{pools: [POOL_A, POOL_B], tokens: [WETH, BAL, USDC], amountIn: ONE}]})).toEqual({text: "balancer: the batch leaves an intermediate balance — refusing", info: {reason: "policy_refused"}});
    expect(await quote({}, {minAmountOut: "1999000"})).toEqual({text: "balancer: floor breach (min=1990000 < floor=1999000)", info: {reason: "price_check_failed"}});
  });
});

describe("balancer preflightDeposit and buildDeposit", () => {
  async function quoted() {
    vi.stubGlobal("fetch", fake());
    const p = balancerProvider({rpcUrls: RPC});
    const q = (await p.getQuote(base))!;
    return {p, q, tx: await p.buildDeposit(q)};
  }
  const batch = (swaps: Step[]) => encodeFunctionData({abi: ABI, functionName: "batchSwap", args: [0, swaps, [WETH, USDC], {sender: ME, fromInternalBalance: false, recipient: ME, toInternalBalance: false}, [10n ** 18n, -1_990_000n], 2n ** 64n]});
  const step = (userData: Hex = "0x"): Step => ({poolId: POOL_A as Hex, assetInIndex: 0n, assetOutIndex: 1n, amount: 10n ** 18n, userData});

  it("a transaction or quote of a shape this module never signs → policy_refused", async () => {
    const {p, q, tx} = await quoted();
    const forged = (data: Hex) => [{...q, txRequest: {...q.txRequest!, data}}, {...tx, data}] as const;
    const query = encodeFunctionData({abi: ABI, functionName: "queryBatchSwap", args: [0, [step()], [WETH, USDC], {sender: ME, fromInternalBalance: false, recipient: ME, toInternalBalance: false}]});
    const cases: Array<[Quote, typeof tx, string]> = [
      [q, {...tx, data: batch([step(), step()])}, "balancer: the transaction is not the quoted batch. Nothing was sent; refresh the quote."],
      [...forged(query), "balancer: the transaction is not a Vault batchSwap"],
      [...forged(batch(Array.from({length: BALANCER_MAX_SWAPS + 1}, () => step()))), `balancer: the batch has ${BALANCER_MAX_SWAPS + 1} pool hops, not 1–${BALANCER_MAX_SWAPS}`],
      [...forged(batch([step("0xdead")])), "balancer: the batch carries pool userData this module never sends"],
    ];
    for (const [quote_, tx_, text] of cases) {
      const err = await rejection(() => p.preflightDeposit!(quote_, tx_));
      expect(err.message).toBe(text);
      expect(err.constructor).toBe(Error);
      expect(refusalOf(err)).toEqual({reason: "policy_refused"});
    }
  });

  it("a lower price → price_check_failed; the Vault reverting → simulation_failed; no RPC or an odd answer → upstream_unavailable", async () => {
    const {p, q, tx} = await quoted();
    vi.stubGlobal("fetch", fake({vaultOut: 1_000_000n}));
    const moved = await rejection(() => p.preflightDeposit!(q, tx));
    expect(moved.message).toBe("balancer: price moved — the pools now pay 1000000, under your minimum 1990000. Nothing was sent; refresh the quote.");
    expect(refusalOf(moved)).toEqual({reason: "price_check_failed"});
    vi.stubGlobal("fetch", fake({revert: "execution reverted: BAL#507"}));
    const reverted = await rejection(() => p.preflightDeposit!(q, tx));
    expect(reverted.message).toBe("execution reverted: BAL#507");
    expect(refusalOf(reverted)).toEqual({reason: "simulation_failed"});
    vi.stubGlobal("fetch", fake({rpcError: {code: -32000, message: "header not found"}}));
    const fault = await rejection(() => p.preflightDeposit!(q, tx));
    expect(fault.message).toBe("header not found");
    expect(fault.constructor).toBe(Error);
    expect(refusalOf(fault)).toEqual({reason: "upstream_unavailable"});
    vi.stubGlobal("fetch", fake({rpc: [{status: 503}]}));
    const down = await rejection(() => p.preflightDeposit!(q, tx));
    expect(down.message).toBe("balancer: no RPC answered on chain 1 (HTTP 503)");
    expect(refusalOf(down)).toEqual({reason: "upstream_unavailable", httpStatus: 503});
    vi.stubGlobal("fetch", fake({queryResult: "0x12"}));
    const odd = await rejection(() => p.preflightDeposit!(q, tx));
    const expected = (() => { try { decodeFunctionResult({abi: VAULT, functionName: "queryBatchSwap", data: "0x12"}); return null; } catch (e) { return e as Error; } })()!;
    expect(odd.message).toBe(expected.message);
    expect(odd.name).toBe(expected.name);
    expect(refusalOf(odd)).toEqual({reason: "upstream_unavailable"});
  });

  it("a quote without a transaction → policy_refused", async () => {
    const err = await rejection(() => balancerProvider({rpcUrls: RPC}).buildDeposit({intentId: "balancer:1"} as Quote));
    expect(err.message).toBe("swap2: Balancer quote has no transaction request");
    expect(refusalOf(err)).toEqual({reason: "policy_refused"});
  });
});

describe("balancerPins.reasonOf classifies balancerVerifyQuote's texts (return type unchanged)", () => {
  const params: QuoteParams = {...base};
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const vaultCall = (o: Partial<{kind: number; swaps: Step[]; funds: Record<string, unknown>; limits: bigint[]; deadline: bigint}> = {}) => encodeFunctionData({abi: ABI, functionName: "batchSwap", args: [
    o.kind ?? 0,
    o.swaps ?? [{poolId: POOL_A as Hex, assetInIndex: 0n, assetOutIndex: 1n, amount: 10n ** 18n, userData: "0x"}],
    [WETH, USDC],
    {sender: ME, fromInternalBalance: false, recipient: ME, toInternalBalance: false, ...o.funds} as never,
    o.limits ?? [10n ** 18n, -1_990_000n],
    o.deadline ?? deadline,
  ]});
  async function real(): Promise<Quote> {
    vi.stubGlobal("fetch", fake());
    return (await balancerProvider({rpcUrls: RPC}).getQuote(params))!;
  }

  it("each refusal text → its reason; the real build → null", async () => {
    const q = await real();
    expect(balancerVerifyQuote(params, q)).toBeNull();
    const withTx = (over: Partial<NonNullable<Quote["txRequest"]>>): Quote => ({...q, txRequest: {...q.txRequest!, ...over}});
    const {txRequest: _drop, ...noTx} = q;
    // `swap` is not in the module's Vault ABI (undecodable); queryBatchSwap is, and is not batchSwap.
    const single = encodeFunctionData({abi: ABI, functionName: "swap", args: [{poolId: POOL_A as Hex, kind: 0, assetIn: WETH, assetOut: USDC, amount: 1n, userData: "0x"}, {sender: ME, fromInternalBalance: false, recipient: ME, toInternalBalance: false}, 0n, deadline]});
    const query = encodeFunctionData({abi: ABI, functionName: "queryBatchSwap", args: [0, [{poolId: POOL_A as Hex, assetInIndex: 0n, assetOutIndex: 1n, amount: 10n ** 18n, userData: "0x"}], [WETH, USDC], {sender: ME, fromInternalBalance: false, recipient: ME, toInternalBalance: false}]});
    const cases: Array<[QuoteParams, Quote, string, Swap2RefusalInfo["reason"]]> = [
      [{...params, destChain: "eip155:10"}, q, "not a same-chain swap on a Balancer v2 chain", "unsupported_pair"],
      [params, noTx as Quote, "the quote carries no Vault call", "policy_refused"],
      [params, withTx({to: ATTACKER}), `the call targets ${ATTACKER}, not the Vault`, "vault_mismatch"],
      [{...params, sourceToken: "NOPE"}, q, "unknown source token NOPE", "unsupported_pair"],
      [params, withTx({value: "1"}), "a token input attaches no value and approves the Vault", "policy_refused"],
      [params, withTx({data: "0xdeadbeef"}), "the Vault call is not batchSwap", "policy_refused"],
      [params, withTx({data: single}), "the Vault call is not batchSwap", "policy_refused"],
      [params, withTx({data: query}), "queryBatchSwap is not batchSwap", "policy_refused"],
      [params, withTx({data: vaultCall({kind: 1})}), "the batch is not GIVEN_IN", "policy_refused"],
      [params, withTx({data: vaultCall({funds: {toInternalBalance: true}})}), "the batch uses Vault internal balances", "policy_refused"],
      [params, withTx({data: vaultCall({funds: {recipient: ATTACKER}})}), `the batch takes from ${ME} and pays ${ATTACKER}, not this account and the recipient`, "recipient_mismatch"],
      // Debiting another account pays no one else: a batch shape this module never signs.
      [params, withTx({data: vaultCall({funds: {sender: ATTACKER}})}), `the batch takes from ${ATTACKER} and pays ${ME}, not this account and the recipient`, "policy_refused"],
      [params, withTx({data: vaultCall({funds: {sender: ATTACKER, recipient: ATTACKER}})}), `the batch takes from ${ATTACKER} and pays ${ATTACKER}, not this account and the recipient`, "recipient_mismatch"],
      [params, withTx({data: vaultCall({limits: [10n ** 18n, -1n]})}), "the limits are not exactly the input in and the quote's minimum out", "price_check_failed"],
      [params, withTx({data: vaultCall({swaps: [{poolId: POOL_A as Hex, assetInIndex: 0n, assetOutIndex: 1n, amount: 5n, userData: "0x"}]})}), `the hops sell 5, not the ${ONE} input`, "price_check_failed"],
      [params, withTx({data: vaultCall({deadline: 1n})}), "the batch deadline has passed", "quote_expired"],
    ];
    for (const [p, quote_, text, reason] of cases) {
      const refusal = balancerVerifyQuote(p, quote_);
      expect(refusal).toBe(text);
      expect(balancerPins.reasonOf!(refusal!)).toEqual({reason});
    }
  });

  it("a request that does not parse, and a text these pins never produced, stay unclassified", async () => {
    const q = await real();
    const refusal = balancerVerifyQuote({...params, destAddress: "not an address"}, q);
    expect(refusal).toBe("the request does not name EVM tokens, a recipient and amounts");
    expect(balancerPins.reasonOf!(refusal!)).toBeUndefined();
    expect(balancerPins.reasonOf!("something else entirely")).toBeUndefined();
  });

  it("behind remoteProvider the stub's refusal carries the pins' reason", async () => {
    const q = await real();
    const evil = {...q, txRequest: {...q.txRequest!, data: vaultCall({funds: {recipient: ATTACKER}})}};
    const fetchImpl = (async () => new Response(JSON.stringify(evil), {status: 200})) as unknown as typeof fetch;
    const stub = remoteProvider({name: "balancer", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, supportsSameChain: true, ...balancerPins});
    const err = await rejection(() => stub.getQuote(params));
    expect(err.message).toBe(`balancer: the quote fails this app's own check — the batch takes from ${ME} and pays ${ATTACKER}, not this account and the recipient`);
    expect(refusalOf(err)).toEqual({reason: "recipient_mismatch"});
  });
});

describe("the engine's no-route error carries Balancer's reason", () => {
  it("BalancerSwap2Protocol.quoteSwap2 on an SOR 429: the text unchanged, rate_limited with the wait", async () => {
    vi.stubGlobal("fetch", fake({sor: [{status: 429, headers: {"retry-after": "30"}}]}));
    const err = await rejection(() => new BalancerSwap2Protocol(undefined, {fromChain: "eip155:1", rpcUrls: RPC}).quoteSwap2({fromToken: "WETH", toToken: USDC, toChain: 1, recipient: ME, fromTokenAmount: 10n ** 18n} as never));
    expect(err).toBeInstanceOf(Swap2QuoteError);
    expect(err.message).toBe("swap2: no route available for the requested pair :: balancer: SOR answered HTTP 429");
    expect(refusalOf(err)).toEqual({reason: "rate_limited", retryAfterMs: 30_000});
    expect((err as Swap2QuoteError).refusals).toEqual([{message: "balancer: SOR answered HTTP 429", provider: "balancer", reason: "rate_limited", httpStatus: 429, retryAfterMs: 30_000}]);
  });
});
