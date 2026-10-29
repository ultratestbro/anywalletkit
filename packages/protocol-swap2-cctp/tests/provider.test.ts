import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeFunctionData, getAddress, pad, type Hex} from "viem";
import {cctpClaimTargets, cctpProvider} from "../src/provider.js";
import {MESSENGER_ABI, TRANSMITTER_ABI, make, world} from "./fixtures.js";
import {CCTP_BY_DOMAIN, CCTP_DOMAINS, FINALITY_FAST, FINALITY_STANDARD, MESSAGE_TRANSMITTER_V2, TOKEN_MESSENGER_V2} from "../src/config.js";

const BASE = CCTP_DOMAINS["eip155:8453"]!;
const ARB = CCTP_DOMAINS["eip155:42161"]!;
const SENDER = "0x4444444444444444444444444444444444444444";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const SRC_TX = "0x" + "ab".repeat(32);
const NONCE = ("0x" + "11".repeat(32)) as Hex;
const MESSAGE = ("0x" + "22".repeat(200)) as Hex;
const ATTESTATION = ("0x" + "33".repeat(130)) as Hex;

const PARAMS = {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: ARB.usdc, amountIn: "10000000", destAddress: RECIPIENT, refundAddress: SENDER, slippageBps: 0};

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

describe("domain table", () => {
  it("every domain and chain is listed once, and every EVM entry uses the shared V2 contracts", () => {
    const all = Object.values(CCTP_DOMAINS);
    expect(new Set(all.map((x) => x.domain)).size).toBe(all.length);
    expect(new Set(all.map((x) => x.chainId)).size).toBe(all.length);
    for (const x of all) {
      expect(x.caip2).toBe(`eip155:${x.chainId}`);
      expect(x.usdc).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect([x.tokenMessenger, x.messageTransmitter]).toEqual([TOKEN_MESSENGER_V2, MESSAGE_TRANSMITTER_V2]);
      expect(CCTP_BY_DOMAIN[x.domain]).toBe(x);
    }
  });

  it.each([
    ["eip155:5042", 5042, 26, "Arc", "0x3600000000000000000000000000000000000000"],
    ["eip155:2818", 2818, 30, "Morph", "0xCfb1186F4e93D60E60a8bDd997427D1F33bc372B"],
  ])("%s is domain %i (%s), 2026-10-14", (caip2, chainId, domain, name, usdc) => {
    expect(CCTP_DOMAINS[caip2]).toMatchObject({chainId, domain, name, usdc});
    expect(CCTP_BY_DOMAIN[domain]!.caip2).toBe(caip2);
    const {p} = make();
    expect(p.supportsChain?.(caip2)).toBe(true);
    expect(p.supportsRoute({chain: caip2, token: "USDC"}, {chain: "eip155:8453", token: BASE.usdc})).toBe(true);
    expect(p.supportsRoute({chain: "eip155:8453", token: "USDC"}, {chain: caip2, token: usdc})).toBe(true);
    expect(p.supportsRoute({chain: "eip155:8453", token: "USDC"}, {chain: caip2, token: "0x0000000000000000000000000000000000000000"})).toBe(false);
  });

  it("Arc ↔ Morph routes both ways; Mantle, Katana and Flare (no Circle-native USDC) do not", () => {
    const {p} = make();
    expect(p.supportsRoute({chain: "eip155:5042", token: "USDC"}, {chain: "eip155:2818", token: CCTP_DOMAINS["eip155:2818"]!.usdc})).toBe(true);
    expect(p.supportsRoute({chain: "eip155:2818", token: "USDC"}, {chain: "eip155:5042", token: CCTP_DOMAINS["eip155:5042"]!.usdc})).toBe(true);
    for (const c of ["eip155:5000", "eip155:747474", "eip155:14"]) {
      expect(p.supportsChain?.(c)).toBe(false);
      expect(p.supportsRoute({chain: c, token: "USDC"}, {chain: "eip155:8453", token: BASE.usdc})).toBe(false);
    }
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
  it("passes against the real contracts, refuses a wrong target, a wrong domain, or a Circle fee above maxFee", async () => {
    const ok = make();
    const q = (await ok.p.getQuote(PARAMS))!;
    const tx = await ok.p.buildDeposit(q);
    await expect(ok.p.preflightDeposit!(q, tx)).resolves.toBeUndefined();
    await expect(ok.p.preflightDeposit!(q, {...tx, to: RECIPIENT})).rejects.toThrow(/not the TokenMessengerV2/);
    const wrongDomain = make({domain: 3});
    await expect(wrongDomain.p.preflightDeposit!(q, tx)).rejects.toThrow(/reports domain 3/);
    // Quoted at 1.3 bps + 10 % buffer (1430 on 10 USDC): a bump inside the buffer passes, above it refuses.
    expect(q.providerData!.maxFee).toBe("1430");
    await expect(make({fees: [{finalityThreshold: 1000, minimumFee: 1.43}]}).p.preflightDeposit!(q, tx)).resolves.toBeUndefined();
    await expect(make({fees: [{finalityThreshold: 1000, minimumFee: 5}]}).p.preflightDeposit!(q, tx)).rejects.toThrow(/fee 5000 \(5 bps\) exceeds the quoted maxFee 1430/);
    await expect(make({fees: [{finalityThreshold: 2000, minimumFee: 0}]}).p.preflightDeposit!(q, tx)).rejects.toThrow(/no longer publishes a Fast/);
    // The fee check needs no RPC; the contract checks do.
    const noRpc = cctpProvider({apiUrl: "https://iris.test", fetchImpl: make({fees: [{finalityThreshold: 1000, minimumFee: 5}]}).fetchImpl});
    await expect(noRpc.preflightDeposit!(q, tx)).rejects.toThrow(/exceeds the quoted maxFee/);
    await expect(cctpProvider({apiUrl: "https://iris.test", fetchImpl: ok.fetchImpl}).preflightDeposit!(q, tx)).resolves.toBeUndefined();
    // Standard pays no fee: no Iris fee read at preflight.
    const std = make({}, {mode: "standard"});
    const qs = (await std.p.getQuote(PARAMS))!;
    std.calls.length = 0;
    await expect(std.p.preflightDeposit!(qs, await std.p.buildDeposit(qs))).resolves.toBeUndefined();
    expect(std.calls.some((u) => u.includes("/fees/"))).toBe(false);
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

  it("declares its MessageTransmitter as the only claim target (round 3, M24)", () => {
    expect(cctpClaimTargets("eip155:42161")).toEqual([MESSAGE_TRANSMITTER_V2]);
    expect(make({message: completeMessage()}).p.claimTargets!("eip155:42161")).toEqual([MESSAGE_TRANSMITTER_V2]);
    expect(cctpClaimTargets("eip155:999999")).toEqual([]);
    expect(cctpClaimTargets("__proto__")).toEqual([]);
  });

  it("refuses an attestation for another route; an expired Fast message is re-attested and not claimable yet", async () => {
    await expect(make({message: completeMessage({decodedMessage: {sourceDomain: "6", destinationDomain: "7", nonce: NONCE}})}).p.buildClaim!(ref)).rejects.toThrow(/another destination domain/);
    const expired = make({message: completeMessage({decodedMessage: {sourceDomain: "6", destinationDomain: "3", nonce: NONCE, decodedMessageBody: {expirationBlock: "50"}}}), head: 60n});
    expect(await expired.p.buildClaim!(ref)).toBeNull();
    expect(expired.calls.some((u) => u.includes("/v2/reattest/"))).toBe(true);
    const alive = make({message: completeMessage({decodedMessage: {sourceDomain: "6", destinationDomain: "3", nonce: NONCE, decodedMessageBody: {expirationBlock: "500"}}}), head: 60n});
    // Arbitrum-stack destination: `block.number` is the L1 height the RPC block exposes as l1BlockNumber — the L2 height is far above the expiry.
    const arbitrum = make({message: completeMessage({decodedMessage: {sourceDomain: "6", destinationDomain: "3", nonce: NONCE, decodedMessageBody: {expirationBlock: "26208525"}}}), head: 400_000_000n, l1Head: 23_900_000n});
    expect(await arbitrum.p.buildClaim!(ref)).not.toBeNull();
    expect(arbitrum.calls.some((u) => u.includes("/v2/reattest/"))).toBe(false);
    expect(await alive.p.buildClaim!(ref)).not.toBeNull();
  });
});

// Audit 2026-10-25 round 3, H8: a live quote with a blank recipient minted to the placeholder (vitalik.eth).
describe("CCTP placeholder is for dry quotes only", () => {
  it("a live quote without a recipient is refused; a dry one is still priced", async () => {
    const {p} = make()
    const reasons: string[] = []
    expect(await p.getQuote({...PARAMS, dry: false, destAddress: "", onRefusal: (r: string) => { reasons.push(r) }})).toBeNull()
    expect(reasons).toEqual(["a live quote needs a recipient"])
    expect(await p.getQuote({...PARAMS, dry: true, destAddress: ""})).not.toBeNull()
  })
})
