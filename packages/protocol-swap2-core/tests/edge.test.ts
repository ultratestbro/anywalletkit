// Layer C: edge cases of swap2() execution. Mocked provider + account only —
// no network, no keys. Every abort asserts that nothing was signed or sent.
// Each former GAP (written first as `it.fails`) is now a passing test.
import {describe, expect, it} from "vitest";
import {encodeFunctionData, parseAbi} from "viem";
import {Swap2InFlightError, Swap2InsufficientGasError, Swap2MaybeSentError, Swap2QuoteError, Swap2ValidationError} from "../src/errors.js";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import {nativeDecimals, nativeUnits, type Swap2EngineConfig, type Swap2ExecutionPlan} from "../src/swap2/base.js";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "../src/types.js";

const SELF = "0x4444444444444444444444444444444444444444";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DEPOSIT = "0x5555555555555555555555555555555555555555";
const txRequest = {to: DIAMOND, data: "0xdeadbeef", value: "0", chainId: 1, gasLimit: "21000", approvalAddress: DIAMOND};
// USDC on Ethereum: one approval (USDT would add the approve(0) reset).
const options = {
  fromToken: "USDC", toToken: "0xFd086bC7CD5C481DCC9C85EBE478A1C0b69FCbb9", toChain: 42161,
  recipient: RECIPIENT, fromTokenAmount: 1_000_000n, minAmountOut: 980_000n,
};

function quote(params: QuoteParams, over: {[K in keyof Quote]?: Quote[K] | undefined} = {}): Quote {
  return {
    provider: "edge", intentId: `intent-${Math.random()}`, depositAddress: "", depositMemo: null, txRequest,
    sourceAmount: params.amountIn, destAmount: "990000", minDestAmount: "980000",
    feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000, ...over,
  } as Quote;
}
/** The provider build that reproduces the quote's transaction exactly. */
const built = (q: Quote): UnsignedTx => {
  const {nativeFee: _fee, ...tx} = q.txRequest!;
  return {...tx, chain: "eip155:1", to: tx.to!, value: tx.value ?? "0"};
};
function provider(over: Partial<CrossChainProvider> = {}): CrossChainProvider {
  return {
    name: "edge", enabled: () => true, supportsRoute: () => true,
    getQuote: async (params) => quote(params),
    buildDeposit: async (q) => built(q),
    trackIntent: async () => ({state: "pending"}),
    ...over,
  };
}
/** Records approve / deposit / transfer sends in order. */
function account(log: string[], over: Record<string, unknown> = {}) {
  let n = 0;
  return {
    getAddress: async () => SELF,
    getChainId: async () => 1,
    sendTransaction: async (tx: {data?: string}) => {
      n += 1;
      log.push(tx.data?.startsWith("0x095ea7b3") ? (tx.data.endsWith("0".repeat(64)) ? "revoke" : "approve") : "deposit");
      return {hash: `0x${n}`};
    },
    waitForTransaction: async () => {},
    ...over,
  };
}
function protocol(p: CrossChainProvider, acc: unknown, config: Partial<Swap2EngineConfig> = {}) {
  class P extends SingleProviderSwap2 {
    protected readonly provider = p;
    protected chainSupported(): boolean { return true; }
  }
  return new P(acc as never, {fromChain: "eip155:1", ...config});
}

