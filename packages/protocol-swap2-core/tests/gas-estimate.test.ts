// Quote.gasEstimate / gasEstimateSource (2026-11-28): the gas a route's main source transaction is expected to use,
// apart from txRequest.gasLimit (the bound it is sent with). The contract is enforced where quotes are validated
// (quoteRejection, the router, the single-provider path), carried and sealed by the swap2 server, and never read by
// execution: the transaction still goes out with the quoted gas limit.
import {describe, expect, it} from "vitest";
import {remoteProvider} from "../src/remote.js";
import {createSwap2Handler} from "../src/server.js";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {Swap2ExecutionPlan} from "../src/swap2/base.js";
import {GAS_ESTIMATE_SOURCES, gasEstimateCulprit, gasEstimateProblem, quoteRejection, validQuote} from "../src/validate.js";
import * as index from "../src/index.js";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "../src/types.js";

const SELF = "0x4444444444444444444444444444444444444444";
const ROUTER = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const PARAMS: QuoteParams = {
  sourceChain: "eip155:1", sourceToken: "USDC", destChain: "eip155:1", destToken: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  amountIn: "1000000", destAddress: SELF,
};
const base = (over: {[K in keyof Quote]?: Quote[K] | undefined} = {}): Quote => ({
  provider: "gas", intentId: "intent-1", depositAddress: "", depositMemo: null,
  txRequest: {to: ROUTER, data: "0xdeadbeef", value: "0", chainId: 1, gasLimit: "250000", approvalAddress: ROUTER},
  sourceAmount: "1000000", destAmount: "999000", minDestAmount: "990000", feeUsd: 0, etaSeconds: 12, reliability: 1,
  validUntilMs: Date.now() + 60_000, ...over,
}) as Quote;

describe("gasEstimateProblem: the contract module implementers follow", () => {
  it("both absent, or a positive estimate within the gas limit with a known source, holds", () => {
    expect(gasEstimateProblem(base(), "eip155:1")).toBeNull();
    for (const source of GAS_ESTIMATE_SOURCES) expect(gasEstimateProblem(base({gasEstimate: "180000", gasEstimateSource: source}), "eip155:1")).toBeNull();
    expect(gasEstimateProblem(base({gasEstimate: "250000", gasEstimateSource: "venue"}), "eip155:1")).toBeNull(); // equal to the limit
    // A quote without a transaction (a dry price, Kyber's routes answer) has no limit to be held to.
    expect(gasEstimateProblem(base({txRequest: undefined, gasEstimate: "9999999999", gasEstimateSource: "venue"}), "eip155:8453")).toBeNull();
  });

  it("a gasless route carries exactly \"0\"; any other route a positive figure", () => {
    expect(gasEstimateProblem(base({txRequest: undefined, gasless: true, gasEstimate: "0", gasEstimateSource: "model"}), "eip155:1")).toBeNull();
    expect(gasEstimateProblem(base({txRequest: undefined, gasless: true, gasEstimate: "21000", gasEstimateSource: "model"}), "eip155:1")).toMatch(/gasless quote carries gasEstimate 21000/);
    expect(gasEstimateProblem(base({gasEstimate: "0", gasEstimateSource: "venue"}), "eip155:1")).toMatch(/0 on a quote that is not gasless/);
  });

  it("above the quoted gas limit is refused: the estimate is what the call uses, the limit what it may use", () => {
    expect(gasEstimateProblem(base({gasEstimate: "250001", gasEstimateSource: "venue"}), "eip155:1")).toBe("gasEstimate 250001 is above txRequest.gasLimit 250000");
  });

  it("set together, canonical digits only, a known source, EVM sources only", () => {
    expect(gasEstimateProblem(base({gasEstimate: "180000"}), "eip155:1")).toMatch(/not one of venue/);
    expect(gasEstimateProblem(base({gasEstimateSource: "venue"}), "eip155:1")).toMatch(/without gasEstimate/);
    for (const bad of ["", "0180000", "1e5", " 180000", "180000.0", "-1", "0x2bf20", "12345678901"]) {
      expect(gasEstimateProblem(base({gasEstimate: bad, gasEstimateSource: "venue"}), "eip155:1"), bad).toMatch(/not canonical/);
    }
    expect(gasEstimateProblem(base({gasEstimate: 180000 as unknown as string, gasEstimateSource: "venue"}), "eip155:1")).toMatch(/not canonical/);
    expect(gasEstimateProblem(base({gasEstimate: "180000", gasEstimateSource: "measured" as never}), "eip155:1")).toMatch(/not one of venue/);
    expect(gasEstimateProblem(base({txRequest: undefined, depositAddress: "So1", gasEstimate: "5000", gasEstimateSource: "venue"}), "solana:mainnet")).toMatch(/non-EVM source chain/);
  });

  it("quoteRejection refuses a broken estimate as malformed (upstream_unavailable); a sound one passes", () => {
    expect(quoteRejection(base({gasEstimate: "180000", gasEstimateSource: "venue"}), PARAMS, "gas")).toBeNull();
    expect(validQuote(base({gasEstimate: "180000", gasEstimateSource: "venue"}), PARAMS, "gas")).toBe(true);
    expect(quoteRejection(base({gasEstimate: "300000", gasEstimateSource: "venue"}), PARAMS, "gas")).toEqual({reason: "upstream_unavailable"});
    expect(quoteRejection(base({gasEstimate: "180000"}), PARAMS, "gas")).toEqual({reason: "upstream_unavailable"});
  });

  it("gasEstimateCulprit names the estimate only when it is what fails", () => {
    expect(gasEstimateCulprit(base({gasEstimate: "300000", gasEstimateSource: "venue"}), PARAMS, "gas")).toMatch(/above txRequest.gasLimit/);
    // Another provider's quote fails on its own: the estimate is not the culprit.
    expect(gasEstimateCulprit(base({provider: "other", gasEstimate: "300000", gasEstimateSource: "venue"}), PARAMS, "gas")).toBeNull();
    expect(gasEstimateCulprit(base({gasEstimate: "180000", gasEstimateSource: "venue"}), PARAMS, "gas")).toBeNull();
  });

  it("is exported from the package entry", () => {
    expect(index.gasEstimateProblem).toBe(gasEstimateProblem);
    expect(index.GAS_ESTIMATE_SOURCES).toEqual(["venue", "simulated", "model"]);
  });
});

