// SDK-318: fee caps on a native-coin input. The engine keys a native source by its catalog asset id
// (`nep141:eth.omft.near`, or "" where 1Click lists no native coin), while providers itemize the native coin as the zero
// address (Relay, Across), "native" (0x, Jupiter) or 0xEeee…EEeE: under any maxNetworkFeeBps / maxProtocolFeeBps every
// honest native-coin quote was refused ("cannot apply … fee cap across different fee tokens"). Only a native source
// takes those spellings as itself; an ERC-20 source keeps the exact (case-insensitive) address match, and a fee in any
// other token is still refused. Mocked provider and account only — no network, no keys.
import {describe, expect, it} from "vitest";
import {Swap2FeeLimitError} from "../src/errors.js";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {Swap2EngineConfig, Swap2ExecutionPlan} from "../src/swap2/base.js";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "../src/types.js";

type Fee = NonNullable<Quote["fees"]>[number];
type Caps = Pick<Swap2EngineConfig, "maxNetworkFeeBps" | "maxProtocolFeeBps">;

const SELF = "0x4444444444444444444444444444444444444444";
const SPOKE = "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64"; // an Across SpokePool-shaped call target
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EEEE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const USDC_ETHEREUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH_ETHEREUM = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const UNLISTED = "0x1111111111111111111111111111111111111112";
const ONE_ETH = 10n ** 18n;
const CAP_BPS = 10;
/** 10 bps of 1 ETH: a fee of exactly this passes, one wei more does not. */
const AT_CAP = ONE_ETH / 1000n;

interface Source {chain: string; fromToken: string; amount: bigint; native: boolean; extra?: Record<string, unknown>; config?: Partial<Swap2EngineConfig>}
const ETH: Source = {chain: "eip155:1", fromToken: "ETH", amount: ONE_ETH, native: true};
const BASE_ETH: Source = {chain: "eip155:8453", fromToken: "ETH", amount: ONE_ETH, native: true};
/** Unichain: the catalog has no 1Click asset id for its ETH (""), the engine's key for the source was the empty string. */
const UNICHAIN_ETH: Source = {chain: "eip155:130", fromToken: "ETH", amount: ONE_ETH, native: true};
const SOL: Source = {chain: "solana:mainnet", fromToken: "SOL", amount: ONE_ETH, native: true};
const USDC: Source = {chain: "eip155:1", fromToken: "USDC", amount: ONE_ETH, native: false};
const UNLISTED_TOKEN: Source = {chain: "eip155:1", fromToken: UNLISTED, amount: ONE_ETH, native: false, extra: {fromTokenDecimals: 18}, config: {allowUnlistedTokens: true}};

const fee = (type: Fee["type"], token: string, amount: bigint, description?: string): Fee =>
  ({type, amount: amount.toString(), token, included: true, ...(description ? {description} : {})});

function chainIdOf(chain: string): number | undefined {
  return chain.startsWith("eip155:") ? Number(chain.slice("eip155:".length)) : undefined;
}

function quoteFor(source: Source, fees: Fee[], params: QuoteParams): Quote {
  const chainId = chainIdOf(source.chain);
  return {
    provider: "edge", intentId: "edge-1", depositAddress: "", depositMemo: null,
    ...(chainId !== undefined ? {txRequest: {
      to: SPOKE, data: "0xad5425c6", value: source.native ? params.amountIn : "0", chainId, gasLimit: "200000",
      ...(source.native ? {} : {approvalAddress: SPOKE}),
    }} : {}),
    sourceAmount: params.amountIn, destAmount: "990000000000000000", minDestAmount: "990000000000000000",
    feeUsd: 0, etaSeconds: 2, reliability: 1, validUntilMs: Date.now() + 60_000, fees,
  };
}

function providerFor(source: Source, fees: Fee[]): CrossChainProvider {
  return {
    name: "edge", enabled: () => true, supportsRoute: () => true,
    getQuote: async (params) => quoteFor(source, fees, params),
    buildDeposit: async (q): Promise<UnsignedTx> => ({...q.txRequest!, chain: source.chain, to: q.txRequest!.to!, value: q.txRequest!.value ?? "0"}),
    trackIntent: async () => ({state: "pending"}),
  };
}

function protocolFor(source: Source, fees: Fee[], config: Partial<Swap2EngineConfig>, account: object = {getAddress: async () => SELF}, p = providerFor(source, fees)) {
  class P extends SingleProviderSwap2 {
    protected readonly provider = p;
    protected chainSupported(): boolean { return true; }
  }
  return new P(account as never, {fromChain: source.chain, ...source.config, ...config});
}

const optionsFor = (source: Source) => ({
  fromToken: source.fromToken, fromTokenAmount: source.amount, minAmountOut: 980_000_000_000_000_000n,
  toChain: source.chain === "eip155:8453" ? 42161 : 8453, toToken: "ETH", recipient: SELF, ...source.extra,
});

/** quoteSwap2 under the caps: the quote's fees, or the refusal. */
async function quoted(source: Source, fees: Fee[], caps: Caps): Promise<{fees?: readonly unknown[]; error?: Error}> {
  try {
    return {fees: (await protocolFor(source, fees, caps).quoteSwap2(optionsFor(source) as never)).fees};
  } catch (e) {
    return {error: e as Error};
  }
}