describe("edge: quote expiry", () => {
  // The engine re-quotes exactly once, and only when its own mined approvals
  // pushed the quote past its TTL (SDK-128): the exact allowance is kept and
  // spent by the second pass. Everything else is a hard abort and the caller
  // starts a new swap2() (which quotes afresh).
  const slow = (log: string[]) => account(log, {waitForTransaction: () => new Promise((r) => setTimeout(r, 80))});
  // The first quote dies during the 80 ms approval; the re-quote lives long
  // enough to reach the broadcast even on a loaded CI machine.
  const ttl = (n: number) => Date.now() + (n === 1 ? 40 : 10_000);
  const shortLived = (over: Partial<CrossChainProvider> = {}) => {
    let n = 0;
    return provider({getQuote: async (params) => quote(params, {validUntilMs: ttl(++n)}), ...over});
  };

  it("expiring while the approval is being mined re-quotes once and spends the allowance — no revoke, no second approve", async () => {
    const log: string[] = [];
    const phases: string[] = [];
    let quotes = 0;
    const p = shortLived({getQuote: async (params) => { quotes += 1; return quote(params, {validUntilMs: ttl(quotes)}); }});
    await protocol(p, slow(log), {onExecutionPhase: (ph) => phases.push(ph)}).swap2(options);
    expect(log).toEqual(["approve", "deposit"]);
    expect(quotes).toBe(2);
    expect(phases).toEqual(["approving", "requoting", "signing", "broadcast"]);
  });

  it("the re-quote pass is not reviewed again", async () => {
    const log: string[] = [];
    let reviews = 0;
    await protocol(shortLived(), slow(log), {reviewExecution: async () => { reviews += 1; }}).swap2(options);
    expect([log, reviews]).toEqual([["approve", "deposit"], 1]);
  });

  it("a second expiry (the fresh quote also died) aborts with a typed error and revokes exactly once", async () => {
    const log: string[] = [];
    let quotes = 0;
    // 1st quote: 40 ms, outlived by the 80 ms approval. 2nd: 40 ms, outlived
    // by a slow build (an expired quote never passes validation, so it has to
    // die between the build and the broadcast check, like the first one).
    const p = provider({
      getQuote: async (params) => { quotes += 1; return quote(params, {validUntilMs: Date.now() + 40}); },
      buildDeposit: async (q) => { if (quotes === 2) await new Promise((r) => setTimeout(r, 80)); return built(q); },
    });
    const run = protocol(p, slow(log)).swap2(options);
    await expect(run).rejects.toThrow(/quote expired before source broadcast/);
    await expect(run).rejects.toBeInstanceOf(Swap2QuoteError);
    expect(log).toEqual(["approve", "revoke"]);
    expect(quotes).toBe(2);
  });

  it("a fresh quote with a different spender revokes the allowance and aborts", async () => {
    const log: string[] = [];
    let quotes = 0;
    const other = "0x7777777777777777777777777777777777777777";
    const p = provider({
      getQuote: async (params) => {
        quotes += 1;
        return quotes === 1
          ? quote(params, {validUntilMs: Date.now() + 40})
          : quote(params, {txRequest: {...txRequest, to: other, approvalAddress: other}});
      },
    });
    await expect(protocol(p, slow(log)).swap2(options)).rejects.toThrow(/moved the spender/);
    expect(log).toEqual(["approve", "revoke"]);
  });

  it("a fresh quote that no longer needs an allowance revokes and aborts", async () => {
    const log: string[] = [];
    let quotes = 0;
    const p = provider({
      getQuote: async (params) => {
        quotes += 1;
        return quotes === 1
          ? quote(params, {validUntilMs: Date.now() + 40})
          : quote(params, {txRequest: {...txRequest, approvalAddress: undefined} as never});
      },
    });
    await expect(protocol(p, slow(log)).swap2(options)).rejects.toThrow(/no longer spends through an allowance/);
    expect(log).toEqual(["approve", "revoke"]);
  });

  it("a failed re-quote (no route) revokes exactly once and surfaces the quote error", async () => {
    const log: string[] = [];
    let quotes = 0;
    const p = provider({getQuote: async (params) => { quotes += 1; if (quotes > 1) return null as never; return quote(params, {validUntilMs: Date.now() + 40}); }});
    await expect(protocol(p, slow(log)).swap2(options)).rejects.toThrow(/no route available/);
    expect(log).toEqual(["approve", "revoke"]);
  });

  it("a failure after the re-quote pass adopted the allowance revokes exactly once", async () => {
    const log: string[] = [];
    let quotes = 0;
    const p = shortLived({
      getQuote: async (params) => { quotes += 1; return quote(params, {validUntilMs: ttl(quotes)}); },
      preflightDeposit: async () => { if (quotes === 2) throw new Error("halted"); },
    });
    await expect(protocol(p, slow(log)).swap2(options)).rejects.toThrow(/halted/);
    expect(log).toEqual(["approve", "revoke"]);
  });

  it("expiry during a slow mine with no approval at all is still a hard abort", async () => {
    // Deposit-address route: nothing was approved, nothing to keep.
    const p = provider({
      getQuote: async (params) => quote(params, {txRequest: undefined, depositAddress: DEPOSIT, validUntilMs: Date.now() + 40}),
      buildDeposit: async (q) => { await new Promise((r) => setTimeout(r, 80)); return {chain: "eip155:1", to: q.depositAddress, value: q.sourceAmount}; },
    });
    const log: string[] = [];
    await expect(protocol(p, account(log)).swap2({...options, fromToken: "ETH"})).rejects.toThrow(/quote expired before source broadcast/);
    expect(log).toEqual([]);
  });
});

