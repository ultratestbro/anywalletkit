// Layer C: edge cases of swap2() execution. Mocked provider + account only —
// no network, no keys. Every abort asserts that nothing was signed or sent.
// Each former GAP (written first as `it.fails`) is now a passing test.
import {describe, expect, it} from "vitest";
import {encodeFunctionData, parseAbi} from "viem";
import {Swap2InFlightError, Swap2InsufficientGasError, Swap2MaybeSentError, Swap2QuoteError, Swap2ValidationError} from "../src/errors.js";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {Swap2EngineConfig, Swap2ExecutionPlan} from "../src/swap2/base.js";
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
  // The engine never re-quotes on its own: an expired quote is a hard abort and
  // the caller starts a new swap2() (which quotes afresh).
  it("expiring while the approval is being mined aborts before the deposit and revokes the allowance", async () => {
    const log: string[] = [];
    const slowMine = account(log, {waitForTransaction: () => new Promise((r) => setTimeout(r, 80))});
    const p = provider({getQuote: async (params) => quote(params, {validUntilMs: Date.now() + 40})});
    await expect(protocol(p, slowMine).swap2(options)).rejects.toThrow(/quote expired before source broadcast/);
    expect(log).toEqual(["approve", "revoke"]);
  });

  // Was a GAP (low): the post-approval expiry was a plain Error.
  it("expiry after approval is a typed Swap2QuoteError", async () => {
    const slowMine = account([], {waitForTransaction: () => new Promise((r) => setTimeout(r, 80))});
    const p = provider({getQuote: async (params) => quote(params, {validUntilMs: Date.now() + 40})});
    await expect(protocol(p, slowMine).swap2(options)).rejects.toBeInstanceOf(Swap2QuoteError);
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