async function refusal(source: Source, fees: Fee[], caps: Caps): Promise<Swap2FeeLimitError> {
  const out = await quoted(source, fees, caps);
  expect(out.fees).toBeUndefined();
  expect(out.error).toBeInstanceOf(Swap2FeeLimitError);
  expect((out.error as Swap2FeeLimitError).reason).toBe("policy_refused");
  return out.error as Swap2FeeLimitError;
}

const TYPES = [["protocol", {maxProtocolFeeBps: CAP_BPS}], ["network", {maxNetworkFeeBps: CAP_BPS}]] as const;

describe("a native-coin input: the providers' native spellings count as the input (SDK-318)", () => {
  it.each([
    ["Relay / Across: the zero address", ZERO_ADDRESS],
    ["0x / Jupiter: \"native\"", "native"],
    ["0xEeee…EEeE", EEEE],
    ["0xEeee…EEeE in lowercase", EEEE.toLowerCase()],
    ["\"NATIVE\" in capitals", "NATIVE"],
    ["the catalog's asset id, as before", "nep141:eth.omft.near"],
  ])("%s: at the cap passes and keeps the provider's spelling, one wei over is refused as over the cap", async (_name, token) => {
    for (const [type, caps] of TYPES) {
      const passed = await quoted(ETH, [fee(type, token, AT_CAP)], caps);
      expect(passed.error).toBeUndefined();
      expect(passed.fees).toEqual([{type, amount: AT_CAP, token, included: true}]);
      expect((await refusal(ETH, [fee(type, token, AT_CAP + 1n)], caps)).message).toBe(`swap2: ${type} fee exceeds configured cap`);
    }
  });

  it("a Relay-shaped quote (one included protocol fee in the lowercase zero address) under and over maxProtocolFeeBps", async () => {
    const caps = {maxProtocolFeeBps: CAP_BPS};
    expect((await quoted(BASE_ETH, [fee("protocol", ZERO_ADDRESS, 300_000_000_000_000n, "Relay fee")], caps)).fees).toHaveLength(1);
    expect((await refusal(BASE_ETH, [fee("protocol", ZERO_ADDRESS, 2_000_000_000_000_000n, "Relay fee")], caps)).message)
      .toBe("swap2: protocol fee exceeds configured cap");
  });

  it("fees in different native spellings add up as one token", async () => {
    const caps = {maxProtocolFeeBps: CAP_BPS};
    const split = (a: bigint, b: bigint) => [fee("protocol", ZERO_ADDRESS, a), fee("protocol", "native", b), fee("network", EEEE, 5n * AT_CAP)];
    expect((await quoted(ETH, split(AT_CAP / 2n, AT_CAP / 2n), caps)).fees).toHaveLength(3);
    expect((await refusal(ETH, split(AT_CAP / 2n, AT_CAP / 2n + 1n), caps)).message).toBe("swap2: protocol fee exceeds configured cap");
  });

  it("on a chain whose native coin has no catalog asset id (Unichain) the spellings count as well", async () => {
    for (const [type, caps] of TYPES) {
      for (const token of [ZERO_ADDRESS, "native", EEEE]) {
        expect((await quoted(UNICHAIN_ETH, [fee(type, token, AT_CAP)], caps)).fees).toHaveLength(1);
        expect((await refusal(UNICHAIN_ETH, [fee(type, token, AT_CAP + 1n)], caps)).message).toBe(`swap2: ${type} fee exceeds configured cap`);
      }
    }
  });

  it("a Solana SOL input: Jupiter's \"native\" network fee counts; the EVM spellings are another token there", async () => {
    const caps = {maxNetworkFeeBps: CAP_BPS};
    expect((await quoted(SOL, [{...fee("network", "native", 5_000n, "Solana base fee"), included: false}], caps)).fees).toHaveLength(1);
    expect((await refusal(SOL, [fee("network", "native", AT_CAP + 1n)], caps)).message).toBe("swap2: network fee exceeds configured cap");
    for (const token of [ZERO_ADDRESS, EEEE]) {
      expect((await refusal(SOL, [fee("network", token, 5_000n)], caps)).message).toBe("swap2: cannot apply network fee cap across different fee tokens");
    }
  });
});