describe("edge: allowance-aware approvals (SDK-128)", () => {
  const USDT_OPTIONS = {...options, fromToken: "USDT"};
  const withAllowance = (log: string[], current: bigint | (() => Promise<bigint>)) =>
    account(log, {getAllowance: typeof current === "function" ? current : async () => current});

  it("mainnet USDT with a zero allowance gets a single approve(n) — no reset", async () => {
    const log: string[] = [];
    const plans: Swap2ExecutionPlan[] = [];
    await protocol(provider(), withAllowance(log, 0n), {reviewExecution: async (plan) => { plans.push(plan); }}).swap2(USDT_OPTIONS);
    expect(log).toEqual(["approve", "deposit"]);
    expect(plans[0]!.approvals.map((a) => a.amount)).toEqual([1_000_000n]);
  });

  it("mainnet USDT with a stale non-zero allowance resets first", async () => {
    const log: string[] = [];
    await protocol(provider(), withAllowance(log, 5n)).swap2(USDT_OPTIONS);
    expect(log).toEqual(["revoke", "approve", "deposit"]);
  });

  it("without getAllowance (or when the read fails) USDT is reset every time", async () => {
    const plain: string[] = [];
    await protocol(provider(), account(plain)).swap2(USDT_OPTIONS);
    expect(plain).toEqual(["revoke", "approve", "deposit"]);
    const failing: string[] = [];
    await protocol(provider(), withAllowance(failing, async () => { throw new Error("rpc down"); })).swap2(USDT_OPTIONS);
    expect(failing).toEqual(["revoke", "approve", "deposit"]);
  });

  it("an exact allowance already in place sends no approval, and a failure leaves it alone", async () => {
    const log: string[] = [];
    const plans: Swap2ExecutionPlan[] = [];
    await protocol(provider(), withAllowance(log, 1_000_000n), {reviewExecution: async (plan) => { plans.push(plan); }}).swap2(options);
    expect(log).toEqual(["deposit"]);
    expect(plans[0]!.approvals).toEqual([]);
    const failed: string[] = [];
    const halted = provider({preflightDeposit: async () => { throw new Error("halted"); }});
    await expect(protocol(halted, withAllowance(failed, 1_000_000n)).swap2(options)).rejects.toThrow(/halted/);
    expect(failed).toEqual([]); // not ours to revoke
  });

  it("a non-USDT token with a different allowance is overwritten in one approve", async () => {
    const log: string[] = [];
    await protocol(provider(), withAllowance(log, 5n)).swap2(options);
    expect(log).toEqual(["approve", "deposit"]);
  });
});

