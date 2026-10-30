import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeFunctionResult, getAddress, pad, parseAbi, toFunctionSelector, toHex, type Hex} from "viem";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router";
import {usdt0Provider, USDT0_STATUS_MAP} from "../src/provider.js";
import {USDT0_CHAINS, USDT0_BY_EID} from "../src/config.js";
import {LZ_RECEIVE, USDT0_SEND} from "../src/activity.js";
import {usdt0Pins} from "../src/config.js";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider, Quote, QuoteParams, RemotePins, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {ARB, ETH, HYPE, OP, SENDER, RECIPIENT, SRC_TX, GUID, PAYLOAD, FEE, SEALED, OFT_ABI, ENDPOINT_ABI, PARAMS, world, RPC, make, type World} from "./fixtures.js";


const quoteWith = async (o: World, params: Partial<typeof PARAMS> & {flex?: boolean; minAmountOut?: string} = {}) => {
  const reasons: string[] = [];
  const {p} = make(o);
  const q = await p.getQuote({...PARAMS, ...params, onRefusal: (r) => reasons.push(r)});
  return {q, reasons};
};
const scanMessage = (status: string, extra: Record<string, unknown> = {}) => ({
  pathway: {srcEid: ARB.eid, dstEid: HYPE.eid, sender: {address: ARB.oft.toLowerCase()}, receiver: {address: HYPE.oft.toLowerCase()}, nonce: 4242},
  source: {status: "SUCCEEDED", tx: {txHash: SRC_TX, payload: PAYLOAD, options: {lzReceive: {gas: "80000", value: "0"}}}},
  destination: {status: status === "DELIVERED" ? "SUCCEEDED" : "WAITING", ...(status === "DELIVERED" ? {tx: {txHash: "0xdead"}} : {})},
  guid: GUID,
  status: {name: status, message: status},
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe("config", () => {
  it("16 deployments, 6-decimal USDT0, only Ethereum is an adapter; selectors match the ABI", () => {
    expect(Object.keys(USDT0_CHAINS)).toHaveLength(16);
    expect(Object.values(USDT0_CHAINS).filter((c) => c.adapter).map((c) => c.chainId)).toEqual([1]);
    expect(new Set(Object.values(USDT0_CHAINS).map((c) => c.eid)).size).toBe(16);
    expect(USDT0_SEND).toBe(toFunctionSelector("send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address)"));
    expect(LZ_RECEIVE).toBe(toFunctionSelector("lzReceive((uint32,bytes32,uint64),address,bytes32,bytes,bytes)"));
    expect(USDT0_STATUS_MAP.DELIVERED).toBe("completed");
    expect(USDT0_STATUS_MAP.PAYLOAD_STORED).toBe("action-required");
  });
});

describe("routes", () => {
  it("USDT/USDT0 between two deployments with a source RPC; never same chain, never other tokens, never OP's legacy USDT", () => {
    const {p} = make();
    expect(p.supportsRoute({chain: "eip155:42161", token: "USDT0"}, {chain: "eip155:999", token: HYPE.token})).toBe(true);
    expect(p.supportsRoute({chain: "eip155:42161", token: "USDT0"}, {chain: "eip155:999", token: "USDT0"})).toBe(true);
    expect(p.supportsRoute({chain: "eip155:1", token: "USDT"}, {chain: "eip155:42161", token: ARB.token})).toBe(true);
    expect(p.supportsRoute({chain: "eip155:42161", token: "USDT0"}, {chain: "eip155:999", token: "USDT"})).toBe(true); // alias, no catalog entry binding it elsewhere
    expect(p.supportsRoute({chain: "eip155:42161", token: "USDC"}, {chain: "eip155:999", token: HYPE.token})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:42161", token: "USDT0"}, {chain: "eip155:999", token: "0x0000000000000000000000000000000000000000"})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:42161", token: "USDT0"}, {chain: "eip155:42161", token: ARB.token})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:8453", token: "USDT"}, {chain: "eip155:42161", token: ARB.token})).toBe(false); // Base: no USDT0
    // OP: the catalog's "USDT" is the legacy bridged token, "USDT0" is the OFT token.
    expect(p.supportsRoute({chain: "eip155:10", token: "USDT"}, {chain: "eip155:42161", token: ARB.token})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:10", token: "USDT0"}, {chain: "eip155:42161", token: ARB.token})).toBe(true);
    expect(p.supportsRoute({chain: "eip155:10", token: OP.token}, {chain: "eip155:42161", token: ARB.token})).toBe(true);
    // A deployment without an RPC cannot be quoted from (fees come from the OFT).
    expect(p.supportsChain?.("eip155:137")).toBe(false);
    expect(p.supportsChain?.("eip155:42161")).toBe(true);
    expect(p.supportsChainPair?.("eip155:42161", "eip155:137")).toBe(true);
    expect(p.supportsChainPair?.("eip155:42161", "eip155:42161")).toBe(false);
  });
});

describe("quote", () => {
  it("Arbitrum → HyperEVM 10 USDT: quoteOFT received amount is the floor, quoteSend fee is the value, calldata binds every field, no approval", async () => {
    const {q, reasons} = await quoteWith({});
    expect(reasons).toEqual([]);
    expect(q).not.toBeNull();
    expect(q!.intentId).toBe(`usdt0:${ARB.eid}:${HYPE.eid}`);
    expect(q!.sourceAmount).toBe("10000000");
    expect(q!.destAmount).toBe("10000000");
    expect(q!.minDestAmount).toBe("10000000");
    expect(q!.txRequest).toMatchObject({to: ARB.oft, value: SEALED.toString(), nativeFee: SEALED.toString(), chainId: 42161, gasLimit: "450000"});
    expect(q!.txRequest!.approvalAddress).toBeUndefined();
    const {functionName, args} = decodeFunctionData({abi: OFT_ABI, data: q!.txRequest!.data as Hex});
    expect(functionName).toBe("send");
    expect(args).toEqual([
      {dstEid: HYPE.eid, to: pad(RECIPIENT, {size: 32}), amountLD: 10_000_000n, minAmountLD: 10_000_000n, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x"},
      {nativeFee: SEALED, lzTokenFee: 0n},
      getAddress(SENDER),
    ]);
    expect(q!.fees).toEqual([]);
    expect(q!.feeUsd).toBe(0);
    expect(q!.etaSeconds).toBe(240);
    expect(q!.providerData).toMatchObject({srcEid: "30110", dstEid: "30367", oft: ARB.oft, token: ARB.token, recipient: RECIPIENT, nativeFee: SEALED.toString(), minAmountLD: "10000000"});
  });

  it("Ethereum source: the adapter is the approval spender; Ethereum ETA is the long one", async () => {
    const {q} = await quoteWith({}, {sourceChain: "eip155:1", sourceToken: "USDT", destChain: "eip155:42161", destToken: ARB.token});
    expect(q!.txRequest).toMatchObject({to: ETH.oft, approvalAddress: ETH.oft, chainId: 1});
    expect(q!.etaSeconds).toBe(1000);
  });

  it("dust: the OFT's received amount (not the input) is the guaranteed output; nothing received → named refusal; OFT fee rows become protocol fees", async () => {
    const dusty = await quoteWith({received: (a) => a - 7n});
    expect(dusty.q!.destAmount).toBe("9999993");
    expect(dusty.q!.minDestAmount).toBe("9999993");
    expect(decodeFunctionData({abi: OFT_ABI, data: dusty.q!.txRequest!.data as Hex}).args![0]).toMatchObject({minAmountLD: 9_999_993n});
    const nothing = await quoteWith({received: () => 0n}, {amountIn: "5"});
    expect(nothing.q).toBeNull();
    expect(nothing.reasons[0]).toMatch(/dust/);
    const withFee = await quoteWith({received: (a) => a - 1000n, feeDetails: [{feeAmountLD: 1000n, description: "OFT fee"}]});
    expect(withFee.q!.fees).toEqual([{type: "protocol", amount: "1000", token: ARB.token, included: true, description: "OFT fee"}]);
    expect(withFee.q!.feeUsd).toBeCloseTo(0.001);
  });

  it("refuses: amount 0 / malformed, flex, same chain, chains without USDT0, no RPC, wrong tokens, caller floor above the output, OFT limits, LZ-token fees", async () => {
    const cases: [Partial<typeof PARAMS> & {flex?: boolean; minAmountOut?: string}, RegExp, World?][] = [
      [{amountIn: "0"}, /positive/],
      [{amountIn: "1.5"}, /integer/],
      [{flex: true}, /sealed/],
      [{destChain: "eip155:42161", destToken: ARB.token}, /same-chain/],
      [{sourceChain: "eip155:8453"}, /not deployed/],
      [{sourceChain: "eip155:137", sourceToken: "USDT", destChain: "eip155:999", destToken: HYPE.token}, /no RPC/],
      [{sourceToken: "USDC"}, /not USDT0/],
      [{destToken: "0x0000000000000000000000000000000000000000"}, /not USDT0/],
      [{minAmountOut: "10000001"}, /floor/],
      [{destAddress: "not-an-address"}, /EVM address/],
      [{}, /below the OFT minimum/, {minAmount: 20_000_000n}],
      [{}, /exceeds the OFT maximum/, {maxAmount: 5n}],
      [{}, /LZ token/, {lzTokenFee: 1n}],
    ];
    for (const [params, re, w] of cases) {
      const {q, reasons} = await quoteWith(w ?? {}, params);
      expect(q, JSON.stringify(params)).toBeNull();
      expect(reasons[0], JSON.stringify(params)).toMatch(re);
    }
    expect((await quoteWith({}, {minAmountOut: "10000000"})).q).not.toBeNull();
  });

  it("binds the addresses on-chain: a foreign token(), a wrong approval mode or a missing peer refuses the route", async () => {
    const badToken = await quoteWith({token: RECIPIENT});
    expect(badToken.q).toBeNull();
    expect(badToken.reasons[0]).toMatch(/reports token/);
    const badApproval = await quoteWith({approvalRequired: true});
    expect(badApproval.reasons[0]).toMatch(/approvalRequired=true/);
    const noPeer = await quoteWith({peer: null});
    expect(noPeer.reasons[0]).toMatch(/no peer/);
    const wrongPeer = await quoteWith({peer: pad(RECIPIENT, {size: 32})});
    expect(wrongPeer.reasons[0]).toMatch(/no peer/);
  });

  it("verifies each chain and pair once; dry quotes use placeholders; buildDeposit reproduces the sealed request", async () => {
    const {p, calls} = make();
    await p.getQuote(PARAMS);
    await p.getQuote(PARAMS);
    const rpc = calls.filter((u) => u.startsWith("http://rpc.arb"));
    // 1st quote: token + approvalRequired + peers + quoteOFT + quoteSend (5); 2nd: quoteOFT + quoteSend (2).
    expect(rpc).toHaveLength(7);
    const {refundAddress: _refund, ...noRefund} = PARAMS;
    const dry = (await p.getQuote({...noRefund, destAddress: "", dry: true}))!;
    expect(dry.providerData!.recipient).toBe("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    const tx = await p.buildDeposit(dry);
    expect(tx).toMatchObject({chain: "eip155:42161", to: ARB.oft, data: dry.txRequest!.data, value: SEALED.toString(), chainId: 42161, gasLimit: "450000"});
    expect(tx.approvalAddress).toBeUndefined();
    await expect(p.buildDeposit({...dry, intentId: "cctp:6:3:1000"})).rejects.toThrow(/no transaction request/);
  });
});

describe("preflight", () => {
  it("passes while the live fee fits the sealed value; refuses a wrong target, a higher fee, a changed value, a lost peer", async () => {
    const ok = make();
    const q = (await ok.p.getQuote(PARAMS))!;
    const tx = await ok.p.buildDeposit(q);
    await expect(ok.p.preflightDeposit!(q, tx)).resolves.toBeUndefined();
    await expect(make({fee: FEE - 1n}).p.preflightDeposit!(q, tx)).resolves.toBeUndefined();
    await expect(ok.p.preflightDeposit!(q, {...tx, to: RECIPIENT})).rejects.toThrow(/not the Arbitrum OFT/);
    // Inside the headroom the live fee may rise; past it the preflight refuses.
    await expect(make({fee: SEALED}).p.preflightDeposit!(q, tx)).resolves.toBeUndefined();
    await expect(make({fee: SEALED + 1n}).p.preflightDeposit!(q, tx)).rejects.toThrow(/fee rose/);
    await expect(ok.p.preflightDeposit!(q, {...tx, value: "1"})).rejects.toThrow(/not the quoted fee/);
    await expect(make({peer: null}).p.preflightDeposit!(q, tx)).rejects.toThrow(/no peer/);
    await expect(ok.p.preflightDeposit!({...q, providerData: {}}, tx)).rejects.toThrow(/sealed send parameters/);
  });
});

describe("track & claim", () => {
  const ref = {intentId: `usdt0:${ARB.eid}:${HYPE.eid}`, sourceTxHash: SRC_TX};

  it("pending before broadcast and before Scan indexes the hash; INFLIGHT/CONFIRMING/BLOCKED pending with the deposit seen", async () => {
    expect(await make().p.trackIntent({intentId: ref.intentId})).toEqual({state: "pending"});
    expect(await make().p.trackIntent(ref)).toEqual({state: "pending", depositReceived: false});
    for (const s of ["INFLIGHT", "CONFIRMING", "BLOCKED"]) {
      expect(await make({message: scanMessage(s)}).p.trackIntent(ref)).toEqual({state: "pending", depositReceived: true});
    }
    expect(await make({scanStatus: 503}).p.trackIntent(ref)).toEqual({state: "pending"});
    expect(await make().p.trackIntent({intentId: "usdt0:1:2", sourceTxHash: SRC_TX})).toEqual({state: "failed"});
  });

  it("DELIVERED → completed with the destination hash; FAILED-family → failed; a message of another pathway → failed", async () => {
    expect(await make({message: scanMessage("DELIVERED")}).p.trackIntent(ref)).toEqual({state: "completed", depositReceived: true, destTxHash: "0xdead"});
    for (const s of ["FAILED", "APPLICATION_BURNED", "MALFORMED_COMMAND"]) {
      expect(await make({message: scanMessage(s)}).p.trackIntent(ref)).toEqual({state: "failed", depositReceived: true});
    }
    const foreign = scanMessage("DELIVERED", {pathway: {srcEid: ETH.eid, dstEid: HYPE.eid, sender: {address: ETH.oft}, nonce: 1}});
    expect(await make({message: foreign}).p.trackIntent(ref)).toEqual({state: "failed"});
  });

  it("PAYLOAD_STORED → action-required; buildClaim is EndpointV2.lzReceive with the recorded packet on the destination", async () => {
    const stored = make({message: scanMessage("PAYLOAD_STORED")});
    expect(await stored.p.trackIntent(ref)).toEqual({state: "action-required", depositReceived: true, claim: {chain: "eip155:999", ready: true}});
    expect(await make({message: scanMessage("INFLIGHT")}).p.buildClaim!(ref)).toBeNull();
    expect(await make().p.buildClaim!(ref)).toBeNull();
    const tx = (await stored.p.buildClaim!(ref))!;
    expect(tx).toMatchObject({chain: "eip155:999", to: HYPE.endpoint, value: "0", chainId: 999, gasLimit: "300000"});
    const {functionName, args} = decodeFunctionData({abi: ENDPOINT_ABI, data: tx.data as Hex});
    expect(functionName).toBe("lzReceive");
    expect(args).toEqual([{srcEid: ARB.eid, sender: pad(ARB.oft.toLowerCase() as Hex, {size: 32}), nonce: 4242n}, getAddress(HYPE.oft), GUID, PAYLOAD, "0x"]);
    await expect(make({message: scanMessage("PAYLOAD_STORED", {guid: undefined})}).p.buildClaim!(ref)).rejects.toThrow(/no complete packet/);
    const wrongReceiver = scanMessage("PAYLOAD_STORED", {pathway: {srcEid: ARB.eid, dstEid: HYPE.eid, sender: {address: ARB.oft}, receiver: {address: RECIPIENT}, nonce: 1}});
    await expect(make({message: wrongReceiver}).p.buildClaim!(ref)).rejects.toThrow(/another receiver/);
  });
});

describe("router", () => {
  it("the dispatch snapshot forwards every USDT0 method (preflight, claim, activity, discovery)", async () => {
    const router = new CrossChainRouter([make().p]);
    const p = router.getProvider("usdt0")!;
    for (const m of ["preflightDeposit", "buildClaim", "describeActivity", "supportsChain", "supportsChainPair", "trackIntent", "buildDeposit"]) {
      expect(typeof (p as unknown as Record<string, unknown>)[m], m).toBe("function");
    }
    expect(router.supportsChainPair("eip155:42161", "eip155:999")).toBe(true);
    const best = await router.getBestQuote(PARAMS);
    expect(best?.provider).toBe("usdt0");
    expect(best?.txRequest?.nativeFee).toBe(SEALED.toString());
  });

  it("config guards", () => {
    expect(() => usdt0Provider({scanUrl: "ftp://x"})).toThrow(/http/);
    expect(() => usdt0Provider({quoteTtlMs: 0})).toThrow(/quoteTtlMs/);
    expect(usdt0Provider({enabled: false}).enabled()).toBe(false);
  });
});

describe("refusals never carry the RPC URL (scan 2026-10-23 F8)", () => {
  const KEYED = "http://rpc.arb.example/qn-SECRET-TOKEN-123/";
  const failing = (status: number) => {
    const w = world();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(KEYED)) return new Response("rate limited", {status});
      return w.fetchImpl(input, init);
    }) as typeof fetch;
    return usdt0Provider({scanUrl: "https://scan.test", fetchImpl, rpcUrls: {...RPC, "eip155:42161": KEYED}});
  };

  it("an HTTP 429 / 500 from a keyed endpoint becomes a fixed reason in getQuote", async () => {
    for (const status of [429, 500]) {
      const reasons: string[] = [];
      const q = await failing(status).getQuote({...PARAMS, onRefusal: (r) => reasons.push(r)});
      expect(q).toBeNull();
      expect(reasons.join(" ")).not.toMatch(/SECRET-TOKEN|rpc\.arb\.example|URL:/);
      expect(reasons.join(" ")).toMatch(/RPC for .* unavailable/);
    }
  });

  it("preflightDeposit throws the same fixed reason, never the URL", async () => {
    const {p} = make();
    const q = (await p.getQuote(PARAMS))!;
    const tx = await p.buildDeposit(q);
    const err = await failing(429).preflightDeposit!(q, tx).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/SECRET-TOKEN|rpc\.arb\.example/);
    expect((err as Error).message).toMatch(/RPC for .* unavailable/);
  });
});

