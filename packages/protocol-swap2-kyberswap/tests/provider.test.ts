import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, parseAbi, type Hex} from "viem";
import {describeProtocolBehaviour, describeProtocolModule} from "@anywalletkit/conformance";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import {kyberswapProvider} from "../src/provider.js";
import {KyberswapSwap2Protocol} from "../src/protocol.js";
import {KYBER_NATIVE, KYBER_ROUTER_ABI, KYBER_ROUTER_V2, KYBER_ROUTER_V3, kyberMinimum} from "../src/router.js";
import {ATTACKER, ME, RPC, USDC, WETH, ZERO, params, stub, type Stub} from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const OUT = 400_000_000_000_000_000n;
async function quote(p: Record<string, unknown>, o: Stub = {}, config: Record<string, unknown> = {rpcUrls: RPC}) {
  vi.stubGlobal("fetch", stub(o));
  const refusals: {why: string; info?: Swap2RefusalInfo}[] = [];
  const q = await kyberswapProvider(config).getQuote({...params(p), onRefusal: (why: string, info?: Swap2RefusalInfo) => refusals.push({why, ...(info ? {info} : {})})} as never);
  return {q, refusals, why: refusals.map((r) => r.why).join("; "), reason: refusals[0]?.info?.reason};
}

describe("kyberswapProvider.getQuote — dry", () => {
  it("prices with /routes only: client id header, RFQ sources excluded, no origin, no fee, no build", async () => {
    const calls: NonNullable<Stub["calls"]> = [];
    const {q} = await quote({}, {calls}, {});
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/base/api/v1/routes");
    expect(url.searchParams.get("excludeRFQSources")).toBe("true");
    expect(url.searchParams.get("tokenIn")).toBe(USDC);
    for (const k of ["origin", "feeAmount", "feeReceiver", "chargeFeeBy"]) expect(url.searchParams.has(k)).toBe(false);
    expect(calls[0]!.headers["x-client-id"]).toBe("anywalletkit");
    expect(q).toMatchObject({provider: "kyberswap", intentId: "kyberswap:8453", sourceAmount: "1000000000", destAmount: OUT.toString(), minDestAmount: kyberMinimum(OUT, 49).toString(), feeUsd: 0});
    expect(q!.txRequest).toBeUndefined();
    expect(q!.providerData?.approvalAddress).toBe(KYBER_ROUTER_V2);
  });

  it("uses the gateway with X-Api-Key when a key is set", async () => {
    const calls: NonNullable<Stub["calls"]> = [];
    await quote({}, {calls}, {apiKey: "secret"});
    expect(calls[0]!.url.startsWith("https://api.kyberswap.com/swap/base/api/v1/routes")).toBe(true);
    expect(calls[0]!.headers["x-api-key"]).toBe("secret");
  });

  it("reuses a dry route for the same request within a few seconds", async () => {
    const calls: NonNullable<Stub["calls"]> = [];
    vi.stubGlobal("fetch", stub({calls}));
    const p = kyberswapProvider({});
    await p.getQuote(params() as never);
    await p.getQuote(params() as never);
    await p.getQuote(params({amountIn: "2000000000"}) as never);
    expect(calls).toHaveLength(2);
  });

  it("asks nothing for the same token in and out, a cross-chain request, or an unserved chain", async () => {
    const calls: NonNullable<Stub["calls"]> = [];
    expect((await quote({destToken: USDC}, {calls})).why).toMatch(/same token/);
    expect((await quote({destChain: "eip155:1"}, {calls})).reason).toBe("unsupported_pair");
    expect((await quote({sourceChain: "eip155:324", destChain: "eip155:324"}, {calls})).reason).toBe("unsupported_pair");
    expect((await quote({}, {calls}, {enabledChains: [1]})).reason).toBe("unsupported_pair");
    expect(calls).toHaveLength(0);
  });

  it("refuses a route with an integrator fee, another router, router V3, other tokens or another amount", async () => {
    expect((await quote({}, {extraFee: {feeAmount: "30", feeReceiver: ATTACKER, chargeFeeBy: "currency_out", isInBps: true}})).why).toMatch(/integrator fee/);
    expect((await quote({}, {routerAddress: ATTACKER})).reason).toBe("vault_mismatch");
    expect((await quote({}, {routerAddress: KYBER_ROUTER_V3})).why).toMatch(/V3 not supported yet/);
    expect((await quote({}, {tamperSummary: (s) => ({...s, tokenOut: USDC.toLowerCase()})})).why).toMatch(/other tokens/);
    expect((await quote({}, {tamperSummary: (s) => ({...s, amountIn: "1"})})).reason).toBe("price_check_failed");
    expect((await quote({}, {tamperSummary: (s) => ({...s, amountOut: "0"})})).reason).toBe("no_route");
  });

  it("maps KyberSwap's errors to refusal reasons", async () => {
    expect((await quote({}, {error: {status: 400, code: 4008, message: "route not found"}})).reason).toBe("no_route");
    expect((await quote({}, {error: {status: 400, code: 4010}})).reason).toBe("insufficient_liquidity");
    expect((await quote({}, {error: {status: 400, code: 4011}})).reason).toBe("unsupported_pair");
    expect((await quote({}, {error: {status: 400, code: 4222}})).reason).toBe("price_check_failed");
    expect((await quote({}, {error: {status: 429}})).reason).toBe("rate_limited");
    expect((await quote({}, {error: {status: 500}})).reason).toBe("upstream_unavailable");
    expect((await quote({}, {error: {status: 404}})).reason).toBe("unsupported_pair");
  });

  it("refuses a floor above the minimum and an invalid slippage", async () => {
    expect((await quote({minAmountOut: OUT.toString()})).why).toMatch(/floor breach/);
    expect((await quote({slippageBps: 2_500})).reason).toBe("price_check_failed");
  });

  it("refuses the native coin on Arc (18-decimal USDC accounting) without asking", async () => {
    const calls: NonNullable<Stub["calls"]> = [];
    expect((await quote({sourceChain: "eip155:5042", destChain: "eip155:5042", sourceToken: "USDC", destToken: ZERO}, {calls})).why).toMatch(/native coin on Arc/);
    expect(calls).toHaveLength(0);
  });
});