describe("edge: declined review", () => {
  it("nothing is signed, no approval, no phase past review, no preflight/notify", async () => {
    const log: string[] = [];
    const phases: string[] = [];
    const touched: string[] = [];
    const p = provider({
      preflightDeposit: async () => { touched.push("preflight"); },
      notifyDeposit: async () => { touched.push("notify"); },
    });
    const review = (plan: Swap2ExecutionPlan) => {
      // A reviewer cannot tamper with the plan (frozen) …
      expect(() => { (plan.approvals as unknown[]).push({}); }).toThrow(TypeError);
      throw new Error("user cancelled"); // … and declining aborts.
    };
    await expect(protocol(p, account(log), {reviewExecution: review, onExecutionPhase: (ph) => phases.push(ph)}).swap2(options))
      .rejects.toThrow(/user cancelled/);
    expect([log, phases, touched]).toEqual([[], [], []]);
  });
});

describe("edge: approval succeeds, main leg fails", () => {
  it("a dropped deposit revokes, reports no broadcast, and a retry approves exactly once more", async () => {
    const log: string[] = [];
    const phases: string[] = [];
    let drop = true;
    const base = account(log);
    const flaky = {
      ...base,
      sendTransaction: async (tx: {data?: string}) => {
        const r = await base.sendTransaction(tx);
        if (log.at(-1) === "deposit" && drop) { drop = false; throw new Error("network dropped"); }
        return r;
      },
    };
    const swap = protocol(provider(), flaky, {onExecutionPhase: (ph) => phases.push(ph)});
    await expect(swap.swap2(options)).rejects.toThrow(/network dropped/);
    expect(log).toEqual(["approve", "deposit", "revoke"]);
    expect(phases).toEqual(["approving", "signing"]); // never "broadcast"
    log.length = 0;
    await expect(swap.swap2(options)).resolves.toMatchObject({hash: expect.any(String)});
    expect(log).toEqual(["approve", "deposit"]);
  });

  it("a status/notify failure after broadcast still returns the source hash (1Click indexer lag)", async () => {
    const log: string[] = [];
    const p = provider({notifyDeposit: async () => { throw new Error("indexer 503"); }});
    const r = await protocol(p, account(log)).swap2(options);
    expect(r.hash).toBe("0x2");
    expect(r.id).toContain("0x2"); // the id carries the source hash, so status can be re-polled
    expect(log).toEqual(["approve", "deposit"]);
  });

  // Was a GAP (medium): a lost deposit response looked like a clean failure,
  // so the approval was revoked and a retry sent a second deposit.
  it("a lost deposit response is reported as possibly-broadcast, not as a clean failure", async () => {
    const log: string[] = [];
    const base = account(log);
    const lossy = {...base, sendTransaction: async (tx: {data?: string}) => {
      await base.sendTransaction(tx);
      if (log.at(-1) === "deposit") throw new Error("socket hang up");
      return {hash: "0x1"};
    }};
    const err = await protocol(provider(), lossy).swap2(options).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Swap2MaybeSentError);
    expect((err as Error).message).toMatch(/may have been broadcast/);
    expect(log).toEqual(["approve", "deposit"]); // no revoke racing a deposit that may spend it
  });

  it("an account that reports the signed hash of a lost broadcast hands it on with a pollable id", async () => {
    const log: string[] = [];
    const base = account(log);
    const HASH = `0x${"ab".repeat(32)}`;
    const lossy = {...base, sendTransaction: async (tx: {data?: string}) => {
      const r = await base.sendTransaction(tx);
      if (log.at(-1) === "deposit") throw Object.assign(new Error("Broadcast outcome unknown"), {maybeSent: true, hash: HASH});
      return r;
    }};
    const err = await protocol(provider(), lossy).swap2(options).catch((e: unknown) => e) as Swap2MaybeSentError;
    expect(err).toBeInstanceOf(Swap2MaybeSentError);
    expect(err.hash).toBe(HASH);
    expect(err.id).toContain(HASH);
    expect(log).toEqual(["approve", "deposit"]);
  });
});