describe("the check is not weakened (SDK-318)", () => {
  it("an ERC-20 input: a fee called native, in the zero address or in 0xEeee…EEeE is another token", async () => {
    for (const [type, caps] of TYPES) {
      for (const token of [ZERO_ADDRESS, "native", EEEE, "nep141:eth.omft.near"]) {
        expect((await refusal(USDC, [fee(type, token, 1n)], caps)).message).toBe(`swap2: cannot apply ${type} fee cap across different fee tokens`);
      }
    }
  });

  it("an ERC-20 input: a fee in its own contract, in any case, is capped exactly as before", async () => {
    for (const [type, caps] of TYPES) {
      for (const token of [USDC_ETHEREUM, USDC_ETHEREUM.toLowerCase()]) {
        expect((await quoted(USDC, [fee(type, token, AT_CAP)], caps)).fees).toHaveLength(1);
        expect((await refusal(USDC, [fee(type, token, AT_CAP + 1n)], caps)).message).toBe(`swap2: ${type} fee exceeds configured cap`);
      }
    }
  });

  it("an unlisted ERC-20 input (allowUnlistedTokens) takes no native spelling either", async () => {
    const caps = {maxProtocolFeeBps: CAP_BPS};
    expect((await quoted(UNLISTED_TOKEN, [fee("protocol", UNLISTED, AT_CAP)], caps)).fees).toHaveLength(1);
    for (const token of [ZERO_ADDRESS, "native", EEEE]) {
      expect((await refusal(UNLISTED_TOKEN, [fee("protocol", token, 1n)], caps)).message).toBe("swap2: cannot apply protocol fee cap across different fee tokens");
    }
  });

  it("a native input: a fee in an ERC-20, a bare symbol, another chain's native id or Chainflip's chain:asset is another token", async () => {
    for (const [type, caps] of TYPES) {
      for (const token of [USDC_ETHEREUM, WETH_ETHEREUM, "ETH", "nep141:base.omft.near", "Ethereum:ETH"]) {
        expect((await refusal(ETH, [fee(type, token, 1n)], caps)).message).toBe(`swap2: cannot apply ${type} fee cap across different fee tokens`);
      }
    }
  });

  it("a native input: one native fee next to one in another token is still refused", async () => {
    const caps = {maxProtocolFeeBps: CAP_BPS};
    expect((await refusal(ETH, [fee("protocol", ZERO_ADDRESS, 1n), fee("protocol", WETH_ETHEREUM, 1n)], caps)).message)
      .toBe("swap2: cannot apply protocol fee cap across different fee tokens");
  });

  it("a quote without an itemized breakdown is still refused under a cap", async () => {
    const unitemized: CrossChainProvider = {...providerFor(ETH, []), getQuote: async (params) => {
      const {fees: _none, ...q} = quoteFor(ETH, [], params);
      return q;
    }};
    const e = await protocolFor(ETH, [], {maxProtocolFeeBps: CAP_BPS}, undefined, unitemized).quoteSwap2(optionsFor(ETH) as never).then(() => null, (x: Error) => x);
    expect(e).toBeInstanceOf(Swap2FeeLimitError);
    expect(e?.message).toBe("swap2: fee caps require an itemized provider fee breakdown");
  });
});

describe("swap2(): an Across-shaped native quote under maxProtocolFeeBps (SDK-318)", () => {
  /** Across's native quote: exactly one included protocol fee, input − output, in the zero address. */
  const across = (amount: bigint) => [fee("protocol", ZERO_ADDRESS, amount, "Across relayer and LP fee")];

  /** swap2() from Base ETH, stopped at the review: the reviewed plan, or the refusal; and what was sent. */
  async function run(fees: Fee[], engine: Partial<Swap2EngineConfig>, call?: Caps): Promise<{plan?: Swap2ExecutionPlan; error?: Error; sent: unknown[]}> {
    const sent: unknown[] = [];
    let plan: Swap2ExecutionPlan | undefined;
    const account = {
      getAddress: async () => SELF, getChainId: async () => 8453, getAllowance: async () => 0n,
      sendTransaction: async (tx: unknown) => { sent.push(tx); return {hash: "0x1"}; },
      waitForTransaction: async () => {},
    };
    const protocol = protocolFor(BASE_ETH, fees, {...engine, reviewExecution: (pl) => { plan = pl; throw new Error("stop at review"); }}, account);
    try {
      await protocol.swap2(optionsFor(BASE_ETH) as never, call);
    } catch (e) {
      return plan ? {plan, sent} : {error: e as Error, sent};
    }
    throw new Error("swap2 resolved past a throwing review");
  }

  it("under the cap (engine config or the call's config) the swap reaches the review with exactly the input as value", async () => {
    for (const [engine, call] of [[{maxProtocolFeeBps: CAP_BPS}, undefined], [{}, {maxProtocolFeeBps: CAP_BPS}]] as const) {
      const out = await run(across(AT_CAP), engine, call);
      expect(out.error).toBeUndefined();
      expect(out.plan).toMatchObject({provider: "edge", source: {kind: "call", to: SPOKE, value: ONE_ETH}});
      expect(out.sent).toEqual([]);
    }
  });

  it("over the cap it is refused before the review, with nothing signed or sent", async () => {
    for (const [engine, call] of [[{maxProtocolFeeBps: CAP_BPS}, undefined], [{}, {maxProtocolFeeBps: CAP_BPS}]] as const) {
      const out = await run(across(AT_CAP + 1n), engine, call);
      expect(out.plan).toBeUndefined();
      expect(out.sent).toEqual([]);
      expect(out.error).toBeInstanceOf(Swap2FeeLimitError);
      expect(out.error?.message).toBe("swap2: protocol fee exceeds configured cap");
      expect((out.error as Swap2FeeLimitError).reason).toBe("policy_refused");
    }
  });
});