// Audit 2026-10-25 round 3, H8: a live quote with a blank recipient or refund sent to the placeholder.
describe("USDT0 placeholders are for dry quotes only", () => {
  it("a live quote without a recipient or refund address is refused", async () => {
    const {p} = make()
    const reasons: string[] = []
    const onRefusal = (r: string) => { reasons.push(r) }
    expect(await p.getQuote({...PARAMS, dry: false, destAddress: "", onRefusal})).toBeNull()
    expect(await p.getQuote({...PARAMS, dry: false, refundAddress: "", onRefusal})).toBeNull()
    expect(reasons).toEqual(["a live quote needs a recipient", "a live quote needs a refund address"])
  })
})

// Scan 2026-10-28, F9: a remote stub's deposit-address routes now need the app's opt-in (`depositAddressRoutes`),
// which usdt0Pins do not give. The repro's deposit route is refused; the real OFT send still executes through the
// real provider behind the swap2 server handler, remoteProvider + usdt0Pins, and the engine.
describe("scan 2026-10-28 F9: USDT0 remote corridor with usdt0Pins", () => {
  const ATTACKER = "0x9999999999999999999999999999999999999999";

  /** The real provider behind the real swap2 handler, as the app's backend runs it. */
  function realBackend(provider: CrossChainProvider): typeof fetch {
    const handle = createSwap2Handler<string>({providers: [provider], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
    return (async (url: string, init: RequestInit) => {
      const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
      return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
  }

  /** The repro's backend: no txRequest, depositAddress = attacker; the build a plain send of the input to it. */
  function depositBackend(name: string, chain: string): typeof fetch {
    return (async (url: string, init: {body: string}) => {
      const action = String(url).split("/").at(-1)!;
      const body = JSON.parse(init.body) as {params?: QuoteParams; quote?: Quote};
      const reply = (v: unknown) => new Response(JSON.stringify(v), {status: 200, headers: {"content-type": "application/json"}});
      if (action === "quote") {
        const p = body.params!;
        return reply({provider: name, intentId: `i-${Math.random()}`, depositAddress: ATTACKER, depositMemo: null, sourceAmount: p.amountIn,
          destAmount: "999999999999999999999", minDestAmount: p.minAmountOut ?? "1", feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000} satisfies Quote);
      }
      if (action === "build") return reply({chain, to: ATTACKER, value: body.quote!.sourceAmount} satisfies UnsignedTx);
      return reply({});
    }) as unknown as typeof fetch;
  }

  /** The app: remoteProvider({name, baseUrl, ...pins}) under the engine, with a recording EVM account. */
  function app(name: string, pins: RemotePins, fetchImpl: typeof fetch, self: string, fromChain: string, extra: Record<string, unknown> = {}) {
    const sent: Array<{to: string; data?: string; value?: bigint}> = [];
    const account = {
      getAddress: async () => self, getChainId: async () => Number(fromChain.slice(7)), getAllowance: async () => 0n, waitForTransaction: async () => {},
      sendTransaction: async (tx: {to: string; data?: string; value?: bigint}) => { sent.push(tx); return {hash: `0x${String(sent.length).padStart(64, "0")}`}; },
    };
    const provider: CrossChainProvider = remoteProvider({name, baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, ...extra, ...pins});
    class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
    return {sent, swap2: new P(account as never, {fromChain})};
  }

  it("the repro's deposit-address route (USDT0 to the attacker) is refused before anything is sent", async () => {
    const a = app("usdt0", usdt0Pins, depositBackend("usdt0", "eip155:42161"), SENDER, "eip155:42161");
    await expect(a.swap2.swap2({fromToken: "USDT0", toToken: HYPE.token, toChain: 999, recipient: RECIPIENT, fromTokenAmount: 10_000_000n, minAmountOut: 1n} as never)).rejects.toThrow(/did not allow deposit-address routes|the quote carries no OFT call/);
    expect(a.sent).toEqual([]);
  });

  it("corridor USDT0 Arbitrum → HyperEVM: the OFT send with the quoted messaging fee as value", async () => {
    const a = app("usdt0", usdt0Pins, realBackend(make().p), SENDER, "eip155:42161");
    await a.swap2.swap2({fromToken: "USDT0", toToken: HYPE.token, toChain: 999, recipient: RECIPIENT, fromTokenAmount: 10_000_000n, minAmountOut: 10_000_000n} as never);
    expect(a.sent.map((t) => [t.to.toLowerCase(), t.value])).toEqual([[ARB.oft.toLowerCase(), SEALED]]);
  });
});