describe("gasEstimate over the swap2 server (remoteProvider ↔ createSwap2Handler)", () => {
  const SECRET = "test-seal-secret-that-is-at-least-32-bytes-long";
  const TX: UnsignedTx = {chain: "eip155:1", to: ROUTER, value: "0", data: "0xdeadbeef", chainId: 1, gasLimit: "250000", approvalAddress: ROUTER};
  function setup(quote: Quote) {
    const seen: {built?: Quote} = {};
    const provider: CrossChainProvider = {
      name: "gas", enabled: () => true, supportsRoute: () => true,
      getQuote: async () => ({...quote, txRequest: quote.txRequest ? {...quote.txRequest} : undefined} as Quote),
      buildDeposit: async (q) => { seen.built = q; return TX; },
      trackIntent: async () => ({state: "pending"}),
    };
    const handle = createSwap2Handler({providers: [provider], sealSecret: SECRET, guard: () => {}});
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "user");
      return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
    return {handle, seen, client: remoteProvider({name: "gas", baseUrl: "https://api.example.test/swap2", fetchImpl})};
  }

  it("is carried, sealed and handed back to the provider's build unchanged", async () => {
    const quote = base({gasEstimate: "171234", gasEstimateSource: "simulated"});
    const {client, seen} = setup(quote);
    const q = await client.getQuote(PARAMS);
    expect(q).toMatchObject({gasEstimate: "171234", gasEstimateSource: "simulated"});
    await client.buildDeposit(q!);
    expect(seen.built).toMatchObject({gasEstimate: "171234", gasEstimateSource: "simulated"});
  });

  it("an estimate changed after sealing fails the integrity check: a client cannot rewrite what it was quoted", async () => {
    const {handle, seen} = setup(base({gasEstimate: "171234", gasEstimateSource: "venue"}));
    const sealed = (await handle("quote", {provider: "gas", params: PARAMS}, "user")).body as Quote;
    expect(sealed.gasEstimate).toBe("171234");
    expect(await handle("build", {provider: "gas", quote: {...sealed, gasEstimate: "21000"}}, "user")).toEqual({status: 400, body: {error: "quote integrity check failed", reason: "policy_refused"}});
    const {gasEstimate: _e, gasEstimateSource: _s, ...stripped} = sealed;
    expect((await handle("build", {provider: "gas", quote: stripped}, "user")).status).toBe(400);
    expect(seen.built).toBeUndefined();
  });

  it("a provider's broken estimate is never sealed: refused like any malformed quote", async () => {
    for (const broken of [
      base({gasEstimate: "300000", gasEstimateSource: "venue"}), // above its gas limit
      base({gasEstimate: "171234", gasEstimateSource: "guess" as never}), // unknown source
      base({gasEstimate: "171234"}), // no source
      base({gasEstimate: "0x29cf2" as never, gasEstimateSource: "venue"}), // not decimal
    ]) {
      const {handle} = setup(broken);
      const res = await handle("quote", {provider: "gas", params: PARAMS}, "user");
      expect(res.status, JSON.stringify(broken.gasEstimate)).toBe(502);
    }
  });
});

