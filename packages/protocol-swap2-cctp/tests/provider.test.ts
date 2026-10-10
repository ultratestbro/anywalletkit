import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeFunctionResult, encodeFunctionData, getAddress, pad, parseAbi, toHex, type Hex} from "viem";
import {cctpProvider} from "../src/provider.js";
import {CCTP_DOMAINS, FINALITY_FAST, FINALITY_STANDARD, MESSAGE_TRANSMITTER_V2, TOKEN_MESSENGER_V2} from "../src/config.js";

const BASE = CCTP_DOMAINS["eip155:8453"]!;
const ARB = CCTP_DOMAINS["eip155:42161"]!;
const SENDER = "0x4444444444444444444444444444444444444444";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const SRC_TX = "0x" + "ab".repeat(32);
const NONCE = ("0x" + "11".repeat(32)) as Hex;
const MESSAGE = ("0x" + "22".repeat(200)) as Hex;
const ATTESTATION = ("0x" + "33".repeat(130)) as Hex;

const MESSENGER_ABI = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
  "function getMinFeeAmount(uint256 amount) view returns (uint256)",
  "function localMessageTransmitter() view returns (address)",
]);
const TRANSMITTER_ABI = parseAbi([
  "function receiveMessage(bytes message, bytes attestation) returns (bool)",
  "function localDomain() view returns (uint32)",
  "function usedNonces(bytes32 nonce) view returns (uint256)",
]);

const PARAMS = {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: ARB.usdc, amountIn: "10000000", destAddress: RECIPIENT, refundAddress: SENDER, slippageBps: 0};

/** Fake Circle API + fake JSON-RPC behind one fetch. */
function world(o: {fees?: unknown; allowance?: number; message?: unknown; usedNonce?: bigint; minFee?: bigint; domain?: number; transmitter?: string; head?: bigint} = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.startsWith("https://iris.test")) {
      const path = url.slice("https://iris.test".length);
      if (path.startsWith("/v2/burn/USDC/fees/")) return new Response(JSON.stringify(o.fees ?? [{finalityThreshold: 1000, minimumFee: 1.3}, {finalityThreshold: 2000, minimumFee: 0}]));
      if (path.startsWith("/v2/fastBurn/USDC/allowance")) return new Response(JSON.stringify({allowance: o.allowance ?? 1_000_000}));
      if (path.startsWith("/v2/messages/")) return o.message === undefined ? new Response("", {status: 404}) : new Response(JSON.stringify({messages: [o.message]}));
      if (path.startsWith("/v2/reattest/")) return new Response(JSON.stringify({}));
      return new Response("", {status: 500});
    }
    if (url.startsWith("http://rpc.")) {
      const body = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]};
      const reply = (result: unknown) => new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, result}));
      if (body.method === "eth_chainId") return reply(url.includes("base") ? "0x2105" : "0xa4b1");
      if (body.method === "eth_blockNumber") return reply(toHex(o.head ?? 100n));
      if (body.method === "eth_call") {
        const {to, data} = (body.params as [{to: string; data: Hex}])[0];
        const abi = to.toLowerCase() === TOKEN_MESSENGER_V2.toLowerCase() ? MESSENGER_ABI : TRANSMITTER_ABI;
        const {functionName} = decodeFunctionData({abi, data});
        const result =
          functionName === "localMessageTransmitter" ? (o.transmitter ?? MESSAGE_TRANSMITTER_V2)
          : functionName === "getMinFeeAmount" ? (o.minFee ?? 1300n)
          : functionName === "localDomain" ? (o.domain ?? 6)
          : functionName === "usedNonces" ? (o.usedNonce ?? 0n)
          : 0n;
        return reply(encodeFunctionResult({abi, functionName, result} as never));
      }
      return new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, error: {code: -32601, message: body.method}}));
    }
    return new Response("", {status: 404});
  }) as typeof fetch;
  return {fetchImpl, calls};
}

