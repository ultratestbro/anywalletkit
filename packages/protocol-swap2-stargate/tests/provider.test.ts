import {describe, expect, it} from "vitest";
import {decodeFunctionData, encodeFunctionData, zeroAddress} from "viem";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {validQuote} from "@anywalletkit/protocol-swap2-core/validate";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router";
import {createMockAccount} from "@anywalletkit/conformance";
import type {Swap2Operation, Swap2OperationStore} from "@anywalletkit/protocol-swap2-core";
import {STARGATE_ABI} from "../src/abi.js";
import {stargateProvider} from "../src/provider.js";
import {stargatePins} from "../src/pins.js";
import {StargateSwap2Protocol} from "../src/protocol.js";
import {actor, recipient, setup} from "./helpers/rpc.js";

function fixture(source = "eip155:56", asset = 1) {
  const f = setup(source, "eip155:42161", asset);
  const provider = stargateProvider({...f.config, enabled: true});
  const params: QuoteParams = {sourceChain: f.source.chain, sourceToken: f.source.symbol, destChain: f.destination.chain, destToken: f.destination.token, amountIn: String(f.request.amount), destAddress: recipient, refundAddress: actor, dry: false};
  return {...f, provider, params, pins: stargatePins(f.config)};
}

describe("Stargate swap2 candidates and client execution checks", () => {
  it("preserves Taxi/Bus selection and keeps unknown ETA honest", async () => {
    const f = fixture();
    const candidates = await f.provider.getQuotes!({...f.params, dry: true});
    expect(candidates.map((q) => q.routeId)).toEqual(["taxi", "bus"]);
    for (const q of candidates) {
      expect(validQuote(q, f.params, "stargate")).toBe(true);
      expect(q.etaSeconds).toBeNull();
      expect(f.pins.verifyQuote!(f.params, q)).toBeNull();
    }
    const bus = (await f.provider.getQuote({...f.params, routeId: "bus"}))!;
    expect(bus.routeId).toBe("bus");
    const tx = await f.provider.buildDeposit(bus);
    expect(decodeFunctionData({abi: STARGATE_ABI, data: tx.data as `0x${string}`})).toMatchObject({functionName: "sendToken", args: [{oftCmd: "0x00", composeMsg: "0x"}, {lzTokenFee: 0n}, actor]});
    await expect(f.provider.getQuotes!(f.params)).rejects.toThrow(/preview/);
    expect(await f.provider.getQuote({...f.params, routeId: "unknown"})).toBeNull();
    const router = new CrossChainRouter([f.provider]);
    const routes = (await router.getQuotes({...f.params, dry: true}))!;
    expect(routes.quotes).toHaveLength(2);
    expect(routes.fastest).toBeNull();
  });

  it("never silently falls back from an unavailable selected Bus to Taxi", async () => {
    const f = fixture();
    f.state.busUnavailable = true;
    expect(await f.provider.getQuote({...f.params, routeId: "bus"})).toBeNull();
    expect((await f.provider.getQuotes!({...f.params, dry: true})).map((q) => q.routeId)).toEqual(["taxi"]);
  });

  it("emits an exact ERC20 approval target but never approves a native pool", async () => {
    const token = fixture();
    expect((await token.provider.getQuote(token.params))?.txRequest?.approvalAddress).toBe(token.source.address);
    const native = fixture("eip155:8453", 13);
    const q = (await native.provider.getQuote(native.params))!;
    expect(native.source.approvalRequired).toBe(true);
    expect(q.txRequest?.approvalAddress).toBeUndefined();
    expect(BigInt(q.txRequest!.value!)).toBe(BigInt(q.sourceAmount) + BigInt(q.txRequest!.nativeFee!));
    expect(native.pins.spenders(native.source.chain)).not.toContain(native.source.address);
    await expect(native.provider.preflightDeposit!(q, await native.provider.buildDeposit(q))).resolves.toBeUndefined();
  });

  it("rechecks fees, output, pause state, peers and native-drop configuration before send", async () => {
    const f = fixture();
    const q = (await f.provider.getQuote(f.params))!, tx = await f.provider.buildDeposit(q);
    await expect(f.provider.preflightDeposit!(q, tx)).resolves.toBeUndefined();
    f.state.messagingFee = 128n; // Quoted 101 + 26 units of headroom.
    await expect(f.provider.preflightDeposit!(q, tx)).rejects.toThrow();
    f.state.messagingFee = 101n;
    f.state.feeSD = -101n;
    await expect(f.provider.preflightDeposit!(q, tx)).rejects.toThrow();
    f.state.feeSD = -100n;
    f.state.override = (r, value) => r.functionName === "status" ? 3 : value;
    await expect(f.provider.preflightDeposit!(q, tx)).rejects.toThrow();
    f.state.override = (r, value) => r.functionName === "peers" ? `0x${"00".repeat(32)}` : value;
    await expect(f.provider.preflightDeposit!(q, tx)).rejects.toThrow();
    f.state.override = undefined;
    const bus = stargateProvider({...f.config, nativeDrop: {bus: true}});
    const bq = (await bus.getQuote({...f.params, routeId: "bus"}))!;
    f.state.nativeDrop++;
    await expect(bus.preflightDeposit!(bq, await bus.buildDeposit(bq))).rejects.toThrow();
  });

  it("allows updated output within the sealed minimum without changing the transaction", async () => {
    const f = fixture();
    const q = (await f.provider.getQuote({...f.params, slippageBps: 100}))!;
    f.state.feeSD = -101n;
    f.state.messagingFee = 120n;
    expect(await f.pins.verifyBuild!(q, await f.provider.buildDeposit(q), {...f.params, slippageBps: 100})).toBeNull();
  });

  it("rejects quote changes to each caller-bound field and hidden fee/dust displays", async () => {
    const f = fixture();
    const original = (await f.provider.getQuote(f.params))!;
    const changes: ((q: Quote) => void)[] = [
      (q) => { q.routeId = "bus"; }, (q) => { q.sourceAmount = "1"; },
      (q) => { q.minDestAmount = "1"; }, (q) => { q.txRequest!.to = recipient; },
      (q) => { q.txRequest!.approvalAddress = recipient; }, (q) => { q.txRequest!.chainId = 1; },
      (q) => { q.txRequest!.value = "0"; }, (q) => { q.txRequest!.nativeFee = "0"; },
      (q) => { q.txRequest!.data += "00"; }, (q) => { q.txRequest!.gasLimit = "1"; },
      (q) => { q.providerData!.dust = "1"; }, (q) => { q.providerData!.protocolFee = "0"; },
      (q) => { q.fees = []; }, (q) => { q.validUntilMs = Date.now() - 1; },
      (q) => { q.depositAddress = recipient; }, (q) => { q.depositMemo = "memo"; },
    ];
    for (const change of changes) {
      const q = structuredClone(original); change(q);
      expect(f.pins.verifyQuote!(f.params, q)).not.toBeNull();
      await expect(f.provider.buildDeposit(q)).rejects.toThrow();
    }
    expect(f.pins.verifyQuote!({...f.params, sourceToken: "USDT"}, original)).not.toBeNull();
    expect(f.pins.verifyQuote!({...f.params, destAddress: actor}, original)).not.toBeNull();
    expect(f.pins.verifyQuote!({...f.params, refundAddress: recipient}, original)).not.toBeNull();
    const tx = await f.provider.buildDeposit(original);
    expect(await f.pins.verifyBuild!(original, {...tx, approvalAddress: zeroAddress})).not.toBeNull();
    expect(await f.pins.verifyBuild!(original, {...tx, memo: "unexpected"})).not.toBeNull();
  });

  it("refuses arbitrary compose bytes, unexpected selector and changed refund receiver", async () => {
    const f = fixture();
    const q = (await f.provider.getQuote(f.params))!;
    const decoded = decodeFunctionData({abi: STARGATE_ABI, data: q.txRequest!.data as `0x${string}`});
    if (decoded.functionName !== "sendToken") throw new Error("unexpected test setup");
    const [sp, fee, refund] = decoded.args;
    for (const data of [
      encodeFunctionData({abi: STARGATE_ABI, functionName: "sendToken", args: [{...sp, composeMsg: "0xbeef"}, fee, refund]}),
      encodeFunctionData({abi: STARGATE_ABI, functionName: "sendToken", args: [sp, fee, recipient]}),
      encodeFunctionData({abi: STARGATE_ABI, functionName: "send", args: [sp, fee, refund]}),
    ]) expect(f.pins.verifyQuote!(f.params, {...q, txRequest: {...q.txRequest, data}})).not.toBeNull();
  });

  it("requires the client's own native-drop opt-in, not a backend request", async () => {
    const f = fixture();
    const config = {...f.config, nativeDrop: {taxi: 5n}};
    const q = (await stargateProvider(config).getQuote(f.params))!;
    expect(f.pins.verifyQuote!(f.params, q)).not.toBeNull();
    expect(stargatePins(config).verifyQuote!(f.params, q)).toBeNull();
  });

  it("ships disabled, requires actors for execution, and only accepts catalog-matching symbols", async () => {
    const f = fixture();
    expect(stargateProvider(f.config).enabled()).toBe(false);
    expect(await f.provider.getQuote({...f.params, destAddress: ""})).toBeNull();
    expect(await f.provider.getQuote({...f.params, refundAddress: ""})).toBeNull();
    expect(await f.provider.getQuote({...f.params, sourceToken: "USDC.e"})).toBeNull();
    expect(await f.provider.getQuote({...f.params, sourceDecimals: 6})).toBeNull();
    expect(await f.provider.getQuote({...f.params, flex: true})).toBeNull();
    expect((await f.provider.getQuote({...f.params, destAddress: "", refundAddress: "", dry: true}))?.provider).toBe("stargate");
  });

  it("preserves unknown ETA over the sealed API and rechecks client evidence after remote preflight", async () => {
    const f = fixture();
    // Backend incorrectly skips its own preflight: the client still has to refuse stale fees.
    const handle = createSwap2Handler({providers: [{...f.provider, preflightDeposit: async () => {}}], sealSecret: "stargate-test-secret-with-at-least-32-bytes", guard: () => {}, subject: (id: string) => id});
    const fetchImpl: typeof fetch = async (url, init) => {
      const response = await handle(String(url).split("/").pop()!, JSON.parse(String(init!.body)), "alice");
      return Response.json(response.body, {status: response.status});
    };
    const client = remoteProvider({name: "stargate", baseUrl: "https://backend.test", multiQuotes: true, fetchImpl, ...f.pins});
    const candidates = await client.getQuotes!({...f.params, dry: true});
    expect(candidates).toHaveLength(2);
    expect(candidates.every((q) => q.etaSeconds === null)).toBe(true);
    const q = (await client.getQuote({...f.params, routeId: "taxi"}))!;
    const tx = await client.buildDeposit(q);
    f.state.messagingFee = 1000n;
    await expect(client.preflightDeposit!(q, tx)).rejects.toThrow(/app's own check/);
  });

  it("journals an ambiguous source send and refuses to repeat the same operation", async () => {
    const f = fixture("eip155:8453", 13);
    const account = createMockAccount({chain: f.source.chain, address: actor, balance: 10n ** 30n});
    const rows = new Map<string, Swap2Operation>();
    const store: Swap2OperationStore = {load: async (id) => rows.get(id) ?? null, compareAndSet: async (id, revision, next) => {
      if ((rows.get(id)?.revision ?? null) !== revision) return false;
      rows.set(id, structuredClone(next)); return true;
    }};
    let sends = 0;
    account.sendTransaction = async () => {
      expect(rows.get("stargate-ambiguous")?.steps.at(-1)?.state).toBe("pending");
      sends++;
      throw Object.assign(new Error("broadcast response lost"), {maybeSent: true, hash: `0x${"ab".repeat(32)}`});
    };
    const api = new StargateSwap2Protocol(account, {...f.config, fromChain: f.source.chain, enabled: true, operationStore: store});
    const options = {routeId: "taxi", operationId: "stargate-ambiguous", fromToken: "ETH", toToken: f.destination.token, toChain: f.destination.chainId, recipient, fromTokenAmount: f.request.amount, minAmountOut: 1n};
    await expect(api.swap2(options)).rejects.toMatchObject({maybeSent: true});
    expect(rows.get(options.operationId)?.steps.at(-1)?.state).toBe("unknown");
    await expect(api.swap2(options)).rejects.toThrow(/already exists/);
    expect(sends).toBe(1);
  });
});
