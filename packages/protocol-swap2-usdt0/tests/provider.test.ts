import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeFunctionResult, getAddress, pad, parseAbi, toFunctionSelector, toHex, type Hex} from "viem";
import {CrossChainRouter} from "@forgewallet/protocol-swap2-router";
import {usdt0Provider, USDT0_STATUS_MAP} from "../src/provider.js";
import {USDT0_CHAINS, USDT0_BY_EID} from "../src/config.js";
import {LZ_RECEIVE, USDT0_SEND} from "../src/activity.js";

const ARB = USDT0_CHAINS["eip155:42161"]!;
const ETH = USDT0_CHAINS["eip155:1"]!;
const HYPE = USDT0_CHAINS["eip155:999"]!;
const OP = USDT0_CHAINS["eip155:10"]!;
const SENDER = "0x4444444444444444444444444444444444444444";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const SRC_TX = "0x" + "ab".repeat(32);
const GUID = ("0x" + "11".repeat(32)) as Hex;
const PAYLOAD = ("0x" + "00".repeat(12) + RECIPIENT.slice(2) + "0000000000989680") as Hex; // to(32) + amountSD(8) = 10 USDT
const FEE = 6_248_183_276_938n; // live quoteSend Arbitrum → HyperEVM, 10 USDT, 2026-10-20
/** What the quote seals: FEE + 25 % headroom (the endpoint refunds the unused part). */
const SEALED = FEE + (FEE * 2_500n) / 10_000n;

const OFT_ABI = parseAbi([
  "struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; }",
  "struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }",
  "struct OFTLimit { uint256 minAmountLD; uint256 maxAmountLD; }",
  "struct OFTFeeDetail { int256 feeAmountLD; string description; }",
  "struct OFTReceipt { uint256 amountSentLD; uint256 amountReceivedLD; }",
  "struct MessagingReceipt { bytes32 guid; uint64 nonce; MessagingFee fee; }",
  "function quoteSend(SendParam s, bool payInLzToken) view returns (MessagingFee)",
  "function quoteOFT(SendParam s) view returns (OFTLimit, OFTFeeDetail[], OFTReceipt)",
  "function send(SendParam s, MessagingFee fee, address refundAddress) payable returns (MessagingReceipt, OFTReceipt)",
  "function token() view returns (address)",
  "function approvalRequired() view returns (bool)",
  "function peers(uint32 eid) view returns (bytes32)",
]);
const ENDPOINT_ABI = parseAbi([
  "struct Origin { uint32 srcEid; bytes32 sender; uint64 nonce; }",
  "function lzReceive(Origin origin, address receiver, bytes32 guid, bytes message, bytes extraData) payable",
]);

const PARAMS = {sourceChain: "eip155:42161", sourceToken: "USDT0", destChain: "eip155:999", destToken: HYPE.token, amountIn: "10000000", destAddress: RECIPIENT, refundAddress: SENDER, slippageBps: 0};

interface World {
  /** amountReceivedLD the OFT reports (default = amount). */
  received?: (amount: bigint) => bigint;
  minAmount?: bigint; maxAmount?: bigint;
  fee?: bigint; lzTokenFee?: bigint;
  feeDetails?: {feeAmountLD: bigint; description: string}[];
  token?: string; approvalRequired?: boolean; peer?: Hex | null;
  message?: unknown; scanStatus?: number;
}

/** Fake JSON-RPC (one URL per chain) + fake LayerZero Scan behind one fetch. */
function world(o: World = {}) {
  const calls: string[] = [];
  const chainOf = (url: string) => url.includes("rpc.arb") ? ARB : url.includes("rpc.eth") ? ETH : url.includes("rpc.hype") ? HYPE : OP;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.startsWith("https://scan.test")) {
      if (o.scanStatus) return new Response("", {status: o.scanStatus});
      return o.message === undefined ? new Response(JSON.stringify({message: "Message not found", code: 4040}), {status: 404}) : new Response(JSON.stringify({data: [o.message]}));
    }
    if (url.startsWith("http://rpc.")) {
      const chain = chainOf(url);
      const body = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]};
      const reply = (result: unknown) => new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, result}));
      if (body.method === "eth_chainId") return reply(toHex(chain.chainId));
      if (body.method === "eth_call") {
        const {to, data} = (body.params as [{to: string; data: Hex}])[0];
        if (to.toLowerCase() !== chain.oft.toLowerCase()) return new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, error: {code: 3, message: "execution reverted"}}));
        const {functionName, args} = decodeFunctionData({abi: OFT_ABI, data});
        const enc = (result: unknown) => reply(encodeFunctionResult({abi: OFT_ABI, functionName, result} as never));
        if (functionName === "token") return enc(o.token ?? chain.token);
        if (functionName === "approvalRequired") return enc(o.approvalRequired ?? chain.adapter);
        if (functionName === "peers") {
          const dst = USDT0_BY_EID[Number((args as [number])[0])];
          return enc(o.peer === null ? "0x" + "00".repeat(32) : o.peer ?? (dst ? pad(getAddress(dst.oft), {size: 32}) : "0x" + "00".repeat(32)));
        }
        const sp = (args as unknown as [{amountLD: bigint; minAmountLD: bigint}])[0];
        if (functionName === "quoteOFT") {
          const recv = (o.received ?? ((a: bigint) => a))(sp.amountLD);
          return enc([{minAmountLD: o.minAmount ?? 0n, maxAmountLD: o.maxAmount ?? 2n ** 64n - 1n}, o.feeDetails ?? [], {amountSentLD: sp.amountLD, amountReceivedLD: recv}]);
        }
        if (functionName === "quoteSend") return enc({nativeFee: o.fee ?? FEE, lzTokenFee: o.lzTokenFee ?? 0n});
      }
      return new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, error: {code: -32601, message: body.method}}));
    }
    return new Response("", {status: 404});
  }) as typeof fetch;
  return {fetchImpl, calls};
}

const RPC = {"eip155:42161": "http://rpc.arb", "eip155:1": "http://rpc.eth", "eip155:999": "http://rpc.hype", "eip155:10": ["http://rpc.op", "http://rpc.op2"]};
const make = (o: World = {}, cfg: Record<string, unknown> = {}) => {
  const w = world(o);
  const p = usdt0Provider({scanUrl: "https://scan.test", fetchImpl: w.fetchImpl, rpcUrls: RPC, ...cfg});
  return {...w, p};
};
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
  it("13 deployments, 6-decimal USDT0, only Ethereum is an adapter; selectors match the ABI", () => {
    expect(Object.keys(USDT0_CHAINS)).toHaveLength(13);
    expect(Object.values(USDT0_CHAINS).filter((c) => c.adapter).map((c) => c.chainId)).toEqual([1]);
    expect(new Set(Object.values(USDT0_CHAINS).map((c) => c.eid)).size).toBe(13);
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
