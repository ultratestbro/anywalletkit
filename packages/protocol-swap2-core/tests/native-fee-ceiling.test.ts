// The app's native-fee ceiling (owner decision 2026-11-13): USDT0 Legacy Mesh EVM → Tron runs through an app-set
// ceiling, not through higher engine caps. Mocked provider + account only — no network, no keys. Every refusal asserts
// that nothing was signed or sent and that the review was never reached.
//
// Fees below are the live LayerZero fees into Tron on 2026-11-12 with the usdt0 provider's +25 % headroom:
// 0.005341 ETH → 0.006676 ETH sealed (Ethereum / Arbitrum), 170.5 CELO → 213.1 CELO sealed (Celo).
import {describe, expect, it} from "vitest";
import {Swap2ConfigurationError} from "../src/errors.js";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import {NATIVE_FEE_CEILING_MAX_MULTIPLE, type Swap2EngineConfig, type Swap2ExecutionPlan, type Swap2NativeFeeCeilingContext} from "../src/swap2/base.js";
import * as root from "../src/index.js";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "../src/types.js";

const SELF = "0x4444444444444444444444444444444444444444";
const TRON_RECIPIENT = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
const ETH_OFT = "0x1F748c76dE468e9D11bd340fA9D5CBADf315dFB0";
const ARB_OFT = "0x77652D5aba086137b595875263FC200182919B92";
const CELO_OFT = "0xf10E161027410128E63E75D0200Fb6d34b2db243";
const CELO_USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e"; // Tether's USD₮ on Celo: the mesh OFT's token(), not in the catalog

const ETH_TRON_FEE = 6_676_000_000_000_000n; // 0.006676 ETH
const CELO_TRON_FEE = 213_100_000_000_000_000_000n; // 213.1 CELO
const ETHER = 10n ** 18n;

interface Source {chainId: number; eid: number; oft: string; fromToken: string; extra?: Record<string, unknown>}
const SOURCES: Record<"ethereum" | "arbitrum" | "celo", Source> = {
  ethereum: {chainId: 1, eid: 30101, oft: ETH_OFT, fromToken: "USDT"},
  arbitrum: {chainId: 42161, eid: 30110, oft: ARB_OFT, fromToken: "USDT0"},
  celo: {chainId: 42220, eid: 30125, oft: CELO_OFT, fromToken: CELO_USDT, extra: {fromTokenDecimals: 6}},
};

/** The app's policy from the docs: USDT0 Legacy Mesh into Tron (eid 30420) only. */
const TRON_MESH = new Map([["eip155:1", 10n ** 16n], ["eip155:42161", 10n ** 16n], ["eip155:42220", 300n * ETHER]]);
const tronMeshCeiling = ({provider, intentId, fromChain, destChain}: Swap2NativeFeeCeilingContext) =>
  provider === "usdt0" && destChain === "tron:728126428" && /^usdt0-mesh:\d+:30420(?:~|$)/.test(intentId)
    ? TRON_MESH.get(fromChain)
    : undefined;

interface Route {source: Source; fee: bigint; provider?: string; intentId?: string; toChain?: string; toToken?: string; recipient?: string; nativeSource?: boolean}

function quoteFor(route: Route, params: QuoteParams): Quote {
  const value = route.nativeSource ? BigInt(params.amountIn) + route.fee : route.fee;
  return {
    provider: route.provider ?? "usdt0",
    intentId: route.intentId ?? `usdt0-mesh:${route.source.eid}:30420`,
    depositAddress: "", depositMemo: null,
    txRequest: {
      to: route.source.oft, data: "0xc7c7f5b3", value: value.toString(), chainId: route.source.chainId, gasLimit: "400000",
      ...(route.nativeSource ? {} : {approvalAddress: route.source.oft}),
      nativeFee: route.fee.toString(),
    },
    sourceAmount: params.amountIn, destAmount: "9997000", minDestAmount: "9997000",
    feeUsd: 0, etaSeconds: 120, reliability: 1, validUntilMs: Date.now() + 60_000,
  };
}

function providerFor(route: Route): CrossChainProvider {
  return {
    name: route.provider ?? "usdt0", enabled: () => true, supportsRoute: () => true,
    getQuote: async (params) => quoteFor(route, params),
    buildDeposit: async (q): Promise<UnsignedTx> => {
      const {nativeFee: _fee, ...tx} = q.txRequest!;
      return {...tx, chain: `eip155:${route.source.chainId}`, to: tx.to!, value: tx.value ?? "0"};
    },
    trackIntent: async () => ({state: "pending"}),
  };
}