describe("edge: double execution", () => {
  // Was a GAP (medium): a double tap ran two complete swaps.
  it("a second concurrent swap2() with the same options is refused", async () => {
    const log: string[] = [];
    const acc = account(log);
    const swap = protocol(provider(), acc);
    const results = await Promise.allSettled([swap.swap2(options), swap.swap2(options), protocol(provider(), acc).swap2(options)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason)).toEqual([expect.any(Swap2InFlightError), expect.any(Swap2InFlightError)]);
    expect(log.filter((l) => l === "deposit")).toHaveLength(1);
    // Once settled, the same swap may run again; a different amount never waits.
    await expect(swap.swap2(options)).resolves.toBeDefined();
    await expect(Promise.all([swap.swap2(options), swap.swap2({...options, fromTokenAmount: 2_000_000n})])).resolves.toHaveLength(2);
  });
});

describe("edge: insufficient native gas", () => {
  // Was a GAP (medium): the approval could be mined (and paid) before the
  // deposit failed for gas.
  it("is refused before the first approval when the account has no gas", async () => {
    const log: string[] = [];
    const broke = account(log, {getBalance: async () => 0n, quoteSendTransaction: async () => ({fee: 50_000_000_000_000n})});
    await expect(protocol(provider(), broke).swap2(options)).rejects.toBeInstanceOf(Swap2InsufficientGasError);
    expect(log).toEqual([]);
  });

  it("counts every approval, the main call and its value; enough balance goes through", async () => {
    const log: string[] = [];
    const quoted: string[] = [];
    const fee = 1_000n;
    const funded = (balance: bigint) => account(log, {
      getBalance: async () => balance,
      quoteSendTransaction: async (tx: {data?: string}) => { quoted.push(tx.data!.slice(0, 10)); return {fee}; },
    });
    const withValue = provider({getQuote: async (params) => quote(params, {txRequest: {...txRequest, value: "500", nativeFee: "500"}})});
    // approve + deposit fees + 500 value = 2500
    await expect(protocol(withValue, funded(2_499n)).swap2(options)).rejects.toThrow(/need 2500/);
    expect(quoted).toEqual(["0x095ea7b3", "0xdeadbeef"]);
    expect(log).toEqual([]);
    await expect(protocol(withValue, funded(2_500n)).swap2(options)).resolves.toBeDefined();
    expect(log).toEqual(["approve", "deposit"]);
  });
});

describe("edge: amount precision (THORChain-style 8-decimal provider)", () => {
  // A provider that refuses >8 dp, exactly like protocol-swap2-thorchain.
  const thorLike = provider({
    getQuote: async (params) => {
      const units = BigInt(params.amountIn);
      if (units % 10n ** 10n !== 0n) {
        params.onRefusal?.("thorchain: amount has more precision than THORChain's 8 decimals — round it to 8 decimals");
        return null;
      }
      return quote(params);
    },
  });
  const eth = {fromToken: "ETH", toToken: "0x0000000000000000000000000000000000000000", toChain: 56, recipient: RECIPIENT, minAmountOut: 1n};

  it("an 18-dp Max amount is refused as no-route with nothing signed; the 8-dp rounding goes through", async () => {
    const log: string[] = [];
    const nativeQuote = (params: QuoteParams) => quote(params, {txRequest: {to: DIAMOND, data: "0xdeadbeef", value: params.amountIn, chainId: 1, gasLimit: "21000"}});
    const p = provider({getQuote: async (params) => (await thorLike.getQuote(params)) && nativeQuote(params)});
    await expect(protocol(p, account(log)).swap2({...eth, fromTokenAmount: 123_456_789_012_345_678n}))
      .rejects.toBeInstanceOf(Swap2QuoteError);
    expect(log).toEqual([]);
    const rounded = (123_456_789_012_345_678n / 10n ** 10n) * 10n ** 10n;
    await expect(protocol(p, account(log)).swap2({...eth, fromTokenAmount: rounded})).resolves.toBeDefined();
    expect(log).toEqual(["deposit"]);
  });

  // Was a GAP (low/UX): SingleProviderSwap2 dropped the provider's onRefusal reason.
  it("the single-provider no-route error names the 8-decimal reason", async () => {
    await expect(protocol(thorLike, account([])).swap2({...eth, fromTokenAmount: 123_456_789_012_345_678n}))
      .rejects.toThrow(/8 decimals/);
  });
});