describe("gasEstimate in execution: informative only", () => {
  const options = {fromToken: "USDC", toToken: "0xdAC17F958D2ee523a2206206994597C13D831ec7", recipient: SELF, fromTokenAmount: 1_000_000n, minAmountOut: 980_000n};
  function protocol(quote: (p: QuoteParams) => Quote, sent: Array<{data?: string; gasLimit?: bigint}>, plans: Swap2ExecutionPlan[] = []) {
    const provider: CrossChainProvider = {
      name: "gas", enabled: () => true, supportsRoute: () => true, supportsSameChain: true,
      getQuote: async (p) => quote(p),
      buildDeposit: async (q) => { const {nativeFee: _f, ...tx} = q.txRequest!; return {...tx, chain: "eip155:1", to: tx.to!, value: tx.value ?? "0"}; },
      trackIntent: async () => ({state: "pending"}),
    };
    class P extends SingleProviderSwap2 {
      protected readonly provider = provider;
      protected chainSupported(): boolean { return true; }
    }
    const account = {
      getAddress: async () => SELF, getChainId: async () => 1, waitForTransaction: async () => {},
      sendTransaction: async (tx: {data?: string; gasLimit?: bigint}) => { sent.push(tx); return {hash: `0x${sent.length}`}; },
    };
    return new P(account as never, {fromChain: "eip155:1", reviewExecution: (plan) => { plans.push(plan); }});
  }

  it("the source transaction still goes out with the quoted gas limit; the plan shows the limit, not the estimate", async () => {
    const sent: Array<{data?: string; gasLimit?: bigint}> = [];
    const plans: Swap2ExecutionPlan[] = [];
    await protocol((p) => base({sourceAmount: p.amountIn, intentId: `i-${Math.random()}`, gasEstimate: "171234", gasEstimateSource: "venue"}), sent, plans).swap2(options);
    expect(sent.at(-1)).toMatchObject({data: "0xdeadbeef", gasLimit: 250_000n});
    expect(plans[0]!.source).toMatchObject({kind: "call", gasLimit: 250_000n});
    expect(JSON.stringify(plans[0], (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("171234");
  });

  it("a quote whose estimate breaks the contract is no route, and the refusal names the rule", async () => {
    const sent: Array<{data?: string}> = [];
    const swap = protocol((p) => base({sourceAmount: p.amountIn, gasEstimate: "300000", gasEstimateSource: "venue"}), sent);
    const error = await swap.swap2(options).catch((e: unknown) => e) as {message: string; reason?: string};
    expect(error.message).toMatch(/no route available.*gas: rejected by validation \(gasEstimate 300000 is above txRequest.gasLimit 250000\)/);
    expect(error.reason).toBe("upstream_unavailable");
    expect(sent).toEqual([]);
  });
});