const make = (o: Parameters<typeof world>[0] = {}, cfg: Record<string, unknown> = {}) => {
  const w = world(o);
  const p = cctpProvider({apiUrl: "https://iris.test", fetchImpl: w.fetchImpl, rpcUrls: {"eip155:8453": "http://rpc.base", "eip155:42161": "http://rpc.arb"}, ...cfg});
  return {...w, p};
};
const completeMessage = (extra: Record<string, unknown> = {}) => ({
  message: MESSAGE, attestation: ATTESTATION, status: "complete", cctpVersion: 2, eventNonce: "9682",
  decodedMessage: {sourceDomain: "6", destinationDomain: "3", nonce: NONCE, decodedMessageBody: {amount: "10000000", maxFee: "1430", feeExecuted: "1300", expirationBlock: "0"}},
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe("routes", () => {
  it("USDC only, native destination USDC only, never same chain, only Circle domains", () => {
    const {p} = make();
    expect(p.supportsRoute({chain: "eip155:8453", token: "USDC"}, {chain: "eip155:42161", token: ARB.usdc})).toBe(true);
    expect(p.supportsRoute({chain: "eip155:8453", token: "USDC"}, {chain: "eip155:42161", token: "USDC"})).toBe(true);
    expect(p.supportsRoute({chain: "eip155:8453", token: "USDT"}, {chain: "eip155:42161", token: ARB.usdc})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:8453", token: "USDC"}, {chain: "eip155:42161", token: "0x0000000000000000000000000000000000000000"})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:8453", token: "USDC"}, {chain: "eip155:8453", token: BASE.usdc})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:56", token: "USDC"}, {chain: "eip155:42161", token: ARB.usdc})).toBe(false);
    expect(p.supportsChain?.("eip155:1")).toBe(true);
    expect(p.supportsChain?.("solana:mainnet")).toBe(false);
    expect(p.supportsChainPair?.("eip155:1", "eip155:1")).toBe(false);
  });
});

describe("quote", () => {
  it("Fast: fee = ceil(amount × 1.3 bps) + 10 % buffer, calldata binds recipient, USDC, domain, maxFee, finality", async () => {
    const {p} = make();
    const q = await p.getQuote(PARAMS);
    expect(q).not.toBeNull();
    // 10 USDC × 1.3 bps = 1300 → +10 % = 1430
    expect(q!.minDestAmount).toBe("9998570");
    expect(q!.destAmount).toBe("9998570");
    expect(q!.sourceAmount).toBe("10000000");
    expect(q!.intentId).toBe(`cctp:6:3:${FINALITY_FAST}`);
    expect(q!.txRequest).toMatchObject({to: TOKEN_MESSENGER_V2, approvalAddress: TOKEN_MESSENGER_V2, chainId: 8453, value: "0"});
    const {functionName, args} = decodeFunctionData({abi: MESSENGER_ABI, data: q!.txRequest!.data as Hex});
    expect(functionName).toBe("depositForBurn");
    expect(args).toEqual([10_000_000n, 3, pad(RECIPIENT, {size: 32}), getAddress(BASE.usdc), "0x" + "00".repeat(32), 1430n, FINALITY_FAST]);
    expect(q!.fees).toHaveLength(1);
    expect(q!.fees![0]).toMatchObject({type: "protocol", amount: "1430", token: BASE.usdc, included: true});
    expect(q!.providerData).toMatchObject({finalityThreshold: "1000", maxFee: "1430", claimChain: "eip155:42161", claimRequired: "1"});
  });

  it("Standard is free: output = input; mode 'standard' forces it; 'auto' falls back when the Fast allowance is short", async () => {
    const std = make({}, {mode: "standard"});
    const q = await std.p.getQuote(PARAMS);
    expect(q!.minDestAmount).toBe("10000000");
    expect(q!.intentId).toBe(`cctp:6:3:${FINALITY_STANDARD}`);
    expect(q!.fees).toEqual([]);
    expect(decodeFunctionData({abi: MESSENGER_ABI, data: q!.txRequest!.data as Hex}).args![6]).toBe(FINALITY_STANDARD);
    const auto = make({allowance: 5});
    expect((await auto.p.getQuote(PARAMS))!.intentId).toBe(`cctp:6:3:${FINALITY_STANDARD}`);
    const fast = make({allowance: 5}, {mode: "fast"});
    const reasons: string[] = [];
    expect(await fast.p.getQuote({...PARAMS, onRefusal: (r) => reasons.push(r)})).toBeNull();
    expect(reasons[0]).toMatch(/allowance/);
  });

  it("refuses non-USDC, same chain, unknown domains, flex, amounts below the fee, and a caller floor above the output", async () => {
    const {p} = make();
    expect(await p.getQuote({...PARAMS, sourceToken: "USDT"})).toBeNull();
    expect(await p.getQuote({...PARAMS, destChain: "eip155:8453", destToken: BASE.usdc})).toBeNull();
    expect(await p.getQuote({...PARAMS, sourceChain: "eip155:56"})).toBeNull();
    expect(await p.getQuote({...PARAMS, flex: true})).toBeNull();
    expect(await p.getQuote({...PARAMS, amountIn: "1"})).toBeNull(); // fee 1 + buffer 1 ≥ the whole amount
    expect(await p.getQuote({...PARAMS, minAmountOut: "9999999"})).toBeNull();
    expect(await p.getQuote({...PARAMS, minAmountOut: "9998570"})).not.toBeNull();
  });

  it("dry quote uses a placeholder recipient; buildDeposit reproduces the sealed request on the source chain", async () => {
    const {p} = make();
    const q = (await p.getQuote({...PARAMS, destAddress: "", dry: true}))!;
    expect(q.providerData!.mintRecipient).toBe("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    const tx = await p.buildDeposit(q);
    expect(tx).toMatchObject({chain: "eip155:8453", to: TOKEN_MESSENGER_V2, data: q.txRequest!.data, value: "0", chainId: 8453, approvalAddress: TOKEN_MESSENGER_V2});
  });
});

describe("preflight", () => {
  it("passes against the real contracts, refuses a wrong target, a wrong domain, or an on-chain minimum fee above maxFee", async () => {
    const ok = make();
    const q = (await ok.p.getQuote(PARAMS))!;
    const tx = await ok.p.buildDeposit(q);
    await expect(ok.p.preflightDeposit!(q, tx)).resolves.toBeUndefined();
    await expect(ok.p.preflightDeposit!(q, {...tx, to: RECIPIENT})).rejects.toThrow(/not the TokenMessengerV2/);
    const wrongDomain = make({domain: 3});
    await expect(wrongDomain.p.preflightDeposit!(q, tx)).rejects.toThrow(/reports domain 3/);
    const feeUp = make({minFee: 5000n});
    await expect(feeUp.p.preflightDeposit!(q, tx)).rejects.toThrow(/minimum fee 5000 exceeds/);
    const noRpc = cctpProvider({apiUrl: "https://iris.test", fetchImpl: ok.fetchImpl});
    await expect(noRpc.preflightDeposit!(q, tx)).resolves.toBeUndefined();
  });
});

describe("track & claim (two-phase)", () => {
  const ref = {intentId: `cctp:6:3:${FINALITY_FAST}`, sourceTxHash: SRC_TX};

  it("pending before broadcast, before Circle sees it, and while confirmations accrue", async () => {
    expect(await make().p.trackIntent({intentId: ref.intentId})).toMatchObject({state: "pending", claim: {chain: "eip155:42161", ready: false}});
    expect(await make().p.trackIntent(ref)).toMatchObject({state: "pending", depositReceived: false});
    expect(await make({message: {status: "pending_confirmations", attestation: null, cctpVersion: 2}}).p.trackIntent(ref)).toMatchObject({state: "pending", depositReceived: true, claim: {ready: false}});
  });

  it("attested + not yet minted → action-required with the claim ready; minted → completed", async () => {
    expect(await make({message: completeMessage()}).p.trackIntent(ref)).toMatchObject({state: "action-required", claim: {chain: "eip155:42161", ready: true}});
    expect(await make({message: completeMessage(), usedNonce: 1n}).p.trackIntent(ref)).toMatchObject({state: "completed"});
    // Without a destination RPC the recorded claim hash is the evidence.
    const noRpc = world({message: completeMessage()});
    const p = cctpProvider({apiUrl: "https://iris.test", fetchImpl: noRpc.fetchImpl});
    expect(await p.trackIntent({...ref, destTxHash: "0xdead"})).toMatchObject({state: "completed", destTxHash: "0xdead"});
    expect(await p.trackIntent(ref)).toMatchObject({state: "action-required"});
  });

  it("buildClaim: null while pending; receiveMessage(message, attestation) on the destination once attested", async () => {
    expect(await make({message: {status: "pending_confirmations", attestation: null}}).p.buildClaim!(ref)).toBeNull();
    const tx = await make({message: completeMessage()}).p.buildClaim!(ref);
    expect(tx).toMatchObject({chain: "eip155:42161", to: MESSAGE_TRANSMITTER_V2, value: "0", chainId: 42161});
    const {functionName, args} = decodeFunctionData({abi: TRANSMITTER_ABI, data: tx!.data as Hex});
    expect(functionName).toBe("receiveMessage");
    expect(args).toEqual([MESSAGE, ATTESTATION]);
    expect(tx!.data).toBe(encodeFunctionData({abi: TRANSMITTER_ABI, functionName: "receiveMessage", args: [MESSAGE, ATTESTATION]}));
  });

  it("refuses an attestation for another route; an expired Fast message is re-attested and not claimable yet", async () => {
    await expect(make({message: completeMessage({decodedMessage: {sourceDomain: "6", destinationDomain: "7", nonce: NONCE}})}).p.buildClaim!(ref)).rejects.toThrow(/another destination domain/);
    const expired = make({message: completeMessage({decodedMessage: {sourceDomain: "6", destinationDomain: "3", nonce: NONCE, decodedMessageBody: {expirationBlock: "50"}}}), head: 60n});
    expect(await expired.p.buildClaim!(ref)).toBeNull();
    expect(expired.calls.some((u) => u.includes("/v2/reattest/"))).toBe(true);
    const alive = make({message: completeMessage({decodedMessage: {sourceDomain: "6", destinationDomain: "3", nonce: NONCE, decodedMessageBody: {expirationBlock: "500"}}}), head: 60n});
    expect(await alive.p.buildClaim!(ref)).not.toBeNull();
  });
});