describe("edge: build/quote mismatch", () => {
  const cases: [string, Partial<CrossChainProvider>][] = [
    ["build targets another contract", {buildDeposit: async (q) => ({...built(q), to: ATTACKER})}],
    ["build swaps the spender", {buildDeposit: async (q) => ({...built(q), approvalAddress: ATTACKER})}],
    ["build changes calldata", {buildDeposit: async (q) => ({...built(q), data: "0xbaadf00d"})}],
    ["build attaches native value", {buildDeposit: async (q) => ({...built(q), value: "1"})}],
    ["deposit address differs from the quote", {
      getQuote: async (params) => quote(params, {txRequest: undefined, depositAddress: DEPOSIT}),
      buildDeposit: async (q) => ({chain: "eip155:1", to: ATTACKER, value: q.sourceAmount}),
    }],
    ["quoted source amount differs from the request", {getQuote: async (params) => quote(params, {sourceAmount: String(BigInt(params.amountIn) + 1n)})}],
  ];
  it.each(cases)("%s → refused, nothing sent", async (_name, over) => {
    const log: string[] = [];
    let reviewed = false;
    await expect(protocol(provider(over), account(log), {reviewExecution: () => { reviewed = true; }}).swap2(options)).rejects.toThrow();
    expect([log, reviewed]).toEqual([[], false]);
  });

  // Was a GAP (high): the engine bound the build to the quote but never
  // decoded what the quote's own calldata pays. Plain ERC-20 / Permit2 /
  // operator calls are decoded now; aggregator calldata (LI.FI diamond) is not.
  const abi = parseAbi([
    "function transfer(address,uint256)", "function transferFrom(address,address,uint256)", "function approve(address,uint256)",
    "function setApprovalForAll(address,bool)",
  ]);
  const permit2 = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
  it.each([
    ["transfer to a foreign address", USDC, encodeFunctionData({abi, functionName: "transfer", args: [ATTACKER, 1_000_000n]})],
    ["transferFrom to a foreign address", USDC, encodeFunctionData({abi, functionName: "transferFrom", args: [SELF, ATTACKER, 1_000_000n]})],
    ["approve of a foreign spender", USDC, encodeFunctionData({abi, functionName: "approve", args: [ATTACKER, 1_000_000n]})],
    ["Permit2 approve of a foreign spender", "0x000000000022D473030F116dDEE9F6B43aC78BA3", encodeFunctionData({abi: permit2, functionName: "approve", args: [USDC, ATTACKER, 1_000_000n, 0]})],
    ["setApprovalForAll to a foreign operator", USDC, encodeFunctionData({abi, functionName: "setApprovalForAll", args: [ATTACKER, true]})],
  ])("a quote whose calldata does %s is refused by the engine before review", async (_name, to, data) => {
    const evil = {to, data, value: "0", chainId: 1, gasLimit: "60000"};
    const log: string[] = [];
    let reviewed = false;
    const p = provider({getQuote: async (params) => quote(params, {txRequest: evil})});
    await expect(protocol(p, account(log), {reviewExecution: () => { reviewed = true; }}).swap2(options)).rejects.toThrow(Swap2ValidationError);
    expect([log, reviewed]).toEqual([[], false]);
  });

  it("a transfer to the quoted deposit address or to the account itself passes", async () => {
    const log: string[] = [];
    const toSelf = {to: USDC, data: encodeFunctionData({abi, functionName: "transfer", args: [SELF, 1_000_000n]}), value: "0", chainId: 1, gasLimit: "60000"};
    await expect(protocol(provider({getQuote: async (params) => quote(params, {txRequest: toSelf})}), account(log)).swap2(options)).resolves.toBeDefined();
    const deposit = provider({
      getQuote: async (params) => quote(params, {txRequest: undefined, depositAddress: DEPOSIT}),
      buildDeposit: async (q) => ({chain: "eip155:1", to: DEPOSIT, value: q.sourceAmount}),
    });
    await expect(protocol(deposit, account(log)).swap2(options)).resolves.toBeDefined();
    expect(log).toEqual(["deposit", "deposit"]);
  });
});