/** Runs swap2() and stops at the review: the plan when the engine reached it, else the refusal. */
async function run(route: Route, config: Partial<Swap2EngineConfig> = {}): Promise<{plan?: Swap2ExecutionPlan; error?: Error; sent: string[]}> {
  const sent: string[] = [];
  const account = {
    getAddress: async () => SELF,
    getChainId: async () => route.source.chainId,
    getAllowance: async () => 0n,
    sendTransaction: async (tx: {data?: string}) => { sent.push(tx.data ?? ""); return {hash: `0x${sent.length}`}; },
    waitForTransaction: async () => {},
  };
  const p = providerFor(route);
  class P extends SingleProviderSwap2 {
    protected readonly provider = p;
    protected chainSupported(): boolean { return true; }
  }
  let plan: Swap2ExecutionPlan | undefined;
  const protocol = new P(account as never, {
    fromChain: `eip155:${route.source.chainId}`,
    allowUnlistedTokens: true,
    reviewExecution: (pl) => { plan = pl; throw new Error("stop at review"); },
    ...config,
  });
  const options = {
    fromToken: route.nativeSource ? "ETH" : route.source.fromToken, fromTokenAmount: 10_000_000n, minAmountOut: 9_997_000n,
    toChain: route.toChain ?? "tron:728126428", toToken: route.toToken ?? "USDT", recipient: route.recipient ?? TRON_RECIPIENT,
    ...(route.source.extra ?? {}),
  };
  try {
    await protocol.swap2(options as never);
  } catch (e) {
    if (plan) return {plan, sent};
    return {error: e as Error, sent};
  }
  throw new Error("swap2 resolved past a throwing review");
}

/** A refusal before the review, with nothing signed. */
async function refused(route: Route, config: Partial<Swap2EngineConfig> = {}): Promise<Error> {
  const out = await run(route, config);
  expect(out.plan).toBeUndefined();
  expect(out.sent).toEqual([]);
  expect(out.error).toBeInstanceOf(Error);
  return out.error!;
}

describe("nativeFeeCeiling: no hook is today's engine", () => {
  it("USDT0 into Tron is refused with the unchanged texts (0.006676 ETH > 0.005 ETH, 213.1 CELO > 100 CELO)", async () => {
    expect((await refused({source: SOURCES.ethereum, fee: ETH_TRON_FEE})).message).toBe("swap2: quoted native fee 6676000000000000 exceeds the cap 5000000000000000 for eip155:1");
    expect((await refused({source: SOURCES.arbitrum, fee: ETH_TRON_FEE})).message).toBe("swap2: quoted native fee 6676000000000000 exceeds the cap 5000000000000000 for eip155:42161");
    expect((await refused({source: SOURCES.celo, fee: CELO_TRON_FEE})).message).toBe("swap2: quoted native fee 213100000000000000000 exceeds the cap 100000000000000000000 for eip155:42220");
  });

  it("a fee at the default cap passes, one wei above it does not", async () => {
    expect((await run({source: SOURCES.ethereum, fee: 5_000_000_000_000_000n})).plan?.source).toMatchObject({kind: "call", value: 5_000_000_000_000_000n});
    expect((await refused({source: SOURCES.ethereum, fee: 5_000_000_000_000_001n})).message).toMatch(/exceeds the cap 5000000000000000 for eip155:1$/);
  });

  it("an explicit `nativeFeeCeiling: undefined` is no hook", async () => {
    expect((await refused({source: SOURCES.ethereum, fee: ETH_TRON_FEE}, {nativeFeeCeiling: undefined} as never)).message).toMatch(/exceeds the cap 5000000000000000 for eip155:1$/);
  });
});

