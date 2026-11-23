// The provider through the swap2 engine, with an account that can sign typed data: what is reviewed, what is
// signed, what is sent, and the id a placed order is tracked by. The engine reads the real clock, so does this file.
import {afterEach, describe, expect, it, vi} from "vitest";
import {hashTypedData, recoverAddress, type Hex} from "viem";
import type {Swap2ExecutionPlan} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {decodeEthFlowCall} from "../src/ethflow.js";
import {CowSwap2Protocol} from "../src/protocol.js";
import {D1, ME, RPC, USDC, WETH, signer, stub, uidOfPosted, world, type World} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

interface Signed {primaryType: string; domain: Record<string, unknown>; message: Record<string, unknown>; signature: string}
interface Sent {to: string; data?: string; value?: unknown; chainId?: number}

function harness(over: Partial<World> = {}, accountOver: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  const w = world({postAnswer: (body) => uidOfPosted(1, body), ...over});
  vi.stubGlobal("fetch", stub(w));
  const signed: Signed[] = [];
  const sent: Sent[] = [];
  const plans: Swap2ExecutionPlan[] = [];
  const account = {
    getAddress: async () => ME,
    getChainId: async () => 1,
    getBalance: async () => 10n ** 30n,
    getAllowance: async () => w.allowance,
    sendTransaction: async (tx: Sent) => {
      sent.push(tx);
      return {hash: `0x${String(sent.length).padStart(64, "0")}`};
    },
    waitForTransaction: async () => {},
    signTypedData: async (td: {domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown>}) => {
      const signature = await signer.signTypedData(td as never);
      signed.push({primaryType: td.primaryType, domain: td.domain, message: td.message, signature});
      // Every signature is over typed data the wallet can show — never over a bare digest.
      expect(await recoverAddress({hash: hashTypedData(td as never), signature: signature as Hex})).toBe(ME);
      return signature;
    },
    ...accountOver,
  };
  for (const k of Object.keys(account)) if ((account as Record<string, unknown>)[k] === undefined) delete (account as Record<string, unknown>)[k];
  const p = new CowSwap2Protocol(account as never, {fromChain: "eip155:1", enabled: true, rpcUrls: RPC, reviewExecution: async (plan) => { plans.push(plan); }, ...config});
  return {w, p, signed, sent, plans, account};
}
const swapUsdc = {fromToken: "USDC", toToken: WETH, toChain: 1, recipient: ME, fromTokenAmount: 25_000_000n, minAmountOut: 9_000n};

describe("CoW through the swap2 engine", () => {
  it("a token with a permit: two signatures, no transaction, the order tracked by its UID", async () => {
    const {w, p, signed, sent, plans} = harness();
    const result = await p.swap2(swapUsdc);
    expect(sent).toEqual([]);
    expect(signed.map((s) => s.primaryType)).toEqual(["Permit", "Order"]);
    expect(signed[0]!.domain).toMatchObject({name: "USD Coin", version: "2", verifyingContract: USDC});
    expect(signed[0]!.message).toMatchObject({owner: ME, spender: D1.vaultRelayer, value: "25000000"});
    expect(signed[1]!.domain).toMatchObject({name: "Gnosis Protocol", version: "v2", verifyingContract: D1.settlement});
    expect(signed[1]!.message).toMatchObject({sellToken: USDC, buyToken: WETH, receiver: ME, sellAmount: "25000000", feeAmount: "0", kind: "sell", partiallyFillable: false});
    // The reviewed plan names the permit instead of an approval transaction.
    expect(plans).toHaveLength(1);
    expect(plans[0]!.approvals).toEqual([]);
    expect(plans[0]!.permits).toEqual([expect.objectContaining({token: expect.stringMatching(new RegExp(USDC, "i")), spender: D1.vaultRelayer, amount: 25_000_000n})]);
    // One order posted, with the signed permit as its pre-hook; the swap's id is the order's UID.
    expect(w.posted).toHaveLength(1);
    const body = w.posted[0]!;
    expect(body.signature).toBe(signed[1]!.signature.toLowerCase());
    expect((JSON.parse(body.appData as string) as {metadata: {hooks: {pre: unknown[]}}}).metadata.hooks.pre).toHaveLength(1);
    expect(body.appDataHash).toBe(signed[1]!.message.appData);
    const uid = uidOfPosted(1, body);
    expect(decodeURIComponent(result.id)).toBe(`awk1.cow.o:1:${uid}`);
    w.orders.set(uid.toLowerCase(), {status: "open"});
    expect((await p.getSwap2Status(result.id)).status).toBe("pending");
    w.orders.set(uid.toLowerCase(), {status: "fulfilled"});
    expect((await p.getSwap2Status(result.id)).status).toBe("completed");
  });

  it("a token without a permit: one exact approval to the vault relayer, then the signed order", async () => {
    const {w, p, signed, sent, plans} = harness({permitToken: null});
    await p.swap2(swapUsdc);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(sent[0]!.data).toBe(`0x095ea7b3${D1.vaultRelayer.slice(2).toLowerCase().padStart(64, "0")}${(25_000_000n).toString(16).padStart(64, "0")}`);
    expect(signed.map((s) => s.primaryType)).toEqual(["Order"]);
    expect(plans[0]!.approvals.map((a) => [a.spender, a.amount])).toEqual([[D1.vaultRelayer, 25_000_000n]]);
    expect(plans[0]!.permits).toBeUndefined();
    expect((JSON.parse(w.posted[0]!.appData as string) as {metadata: Record<string, unknown>}).metadata.hooks).toBeUndefined();
  });

  it("an allowance that covers the order already: one signature, nothing else", async () => {
    const {p, signed, sent} = harness({allowance: 10n ** 12n});
    await p.swap2(swapUsdc);
    expect(sent).toEqual([]);
    expect(signed.map((s) => s.primaryType)).toEqual(["Order"]);
  });

  it("an account that cannot sign typed data cannot place an order — and nothing is approved for it", async () => {
    const {w, p, sent} = harness({}, {signTypedData: undefined});
    await expect(p.swap2(swapUsdc)).rejects.toThrow("swap2: a CoW order needs an account with signTypedData");
    expect(sent).toEqual([]);
    expect(w.posted).toEqual([]);
  });

  it("an orderbook that answers a worse order than quoted is refused before anything is signed", async () => {
    const {w, p, signed, sent} = harness({tamper: (a) => ((a.quote.receiver = D1.ethFlow.toLowerCase()), a)});
    await expect(p.swap2(swapUsdc)).rejects.toThrow();
    expect([signed, sent, w.posted]).toEqual([[], [], []]);
  });

  it("native in: one createOrder transaction with the input as its value, after the appData document is registered", async () => {
    const {w, p, signed, sent} = harness();
    const result = await p.swap2({fromToken: "ETH", toToken: USDC, toChain: 1, recipient: ME, fromTokenAmount: 10n ** 16n, minAmountOut: 1n});
    expect(signed).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(D1.ethFlow);
    expect(BigInt(sent[0]!.value as bigint)).toBe(10n ** 16n);
    const call = decodeEthFlowCall(sent[0]!.data!)!;
    expect(call.method).toBe("createOrder");
    expect(call.order).toMatchObject({buyToken: USDC, receiver: ME, sellAmount: "10000000000000000"});
    expect(w.appData).toHaveLength(1);
    expect(w.posted).toEqual([]);
    expect(decodeURIComponent(result.id)).toMatch(/^awk1\.cow\.e:1:[0-9a-f]{296}\.0x0{63}1$/);
  });
});