describe("edge: native-fee ceilings", () => {
  const withFee = (fee: string, value = fee) => provider({getQuote: async (params) => quote(params, {txRequest: {...txRequest, value, nativeFee: fee}})});

  it.each([
    ["above the Ethereum cap (0.005 ETH)", "5000000000000001", "5000000000000001", /exceeds the cap/],
    ["malformed", "0x10", "0", /malformed native fee/],
  ])("a declared native fee %s is refused before review", async (_name, fee, value, error) => {
    const log: string[] = [];
    let reviewed = false;
    await expect(protocol(withFee(fee, value), account(log), {reviewExecution: () => { reviewed = true; }}).swap2(options)).rejects.toThrow(error);
    expect([log, reviewed]).toEqual([[], false]);
  });

  it("non-ETH natives have their own ceiling (Sonic: a real 21.6 S bridge fee passes, 200 S + 1 does not)", async () => {
    const onSonic = (fee: string) => {
      let plan: Swap2ExecutionPlan | undefined;
      const sonic = provider({getQuote: async (params) => quote(params, {txRequest: {...txRequest, chainId: 146, value: fee, nativeFee: fee}}), buildDeposit: async (q) => ({...built(q), chain: "eip155:146"})});
      const run = protocol(sonic, account([], {getChainId: async () => 146}), {fromChain: "eip155:146", reviewExecution: (p) => { plan = p; throw new Error("stop at review"); }}).swap2(options);
      return run.then(() => plan, (e: Error) => (plan ? plan : Promise.reject(e)));
    };
    await expect(onSonic("21604323626064016205")).resolves.toMatchObject({source: {value: 21_604_323_626_064_016_205n}});
    await expect(onSonic("200000000000000000001")).rejects.toThrow(/exceeds the cap 200000000000000000000 for eip155:146/);
  });

  it("Arc: the ceiling for the USDC gas token is 10 USDC in 18-decimal native units — never the ERC-20's 6", async () => {
    // Arc accounts for gas in 18-decimal units (docs.arc.network); only the ERC-20 interface at 0x3600… is 6-decimal.
    expect(nativeDecimals("eip155:5042")).toBe(18);
    expect(nativeDecimals("eip155:2818")).toBe(18); // unlisted chains default to 18
    expect(nativeUnits("eip155:5042", 10)).toBe(10_000_000_000_000_000_000n);
    expect(nativeUnits("eip155:5042", "0.005")).toBe(5_000_000_000_000_000n);
    expect(() => nativeUnits("eip155:5042", "1e3")).toThrow(/malformed native amount/);
    const onArc = (fee: string) => {
      let plan: Swap2ExecutionPlan | undefined;
      const arc = provider({getQuote: async (params) => quote(params, {txRequest: {...txRequest, chainId: 5042, value: fee, nativeFee: fee}}), buildDeposit: async (q) => ({...built(q), chain: "eip155:5042"})});
      const run = protocol(arc, account([], {getChainId: async () => 5042}), {fromChain: "eip155:5042", reviewExecution: (p) => { plan = p; throw new Error("stop at review"); }}).swap2(options);
      return run.then(() => plan, (e: Error) => (plan ? plan : Promise.reject(e)));
    };
    // 10 USDC in 6-decimal units (10_000_000) would be a dust fee under a 6-decimal ceiling — here it is 1e-11 USDC and passes.
    await expect(onArc("10000000")).resolves.toMatchObject({source: {value: 10_000_000n}});
    // 9.5 USDC in native (18-decimal) units passes; 10 USDC + 1 wei is refused: the cap is 10 × 10^18, not 10 × 10^6.
    await expect(onArc("9500000000000000000")).resolves.toMatchObject({source: {value: 9_500_000_000_000_000_000n}});
    await expect(onArc("10000000000000000001")).rejects.toThrow(/exceeds the cap 10000000000000000000 for eip155:5042/);
  });

  it("Mantle and Flare have whole-coin ceilings (20 MNT, 1500 FLR)", async () => {
    const on = (chainId: number, fee: string) => {
      let plan: Swap2ExecutionPlan | undefined;
      const p = provider({getQuote: async (params) => quote(params, {txRequest: {...txRequest, chainId, value: fee, nativeFee: fee}}), buildDeposit: async (q) => ({...built(q), chain: `eip155:${chainId}`})});
      // Flare's catalog stable is USDT0 (its USDC is the bridged USDC.e); Mantle has a USDC.
      const run = protocol(p, account([], {getChainId: async () => chainId}), {fromChain: `eip155:${chainId}`, reviewExecution: (pl) => { plan = pl; throw new Error("stop at review"); }}).swap2({...options, fromToken: chainId === 14 ? "USDT0" : "USDC"});
      return run.then(() => plan, (e: Error) => (plan ? plan : Promise.reject(e)));
    };
    await expect(on(5000, "20000000000000000000")).resolves.toMatchObject({source: {value: 20_000_000_000_000_000_000n}});
    await expect(on(5000, "20000000000000000001")).rejects.toThrow(/exceeds the cap 20000000000000000000 for eip155:5000/);
    await expect(on(14, "1500000000000000000000")).resolves.toMatchObject({source: {value: 1_500_000_000_000_000_000_000n}});
    await expect(on(14, "1500000000000000000001")).rejects.toThrow(/exceeds the cap 1500000000000000000000 for eip155:14/);
  });

  it("a value that differs from the declared fee is refused; an in-cap declared fee is shown in the plan", async () => {
    const log: string[] = [];
    await expect(protocol(withFee("1000", "2000"), account(log)).swap2(options)).rejects.toThrow(/does not match the quoted native fee/);
    expect(log).toEqual([]);
    let plan: Swap2ExecutionPlan | undefined;
    await protocol(withFee("5000000000000000"), account(log), {reviewExecution: (p) => { plan = p; }}).swap2(options);
    expect(plan!.source).toMatchObject({kind: "call", value: 5_000_000_000_000_000n});
    expect(log).toEqual(["approve", "deposit"]);
  });
});