describe("kyberswapProvider.getQuote — execution", () => {
  const exec = (over: Record<string, unknown> = {}) => ({dry: false, sender: ME, ...over});

  it("builds on /route/build with the untouched route, sender, recipient, slippage, deadline and source — no fee fields", async () => {
    const calls: NonNullable<Stub["calls"]> = [];
    const {q} = await quote(exec(), {calls});
    const build = calls.find((c) => c.url.includes("/route/build"))!;
    expect(build.method).toBe("POST");
    expect(Object.keys(build.body!).sort()).toEqual(["deadline", "recipient", "routeSummary", "sender", "slippageTolerance", "source"]);
    expect(build.body).toMatchObject({sender: ME, recipient: ME, slippageTolerance: 49, source: "anywalletkit"});
    expect((build.body!.routeSummary as {checksum: string}).checksum).toBe("123");
    expect(q!.txRequest).toMatchObject({to: KYBER_ROUTER_V2, value: "0", chainId: 8453, approvalAddress: KYBER_ROUTER_V2});
    expect(q!.txRequest!.gasLimit).toBeUndefined();
    expect(q!.minDestAmount).toBe(kyberMinimum(OUT, 49).toString());
    expect(q!.providerData?.sender).toBe(ME);
  });

  it("refuses the injected 30 bps fee the live endpoint accepts (KYBER-RESEARCH §3.4)", async () => {
    const {q, why, reason} = await quote(exec(), {tamper: (a) => ({...a, feeReceivers: [ATTACKER], feeAmounts: [30n], flags: 0x2c0n})});
    expect(q).toBeNull();
    expect(reason).toBe("policy_refused");
    expect(why).toMatch(/fee|flags/);
  });

  it("refuses a build paying someone else, through another executor, or under the minimum", async () => {
    expect((await quote(exec(), {tamper: (a) => ({...a, dstReceiver: ATTACKER})})).reason).toBe("recipient_mismatch");
    expect((await quote(exec(), {tamper: (a) => ({...a, callTarget: ATTACKER})})).reason).toBe("vault_mismatch");
    expect((await quote(exec(), {tamper: (a) => ({...a, minReturnAmount: a.minReturnAmount - 1n})})).reason).toBe("price_check_failed");
    expect((await quote(exec(), {tamperBuild: (b) => ({...b, routerAddress: ATTACKER})})).reason).toBe("vault_mismatch");
    expect((await quote(exec(), {tamperBuild: (b) => ({...b, amountIn: "1"})})).reason).toBe("price_check_failed");
    expect((await quote(exec(), {tamperBuild: (b) => ({...b, data: `${b.data as string}00`})})).reason).toBe("policy_refused");
  });

  it("holds the build to the caller's floor, not just the quote's minimum", async () => {
    const floor = kyberMinimum(OUT, 49) + 5n;
    // The route itself clears the floor (its minimum + 1 unit of slippage headroom is not enough) → refused at routes.
    expect((await quote(exec({minAmountOut: floor.toString()}))).why).toMatch(/floor breach/);
  });

  it("refuses an execution quote without an RPC to simulate on", async () => {
    const calls: NonNullable<Stub["calls"]> = [];
    const {reason, why} = await quote(exec(), {calls}, {});
    expect(reason).toBe("upstream_unavailable");
    expect(why).toMatch(/no RPC configured/);
    expect(calls).toHaveLength(0);
  });

  it("simulates a native-coin build with a balance override; a revert refuses it", async () => {
    const calls: NonNullable<Stub["calls"]> = [];
    const ok = await quote(exec({sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000000"}), {calls, out: 3_000_000_000n});
    expect(ok.q!.txRequest).toMatchObject({value: "1000000000000000000"});
    expect(ok.q!.txRequest!.approvalAddress).toBeUndefined();
    const sim = calls.find((c) => (c.body as {method?: string})?.method === "eth_call")!;
    expect((sim.body as {params: unknown[]}).params[2]).toHaveProperty(ME);
    const call = decodeFunctionData({abi: KYBER_ROUTER_ABI, data: ok.q!.txRequest!.data as Hex});
    expect((call.args[0] as {desc: {srcToken: string}}).desc.srcToken.toLowerCase()).toBe(KYBER_NATIVE.toLowerCase());
    expect((await quote(exec({sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000000"}), {out: 3_000_000_000n, ethCall: "revert-min"})).reason).toBe("price_check_failed");
    expect((await quote(exec({sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000000"}), {out: 3_000_000_000n, ethCall: "revert-other"})).reason).toBe("simulation_failed");
    expect((await quote(exec({sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000000"}), {out: 3_000_000_000n, ethCall: "down"})).reason).toBe("upstream_unavailable");
  });

  it("checks a token sale before any approval: approval + swap simulated in one block, a revert refuses it", async () => {
    const calls: NonNullable<Stub["calls"]> = [];
    const sims = () => calls.filter((c) => (c.body as {method?: string})?.method === "eth_simulateV1");
    const ok = await quote(exec(), {calls, allowance: 0n});
    expect(ok.q!.txRequest!.approvalAddress).toBe(KYBER_ROUTER_V2);
    expect(ok.q!.providerData!.simulated).toBe("approve+swap");
    const block = (sims()[0]!.body as {params: [{blockStateCalls: [{calls: {from: string; to: string; data: string}[]}]; validation: boolean}]}).params[0];
    expect(block.validation).toBe(false);
    const [approve, swap] = block.blockStateCalls[0].calls;
    expect(block.blockStateCalls[0].calls).toHaveLength(2);
    expect(approve!.to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(decodeFunctionData({abi: parseAbi(["function approve(address, uint256) returns (bool)"]), data: approve!.data as Hex}).args).toEqual([KYBER_ROUTER_V2, 1_000_000_000n]);
    expect(swap).toMatchObject({from: ME, to: KYBER_ROUTER_V2, data: ok.q!.txRequest!.data});
    expect((await quote(exec(), {allowance: 0n, simulate: "revert-other"})).reason).toBe("simulation_failed");
    expect((await quote(exec(), {allowance: 0n, simulate: "revert-other"})).why).toMatch(/TRANSFER_FROM_FAILED/);
    expect((await quote(exec(), {allowance: 0n, simulate: "revert-min"})).reason).toBe("price_check_failed");
  });

  it("resets a partial allowance first (USDT-style tokens), and uses a plain call when the allowance is already there", async () => {
    const calls: NonNullable<Stub["calls"]> = [];
    await quote(exec(), {calls, allowance: 5n});
    const sim = calls.find((c) => (c.body as {method?: string})?.method === "eth_simulateV1")!;
    const sent = (sim.body as {params: [{blockStateCalls: [{calls: {data: string}[]}]}]}).params[0].blockStateCalls[0].calls;
    expect(sent).toHaveLength(3);
    expect(decodeFunctionData({abi: parseAbi(["function approve(address, uint256) returns (bool)"]), data: sent[0]!.data as Hex}).args[1]).toBe(0n);
    const plain: NonNullable<Stub["calls"]> = [];
    const ok = await quote(exec(), {calls: plain});
    expect(ok.q!.providerData!.simulated).toBe("swap");
    expect(plain.some((c) => (c.body as {method?: string})?.method === "eth_simulateV1")).toBe(false);
    expect((await quote(exec(), {ethCall: "revert-other"})).reason).toBe("simulation_failed");
  });

  it("skips the check (preflight still simulates) without the input, on an RPC that cannot simulate a block, or when the approval itself fails", async () => {
    for (const o of [{balance: 1n, allowance: 0n}, {allowance: 0n, simulate: "unsupported" as const}, {allowance: 0n, simulate: "approve-fails" as const}]) {
      const r = await quote(exec(), {...o, ethCall: "revert-other"});
      expect(r.q, JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v))).not.toBeNull();
      expect(r.q!.providerData!.simulated).toBe("none");
    }
    // No RPC answers the reads at all: refused, as for native input.
    expect((await quote(exec(), {ethCall: "down"})).reason).toBe("upstream_unavailable");
  });

  it("passes KyberSwap's own USD valuation on as priceImpactBps for the value warning, never as a refusal", async () => {
    // 2026-11-25 Unichain USDC → JUP: $100.01 in, $21.76 out.
    const bad = await quote(params(), {usd: {in: "100.014793617151", out: "21.763944933921106"}});
    expect(bad.q!.providerData!.priceImpactBps).toBe("7824");
    // A gain is 0 bps; "0" is KyberSwap not pricing the token (Polygon PYUSD), not a total loss; junk is ignored.
    expect((await quote(params(), {usd: {in: "999.22", out: "999.48"}})).q!.providerData!.priceImpactBps).toBe("0");
    for (const usd of [{in: "999.76", out: "0"}, {in: "1e3", out: "5"}, {}, {in: "-1", out: "1"}]) {
      expect((await quote(params(), {usd})).q!.providerData!.priceImpactBps, JSON.stringify(usd)).toBeUndefined();
    }
  });

  it("maps a build error", async () => {
    expect((await quote(exec(), {error: {status: 400, code: 4227, onBuild: true}})).reason).toBe("simulation_failed");
    expect((await quote(exec(), {error: {status: 400, code: 4000, message: "field \"wallets\" invalid", onBuild: true}})).reason).toBe("policy_refused");
  });
});

describe("kyberswapProvider.preflightDeposit", () => {
  async function execQuote(o: Stub = {}) {
    vi.stubGlobal("fetch", stub(o));
    const p = kyberswapProvider({rpcUrls: RPC});
    const q = (await p.getQuote(params({dry: false, sender: ME}) as never))!;
    return {p, q, tx: await p.buildDeposit(q)};
  }

  it("passes the quoted transaction when the simulation succeeds", async () => {
    const {p, q, tx} = await execQuote();
    await expect(p.preflightDeposit!(q, tx)).resolves.toBeUndefined();
  });

  it("refuses another transaction than the quoted one", async () => {
    const {p, q, tx} = await execQuote();
    await expect(p.preflightDeposit!(q, {...tx, to: ATTACKER})).rejects.toThrow(/not the quoted swap/);
    await expect(p.preflightDeposit!(q, {...tx, value: "1"})).rejects.toThrow(/not the quoted swap/);
  });

  it("refuses when the simulation reverts (price or other) and when no RPC answers — fail closed", async () => {
    const {p, q, tx} = await execQuote();
    vi.stubGlobal("fetch", stub({ethCall: "revert-min"}));
    await expect(p.preflightDeposit!(q, tx)).rejects.toSatisfy((e) => refusalOf(e)?.reason === "price_check_failed");
    vi.stubGlobal("fetch", stub({ethCall: "revert-other"}));
    await expect(p.preflightDeposit!(q, tx)).rejects.toSatisfy((e) => refusalOf(e)?.reason === "simulation_failed");
    vi.stubGlobal("fetch", stub({ethCall: "down"}));
    await expect(p.preflightDeposit!(q, tx)).rejects.toSatisfy((e) => refusalOf(e)?.reason === "upstream_unavailable");
  });

  it("refuses a dry quote", async () => {
    vi.stubGlobal("fetch", stub());
    const p = kyberswapProvider({rpcUrls: RPC});
    const q = (await p.getQuote(params() as never))!;
    await expect(p.buildDeposit(q)).rejects.toThrow(/dry quote/);
    await expect(p.preflightDeposit!(q, {chain: "", to: KYBER_ROUTER_V2, value: "0", data: "0x"})).rejects.toThrow(/not an execution quote/);
  });
});

describe("kyberswapProvider routing surface", () => {
  const p = kyberswapProvider({});
  it("same-chain only, on Kyber chains, never native ↔ wrapped, own gas estimate", () => {
    expect(p.supportsSameChain).toBe(true);
    expect(p.ownGasEstimate).toBe(true);
    expect(p.supportsRoute({chain: "eip155:8453", token: "USDC"}, {chain: "eip155:8453", token: WETH})).toBe(true);
    expect(p.supportsRoute({chain: "eip155:8453", token: "ETH"}, {chain: "eip155:8453", token: WETH})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:8453", token: "WETH"}, {chain: "eip155:8453", token: ZERO})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:8453", token: "USDC"}, {chain: "eip155:1", token: WETH})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:324", token: "USDC"}, {chain: "eip155:324", token: WETH})).toBe(false);
  });

  it("tracks a swap by its receipt", async () => {
    vi.stubGlobal("fetch", stub());
    const t = kyberswapProvider({rpcUrls: RPC});
    expect(await t.trackIntent({intentId: "kyberswap:8453", sourceTxHash: "0xabc"} as never)).toEqual({state: "completed", destTxHash: "0xabc"});
    expect(await t.trackIntent({intentId: "kyberswap:8453"} as never)).toEqual({state: "pending"});
  });
});

describeProtocolModule("protocol-swap2-kyberswap", {
  type: "swap2",
  Protocol: KyberswapSwap2Protocol,
  config: {fromChain: "eip155:8453", skipAccountChainCheck: true, rpcUrls: RPC},
  samples: {getSupportedChains: []}, mustResolve: ["getSupportedChains"],
});

const kyberReceiver = (source: {kind: string; data?: string}): string[] => {
  const c = decodeFunctionData({abi: KYBER_ROUTER_ABI, data: source.data as Hex});
  return [String((c.args[0] as {desc: {dstReceiver: string}}).desc.dstReceiver)];
};
describeProtocolBehaviour("protocol-swap2-kyberswap", {
  type: "swap2",
  Protocol: KyberswapSwap2Protocol,
  config: {fromChain: "eip155:8453", rpcUrls: RPC},
  fixtures: [
    {name: "USDC → WETH (exact approve to the router, then swap)", options: {fromToken: "USDC", toToken: WETH, toChain: 8453, recipient: ME, fromTokenAmount: 1_000_000_000n, minAmountOut: 390_000_000_000_000_000n}, fetch: stub(), account: {address: ME, chain: "eip155:8453"}, own: [ME], spender: KYBER_ROUTER_V2, sourceToken: USDC, decode: kyberReceiver},
    {name: "ETH → USDC (native value, no approval)", options: {fromToken: "ETH", toToken: USDC, toChain: 8453, recipient: ME, fromTokenAmount: 10n ** 18n, minAmountOut: 2_900_000_000n}, fetch: stub({out: 3_000_000_000n}), account: {address: ME, chain: "eip155:8453"}, own: [ME], callTargets: [KYBER_ROUTER_V2], decode: kyberReceiver},
  ],
});