describe("nativeFeeCeiling: USDT0 Legacy Mesh into Tron", () => {
  it.each([
    ["Ethereum", SOURCES.ethereum, ETH_TRON_FEE],
    ["Arbitrum", SOURCES.arbitrum, ETH_TRON_FEE],
    ["Celo", SOURCES.celo, CELO_TRON_FEE],
  ] as const)("from %s the sealed fee passes and reaches the review with exactly that value", async (_name, source, fee) => {
    const out = await run({source, fee}, {nativeFeeCeiling: tronMeshCeiling});
    expect(out.error).toBeUndefined();
    expect(out.plan).toMatchObject({provider: "usdt0", destChain: "tron:728126428", source: {kind: "call", to: source.oft, value: fee}});
    expect(out.sent).toEqual([]); // stopped at the review: nothing approved, nothing sent
  });

  it("the hook sees the provider, intent id, both chains, the fee, the default cap and the hard maximum", async () => {
    const seen: Swap2NativeFeeCeilingContext[] = [];
    await run({source: SOURCES.celo, fee: CELO_TRON_FEE}, {nativeFeeCeiling: (ctx) => { seen.push(ctx); return tronMeshCeiling(ctx); }});
    expect(seen).toEqual([{
      provider: "usdt0", intentId: "usdt0-mesh:30125:30420", fromChain: "eip155:42220", destChain: "tron:728126428",
      nativeFee: CELO_TRON_FEE, defaultCap: 100n * ETHER, maxCeiling: 2000n * ETHER,
    }]);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it("Tron named by its genesis-hash id reaches the hook in the catalog form; a swap2 server's intent token still matches", async () => {
    const viaAlias = await run({source: SOURCES.ethereum, fee: ETH_TRON_FEE, toChain: "tron:0x2b6653dc"}, {nativeFeeCeiling: tronMeshCeiling});
    expect(viaAlias.plan?.destChain).toBe("tron:728126428");
    const tokened = await run({source: SOURCES.ethereum, fee: ETH_TRON_FEE, intentId: `usdt0-mesh:30101:30420~${"ab".repeat(16)}`}, {nativeFeeCeiling: tronMeshCeiling});
    expect(tokened.plan?.source).toMatchObject({value: ETH_TRON_FEE});
  });

  it("a fee above the app's ceiling is refused with the existing text and the app's ceiling in it", async () => {
    expect((await refused({source: SOURCES.ethereum, fee: 10n ** 16n + 1n}, {nativeFeeCeiling: tronMeshCeiling})).message)
      .toBe("swap2: quoted native fee 10000000000000001 exceeds the cap 10000000000000000 for eip155:1");
    expect((await refused({source: SOURCES.arbitrum, fee: 10n ** 16n + 1n}, {nativeFeeCeiling: tronMeshCeiling})).message)
      .toBe("swap2: quoted native fee 10000000000000001 exceeds the cap 10000000000000000 for eip155:42161");
    expect((await refused({source: SOURCES.celo, fee: 300n * ETHER + 1n}, {nativeFeeCeiling: tronMeshCeiling})).message)
      .toBe("swap2: quoted native fee 300000000000000000001 exceeds the cap 300000000000000000000 for eip155:42220");
    // At the app's ceiling exactly: passes.
    expect((await run({source: SOURCES.celo, fee: 300n * ETHER}, {nativeFeeCeiling: tronMeshCeiling})).plan?.source).toMatchObject({value: 300n * ETHER});
  });
});

describe("nativeFeeCeiling: every other route keeps the default cap", () => {
  const hook = {nativeFeeCeiling: tronMeshCeiling};
  const defaultRefusal = /^swap2: quoted native fee 6676000000000000 exceeds the cap 5000000000000000 for eip155:1$/;

  it("another provider into Tron, even one that copies the mesh intent id", async () => {
    expect((await refused({source: SOURCES.ethereum, fee: ETH_TRON_FEE, provider: "lifi", intentId: "lifi-0xabc"}, hook)).message).toMatch(defaultRefusal);
    expect((await refused({source: SOURCES.ethereum, fee: ETH_TRON_FEE, provider: "copycat", intentId: "usdt0-mesh:30101:30420"}, hook)).message).toMatch(defaultRefusal);
  });

  it("usdt0 into TON (eid 30343), an OFT route between two USDT0 chains, and a mesh id naming Tron on a TON destination", async () => {
    const ton = {toChain: "ton:-239", toToken: "USDT", recipient: `0:${"11".repeat(32)}`};
    expect((await refused({source: SOURCES.ethereum, fee: ETH_TRON_FEE, intentId: "usdt0-mesh:30101:30343", ...ton}, hook)).message).toMatch(defaultRefusal);
    expect((await refused({source: SOURCES.ethereum, fee: ETH_TRON_FEE, intentId: "usdt0:30101:30110", toChain: "eip155:42161", toToken: "USDT0", recipient: SELF}, hook)).message).toMatch(defaultRefusal);
    expect((await refused({source: SOURCES.ethereum, fee: ETH_TRON_FEE, intentId: "usdt0-mesh:30101:30420", ...ton}, hook)).message).toMatch(defaultRefusal);
  });

  it("a Tron mesh id with something after the eid is not the Tron route", async () => {
    expect((await refused({source: SOURCES.ethereum, fee: ETH_TRON_FEE, intentId: "usdt0-mesh:30101:304201"}, hook)).message).toMatch(defaultRefusal);
  });

  it("a source the app's table does not list falls back to the default (undefined from the hook)", async () => {
    const base = {chainId: 8453, eid: 30184, oft: ETH_OFT, fromToken: "USDC"};
    expect((await refused({source: base, fee: ETH_TRON_FEE, intentId: "usdt0-mesh:30184:30420"}, hook)).message)
      .toBe("swap2: quoted native fee 6676000000000000 exceeds the cap 5000000000000000 for eip155:8453");
  });

  it("a quote that declares no native fee never asks the hook", async () => {
    let asked = 0;
    const plain = providerFor({source: SOURCES.ethereum, fee: 0n});
    const noFee: CrossChainProvider = {...plain, getQuote: async (params) => {
      const q = quoteFor({source: SOURCES.ethereum, fee: 0n}, params);
      const {nativeFee: _fee, ...tx} = q.txRequest!;
      return {...q, txRequest: tx};
    }};
    class P extends SingleProviderSwap2 {
      protected readonly provider = noFee;
      protected chainSupported(): boolean { return true; }
    }
    let plan: Swap2ExecutionPlan | undefined;
    const protocol = new P({getAddress: async () => SELF, getChainId: async () => 1, sendTransaction: async () => ({hash: "0x1"})} as never, {
      fromChain: "eip155:1", nativeFeeCeiling: () => { asked += 1; throw new Error("must not be asked"); },
      reviewExecution: (pl) => { plan = pl; throw new Error("stop at review"); },
    });
    await expect(protocol.swap2({fromToken: "USDT", toToken: "USDT", toChain: "tron:728126428", recipient: TRON_RECIPIENT, fromTokenAmount: 10_000_000n, minAmountOut: 9_997_000n})).rejects.toThrow(/stop at review/);
    expect([asked, plan?.source]).toEqual([0, expect.objectContaining({value: 0n})]);
  });
});

describe("nativeFeeCeiling: the app may also lower the cap", () => {
  it("a lower answer refuses a fee the default would pass; 0n refuses any fee", async () => {
    expect((await refused({source: SOURCES.ethereum, fee: 4_000_000_000_000_000n}, {nativeFeeCeiling: () => 3_000_000_000_000_000n})).message)
      .toBe("swap2: quoted native fee 4000000000000000 exceeds the cap 3000000000000000 for eip155:1");
    expect((await refused({source: SOURCES.ethereum, fee: 1n}, {nativeFeeCeiling: () => 0n})).message)
      .toBe("swap2: quoted native fee 1 exceeds the cap 0 for eip155:1");
  });
});

describe("nativeFeeCeiling: native-source routes (input + fee) use the same cap", () => {
  const edge = {source: SOURCES.ethereum, fee: ETH_TRON_FEE, provider: "edge", intentId: "edge-1", nativeSource: true};
  it("refused at the default, passes when the app's hook names the route", async () => {
    expect((await refused(edge)).message).toBe("swap2: quoted native fee 6676000000000000 exceeds the cap 5000000000000000 for eip155:1");
    const out = await run(edge, {nativeFeeCeiling: ({provider}) => (provider === "edge" ? 10n ** 16n : undefined)});
    expect(out.plan?.source).toMatchObject({kind: "call", value: 10_000_000n + ETH_TRON_FEE});
  });
});

describe("nativeFeeCeiling: an answer that is not a ceiling refuses the execution", () => {
  const route = {source: SOURCES.ethereum, fee: ETH_TRON_FEE};
  const where = "usdt0 eip155:1 → tron:728126428";

  const answers: [name: string, hook: () => unknown, shown: string][] = [
    ["a number", () => 0.01, "the number 0.01"],
    ["a numeric string", () => "10000000000000000", 'the string "10000000000000000"'],
    ["null", () => null, "null"],
    ["a negative bigint", () => -1n, "-1"],
    ["an object", () => ({cap: 10n ** 16n}), "an object"],
    ["a symbol", () => Symbol("cap"), "a symbol"],
    ["Infinity", () => Infinity, "the number Infinity"],
    ["a boolean", () => true, "the boolean true"],
    ["a function", () => () => 10n ** 16n, "a function"],
    ["an object whose then getter throws", () => Object.defineProperty({}, "then", {get() { throw new Error("trap"); }}), "an object"],
  ];
  it.each(answers)("%s", async (_name, hook, shown) => {
    const error = await refused(route, {nativeFeeCeiling: hook as never});
    expect(error).toBeInstanceOf(Swap2ConfigurationError);
    expect(error.message).toBe(`swap2: nativeFeeCeiling returned ${shown} for ${where}, not a non-negative bigint or undefined — the native fee is refused`);
  });

  it("an async hook (a Promise, even of a valid ceiling) is refused, and its rejection is not left unhandled", async () => {
    const valid = await refused(route, {nativeFeeCeiling: (async () => 10n ** 16n) as never});
    expect(valid.message).toBe(`swap2: nativeFeeCeiling returned a Promise (the hook must answer synchronously) for ${where}, not a non-negative bigint or undefined — the native fee is refused`);
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", listener);
    try {
      await refused(route, {nativeFeeCeiling: (async () => { throw new Error("late"); }) as never});
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(unhandled).toEqual([]);
  });

  it("a hook that throws refuses with its reason and keeps it as the cause", async () => {
    const boom = new Error("policy table not loaded");
    const error = await refused(route, {nativeFeeCeiling: () => { throw boom; }});
    expect(error).toBeInstanceOf(Swap2ConfigurationError);
    expect(error.message).toBe(`swap2: nativeFeeCeiling threw for ${where} (policy table not loaded) — the native fee is refused`);
    expect((error as Error & {cause?: unknown}).cause).toBe(boom);
    const thrownString = await refused(route, {nativeFeeCeiling: () => { throw "nope"; }});
    expect(thrownString.message).toBe(`swap2: nativeFeeCeiling threw for ${where} (nope) — the native fee is refused`);
  });

  it("a nativeFeeCeiling that is not a function refuses (no silent fallback to the default)", async () => {
    const error = await refused(route, {nativeFeeCeiling: 10n ** 16n as never});
    expect(error).toBeInstanceOf(Swap2ConfigurationError);
    expect(error.message).toBe(`swap2: nativeFeeCeiling is 10000000000000000, not a function — the native fee of ${where} is refused`);
    // Only `undefined` means "no hook": a null left by `enabled ? hook : null` refuses too, it does not quietly drop the app's policy.
    expect((await refused(route, {nativeFeeCeiling: null as never})).message).toBe(`swap2: nativeFeeCeiling is null, not a function — the native fee of ${where} is refused`);
  });
});

describe("nativeFeeCeiling: the hard maximum (20 × the chain's default cap)", () => {
  it("is exported as 20n", () => {
    expect(NATIVE_FEE_CEILING_MAX_MULTIPLE).toBe(20n);
    expect(root.NATIVE_FEE_CEILING_MAX_MULTIPLE).toBe(20n);
  });

  it("Ethereum: 0.1 ETH is the most the hook may name; one wei more is refused even for a small fee", async () => {
    expect((await run({source: SOURCES.ethereum, fee: ETH_TRON_FEE}, {nativeFeeCeiling: () => 10n ** 17n})).plan?.source).toMatchObject({value: ETH_TRON_FEE});
    const error = await refused({source: SOURCES.ethereum, fee: ETH_TRON_FEE}, {nativeFeeCeiling: () => 10n ** 17n + 1n});
    expect(error).toBeInstanceOf(Swap2ConfigurationError);
    expect(error.message).toBe("swap2: nativeFeeCeiling returned 100000000000000001 for usdt0 eip155:1 → tron:728126428, above the hard maximum 100000000000000000 (20 × the default cap 5000000000000000) — the native fee is refused");
  });

  it("Celo: 2000 CELO is the most; a 'no limit' sentinel such as 2^256 − 1 is refused", async () => {
    expect((await run({source: SOURCES.celo, fee: CELO_TRON_FEE}, {nativeFeeCeiling: () => 2000n * ETHER})).plan?.source).toMatchObject({value: CELO_TRON_FEE});
    const error = await refused({source: SOURCES.celo, fee: CELO_TRON_FEE}, {nativeFeeCeiling: () => (1n << 256n) - 1n});
    expect(error).toBeInstanceOf(Swap2ConfigurationError);
    expect(error.message).toMatch(/above the hard maximum 2000000000000000000000 \(20 × the default cap 100000000000000000000\) — the native fee is refused$/);
  });

  it("Arbitrum (no row of its own): the 0.005 ETH default and so a 0.1 ETH maximum", async () => {
    let seen: Swap2NativeFeeCeilingContext | undefined;
    await run({source: SOURCES.arbitrum, fee: ETH_TRON_FEE}, {nativeFeeCeiling: (ctx) => { seen = ctx; return undefined; }});
    expect([seen?.defaultCap, seen?.maxCeiling]).toEqual([5_000_000_000_000_000n, 100_000_000_000_000_000n]);
  });
});