describe("edge: slippage decimals", () => {
  // 0.0029 × 10 000 = 28.999…96 in floating point; a plain floor asked the
  // venue for 28 bps while the app had quoted the route list at 29.
  it("every whole-bps decimal reaches the provider as the same bps, and a quote floored at it passes", async () => {
    const seen: number[] = [];
    for (const bps of [3, 29, 48, 58, 93, 113, 249, 300]) {
      const p = provider({
        getQuote: async (params) => {
          seen.push(params.slippageBps!);
          const dest = 10n ** 18n + 7n;
          return quote(params, {destAmount: dest.toString(), minDestAmount: ((dest * BigInt(10_000 - params.slippageBps!)) / 10_000n).toString()});
        },
      });
      await protocol(p, account([])).swap2({...options, minAmountOut: 1n, slippage: bps / 10_000});
    }
    expect(seen).toEqual([3, 29, 48, 58, 93, 113, 249, 300]);
  });

  it("a decimal between whole bps still rounds down", async () => {
    let seen: number | undefined;
    const p = provider({getQuote: async (params) => { seen = params.slippageBps; return quote(params, {destAmount: "1000000", minDestAmount: "997100"}); }});
    await protocol(p, account([])).quoteSwap2({...options, slippage: 0.00295});
    expect(seen).toBe(29);
  });
});