describe("cancelSwap2", () => {
  const placed = async () => {
    const h = harness({allowance: 10n ** 12n});
    const {id} = await h.p.swap2(swapUsdc);
    const uid = uidOfPosted(1, h.w.posted[0]!).toLowerCase();
    h.w.orders.set(uid, {status: "open"});
    h.signed.length = 0;
    return {...h, id, uid};
  };

  it("off-chain by default: a signed OrderCancellations for this order, handed to the orderbook", async () => {
    const {w, p, account, signed, sent, id, uid} = await placed();
    expect(await p.cancelSwap2(id, account as never)).toEqual({mode: "offchain", id});
    expect(signed.map((s) => [s.primaryType, s.message])).toEqual([["OrderCancellations", {orderUids: [uid]}]]);
    expect(w.cancelled).toEqual([{orderUids: [uid], signature: signed[0]!.signature.toLowerCase(), signingScheme: "eip712"}]);
    expect(sent).toEqual([]);
  });

  it("on-chain on request: invalidateOrder(uid) to the settlement contract, no value", async () => {
    const {w, p, account, signed, sent, id, uid} = await placed();
    const out = await p.cancelSwap2(id, account as never, {onchain: true});
    expect(out).toMatchObject({mode: "onchain", chain: "eip155:1", id});
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({to: D1.settlement, value: 0n, chainId: 1});
    expect(sent[0]!.data!.startsWith("0x15337bc0")).toBe(true);
    expect(sent[0]!.data!.toLowerCase()).toContain(uid.slice(2));
    expect([signed, w.cancelled]).toEqual([[], []]);
  });

  it("an order that settled has nothing to cancel; another account's order is not this account's to cancel", async () => {
    const {w, p, account, id, uid} = await placed();
    w.orders.set(uid, {status: "fulfilled"});
    await expect(p.cancelSwap2(id, account as never)).rejects.toThrow(/nothing to cancel/);
    w.orders.set(uid, {status: "open"});
    await expect(p.cancelSwap2(id, {...account, getAddress: async () => D1.ethFlow} as never)).rejects.toThrow(/belongs to another account/);
  });

  it("a native-coin order is cancelled by its own transaction only", async () => {
    const h = harness();
    const {id} = await h.p.swap2({fromToken: "ETH", toToken: USDC, toChain: 1, recipient: ME, fromTokenAmount: 10n ** 16n, minAmountOut: 1n});
    const order = decodeEthFlowCall(h.sent[0]!.data!)!.order;
    const {ethFlowOrderId} = await import("../src/ethflow.js");
    h.w.ethFlowOrders.set(ethFlowOrderId(D1, order).digest, {owner: ME, validTo: order.validTo});
    await expect(h.p.cancelSwap2(id, h.account as never)).rejects.toThrow(/only be cancelled by an on-chain transaction/);
    const out = await h.p.cancelSwap2(id, h.account as never, {onchain: true});
    expect(out.mode).toBe("onchain");
    expect(h.sent[1]!.to).toBe(D1.ethFlow);
    expect(decodeEthFlowCall(h.sent[1]!.data!)).toEqual({method: "invalidateOrder", order});
  });
});
