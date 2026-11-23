// What becomes of an order: status from the orderbook and from the contracts, the eth-flow refund, and both ways
// to cancel.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, parseAbi} from "viem";
import {assertGpv2Cancellation} from "@anywalletkit/protocol-swap2-core";
import {decodeEthFlowCall, ethFlowOrderId, ETH_FLOW_INVALIDATED_OWNER, ETH_FLOW_INVALIDATE_SELECTOR, type EthFlowData} from "../src/ethflow.js";
import {orderUid} from "../src/order.js";
import {parseCowIntent} from "../src/provider.js";
import {D1, ME, NOW, OTHER, ethToUsdc, other, setup, signTyped} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const UID = orderUid(`0x${"11".repeat(32)}`, ME, NOW + 1200).toLowerCase();
const ID = `o:1:${UID}`;
const TX = `0x${"ab".repeat(32)}`;
const MAX = (1n << 256n) - 1n;
type Over = Parameters<typeof setup>[0];
const listed = (order: Record<string, unknown>, uid = UID): Over => ({orders: new Map([[uid, order]])});

describe("status of a signed order", () => {
  const status = async (over: Over, pass = 0, config: Parameters<typeof setup>[1] = {}) => {
    const s = setup(over, config);
    s.t.pass(pass);
    const out = await s.p.trackIntent({intentId: ID} as never);
    vi.unstubAllGlobals();
    return out;
  };

  it("follows the orderbook: open, filled (with the settlement's hash), cancelled, expired", async () => {
    expect(await status(listed({status: "open"}))).toEqual({state: "pending"});
    expect(await status(listed({status: "presignaturePending"}))).toEqual({state: "pending"});
    expect(await status({...listed({status: "fulfilled"}), trades: new Map([[UID, [{txHash: TX.toUpperCase().replace("0X", "0x")}]]])})).toEqual({state: "completed", destTxHash: TX});
    expect(await status(listed({status: "fulfilled"}))).toEqual({state: "completed"});
    expect(await status({...listed({status: "fulfilled"}), trades: new Map([[UID, [{txHash: "not a hash"}]]])})).toEqual({state: "completed"});
    expect(await status(listed({status: "cancelled"}))).toEqual({state: "cancelled"});
    expect(await status(listed({status: "expired"}))).toEqual({state: "expired"});
  });

  it("an order that traded before it was cancelled or expired is a completed swap", async () => {
    expect(await status(listed({status: "cancelled", executedBuyAmount: "5"}))).toEqual({state: "completed"});
    expect(await status(listed({status: "expired", executedBuyAmount: "5"}))).toEqual({state: "completed"});
    expect(await status(listed({status: "expired", executedBuyAmount: "0"}))).toEqual({state: "expired"});
    expect(await status(listed({status: "cancelled", executedBuyAmount: "-5"}))).toEqual({state: "cancelled"});
  });

  it("an order the orderbook does not list is pending until a minute past its expiry", async () => {
    expect(await status({})).toEqual({state: "pending"});
    expect(await status({}, 1260)).toEqual({state: "pending"});
    expect(await status({}, 1261)).toEqual({state: "expired"});
  });

  it("with the orderbook down the settlement contract answers; with both down it stays pending", async () => {
    expect(await status({apiDown: true})).toEqual({state: "pending"});
    expect(await status({apiDown: true}, 1201)).toEqual({state: "expired"});
    expect(await status({apiDown: true, filled: new Map([[UID, 25_000_000n]])})).toEqual({state: "completed"});
    expect(await status({apiDown: true, filled: new Map([[UID, MAX]])})).toEqual({state: "cancelled"});
    expect(await status({apiDown: true, rpcDown: true}, 5000)).toEqual({state: "pending"});
    expect(await status({apiDown: true}, 5000, {rpcUrls: {}})).toEqual({state: "pending"});
  });

  it("a quote, a foreign id or an unknown chain is simply pending", async () => {
    const {p} = setup();
    for (const intentId of ["q:1:1-abc", "lifi:1", `o:100:${UID}`]) expect(await p.trackIntent({intentId} as never)).toEqual({state: "pending"});
  });
});

describe("status and refund of an eth-flow order", () => {
  /** A quoted eth-flow order in a world of its own; `ids` are the contract's digest and the orderbook's UID. */
  const flow = async (over: Over = {}, config: Parameters<typeof setup>[1] = {}) => {
    const s = setup(over, config);
    const q = (await s.quote(ethToUsdc()))!;
    const data = (parseCowIntent(q.intentId) as {data: EthFlowData}).data;
    const {digest, uid} = ethFlowOrderId(D1, data);
    const ref = (sourceTxHash?: string) => ({intentId: q.intentId, ...(sourceTxHash ? {sourceTxHash} : {})}) as never;
    const live = () => s.w.ethFlowOrders.set(digest, {owner: ME, validTo: data.validTo});
    const refunded = () => s.w.ethFlowOrders.set(digest, {owner: ETH_FLOW_INVALIDATED_OWNER, validTo: 0});
    const list = (order: Record<string, unknown>) => s.w.orders.set(uid.toLowerCase(), order);
    return {...s, q, data, digest, uid: uid.toLowerCase(), ref, live, refunded, list};
  };
  const claim = {chain: "eip155:1", ready: true};
  const refundTx = (data: EthFlowData) => expect.objectContaining({chain: "eip155:1", to: D1.ethFlow, value: "0", chainId: 1, gasLimit: "120000"});

  it("listed and open: the coin is in, the order trades", async () => {
    const f = await flow();
    f.live();
    f.list({status: "open"});
    expect(await f.p.trackIntent(f.ref())).toEqual({state: "pending", depositReceived: true});
    expect(await f.p.buildClaim!(f.ref())).toBeNull();
  });

  it("filled: completed with the settlement's hash, nothing to refund", async () => {
    const f = await flow();
    f.live();
    f.list({status: "fulfilled"});
    f.w.trades.set(f.uid, [{txHash: TX}]);
    expect(await f.p.trackIntent(f.ref())).toEqual({state: "completed", destTxHash: TX});
    f.w.filled.set(f.uid, 10n ** 16n);
    expect(await f.p.buildClaim!(f.ref())).toBeNull();
    expect(await f.p.buildCancel!(f.ref(), {owner: ME, onchain: true})).toBeNull();
    // A partial execution reported on an expired order is a completed swap too.
    f.list({status: "expired", executedBuyAmount: "7"});
    expect(await f.p.trackIntent(f.ref())).toMatchObject({state: "completed"});
  });

  it("refunded: by the orderbook's word or by the contract's", async () => {
    const f = await flow();
    f.live();
    f.list({status: "expired", ethflowData: {refundTxHash: TX}});
    expect(await f.p.trackIntent(f.ref())).toEqual({state: "refunded"});
    f.list({status: "expired", ethflowData: {refundTxHash: null}});
    f.refunded();
    f.t.pass(1201);
    expect(await f.p.trackIntent(f.ref())).toEqual({state: "refunded"});
    expect(await f.p.buildClaim!(f.ref())).toBeNull();
    expect(await f.p.buildCancel!(f.ref(), {owner: ME, onchain: true})).toBeNull();
  });

  it("expired unfilled: CoW's refunder gets ten minutes, then the refund is the user's to take", async () => {
    const f = await flow();
    f.live();
    f.list({status: "expired"});
    f.t.pass(1201);
    expect(await f.p.trackIntent(f.ref())).toEqual({state: "refund-pending"});
    f.t.pass(600);
    expect(await f.p.trackIntent(f.ref())).toEqual({state: "action-required", claim});
    const tx = (await f.p.buildClaim!(f.ref()))!;
    expect(tx).toEqual(refundTx(f.data));
    expect(tx.data!.slice(0, 10)).toBe(ETH_FLOW_INVALIDATE_SELECTOR);
    expect(decodeEthFlowCall(tx.data!)).toEqual({method: "invalidateOrder", order: f.data});
    expect(f.p.claimTargets!("eip155:1")).toContain(tx.to);
  });

  it("an order the orderbook refused never trades: the refund is offered at once", async () => {
    const f = await flow();
    f.live();
    f.list({status: "open", onchainOrderData: {sender: ME, placementError: "QuoteNotFound"}});
    expect(await f.p.trackIntent(f.ref())).toEqual({state: "action-required", claim});
    // The contract only lets it go after the expiry — unless the caller is its creator, which the user is.
    expect(await f.p.buildClaim!(f.ref())).toEqual(refundTx(f.data));
  });

  it("not listed: the contract decides — not mined, failed, live, filled, refunded", async () => {
    const f = await flow();
    expect(await f.p.trackIntent(f.ref(TX))).toEqual({state: "pending"});
    f.w.receipts.set(TX, {status: "0x0"});
    expect(await f.p.trackIntent(f.ref(TX))).toEqual({state: "failed"});
    f.w.receipts.set(TX, {status: "0x1"});
    expect(await f.p.trackIntent(f.ref(TX))).toEqual({state: "pending"});
    f.live();
    expect(await f.p.trackIntent(f.ref(TX))).toEqual({state: "pending", depositReceived: true});
    expect(await f.p.buildClaim!(f.ref(TX))).toBeNull();
    f.w.filled.set(f.uid, 1n);
    expect(await f.p.trackIntent(f.ref(TX))).toEqual({state: "completed"});
    f.w.filled.clear();
    f.t.pass(1201);
    expect(await f.p.trackIntent(f.ref(TX))).toEqual({state: "refund-pending"});
    expect(await f.p.buildClaim!(f.ref(TX))).toEqual(refundTx(f.data));
    f.t.pass(600);
    expect(await f.p.trackIntent(f.ref(TX))).toEqual({state: "action-required", claim});
    f.refunded();
    expect(await f.p.trackIntent(f.ref(TX))).toEqual({state: "refunded"});
    vi.unstubAllGlobals();
    // Never placed and long past: expired, nothing to claim.
    const never = await flow();
    never.t.pass(1801);
    expect(await never.p.trackIntent(never.ref())).toEqual({state: "expired"});
    expect(await never.p.buildClaim!(never.ref())).toBeNull();
  });

  it("without a readable chain a sent transaction is never called expired: the refund stays on offer", async () => {
    const f = await flow({}, {rpcUrls: {}});
    expect(await f.p.trackIntent(f.ref(TX))).toEqual({state: "pending"});
    f.t.pass(1801);
    expect(await f.p.trackIntent(f.ref(TX))).toEqual({state: "action-required", claim});
    expect(await f.p.trackIntent(f.ref())).toEqual({state: "expired"});
    expect(await f.p.buildClaim!(f.ref(TX))).toEqual(refundTx(f.data));
    // Orderbook down as well: still pending by status, and the refund is still built after the expiry.
    f.w.apiDown = true;
    expect(await f.p.trackIntent(f.ref(TX))).toEqual({state: "pending"});
    expect(await f.p.buildClaim!(f.ref(TX))).toEqual(refundTx(f.data));
  });

  it("only eth-flow orders have a claim", async () => {
    const {p} = setup();
    expect(await p.buildClaim!({intentId: ID} as never)).toBeNull();
    expect(await p.buildClaim!({intentId: "q:1:1-a"} as never)).toBeNull();
    expect(await p.buildClaim!({intentId: "nope"} as never)).toBeNull();
    expect(p.claimTargets!("eip155:100")).toEqual([]);
    expect(p.claimTargets!("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toEqual([]);
  });

  it("cancel before the expiry is the same call, by the creator only", async () => {
    const f = await flow();
    f.live();
    const tx = (await f.p.buildCancel!(f.ref(), {owner: ME, onchain: true}))!;
    expect(decodeEthFlowCall(tx.data!)).toEqual({method: "invalidateOrder", order: f.data});
    expect(f.p.cancelTargets!("eip155:1")).toContain(tx.to);
    await expect(f.p.buildCancel!(f.ref(), {owner: OTHER, onchain: true})).rejects.toThrow("cow: this order was placed by another account — only that account can cancel it before it expires");
    // Once expired anyone may trigger the refund — it still pays the creator.
    f.t.pass(1201);
    expect(await f.p.buildCancel!(f.ref(), {owner: OTHER, onchain: true})).not.toBeNull();
    vi.unstubAllGlobals();
    const unplaced = await flow();
    expect(await unplaced.p.buildCancel!(unplaced.ref(), {owner: ME, onchain: true})).toBeNull();
  });
});

describe("cancelling a signed order", () => {
  const INVALIDATE = parseAbi(["function invalidateOrder(bytes orderUid)"]);

  it("on-chain: GPv2Settlement.invalidateOrder(uid), value 0, to the pinned settlement", async () => {
    const {p} = setup(listed({status: "open"}));
    const tx = (await p.buildCancel!({intentId: ID} as never, {owner: ME, onchain: true}))!;
    expect(tx).toEqual({chain: "eip155:1", to: D1.settlement, value: "0", chainId: 1, gasLimit: "80000", data: expect.stringMatching(/^0x15337bc0/)});
    expect(decodeFunctionData({abi: INVALIDATE, data: tx.data as `0x${string}`}).args).toEqual([UID]);
    expect(p.cancelTargets!("eip155:1")).toContain(tx.to);
  });

  it("on-chain works with the orderbook down; off-chain needs it", async () => {
    const {p} = setup({apiDown: true});
    expect((await p.buildCancel!({intentId: ID} as never, {owner: ME, onchain: true}))!.data!.slice(0, 10)).toBe("0x15337bc0");
    await expect(p.buildCancel!({intentId: ID} as never, {owner: ME, onchain: false})).rejects.toThrow(/^cow: /);
  });

  it("off-chain: typed OrderCancellations for this one order, signed and sent to the orderbook", async () => {
    const {w, p} = setup(listed({status: "open"}));
    const build = (await p.buildCancel!({intentId: ID} as never, {owner: ME, onchain: false}))!;
    expect(build).toMatchObject({chain: "eip155:1", to: D1.settlement, value: "0", chainId: 1});
    expect(build.data).toBeUndefined();
    const typed = JSON.parse(build.typedData!) as {primaryType: string; message: unknown; domain: unknown};
    expect(typed.primaryType).toBe("OrderCancellations");
    expect(typed.message).toEqual({orderUids: [UID]});
    expect(typed.domain).toEqual({name: "Gnosis Protocol", version: "v2", chainId: 1, verifyingContract: D1.settlement});
    // The engine's gate accepts it for this order and no other.
    expect(assertGpv2Cancellation(build.typedData!, {self: ME, chainId: 1})).toEqual([UID]);
    expect(() => assertGpv2Cancellation(build.typedData!, {self: OTHER, chainId: 1})).toThrow(/CoW cancellation refused/);
    expect(() => assertGpv2Cancellation(build.typedData!, {self: ME, chainId: 8453})).toThrow(/CoW cancellation refused/);
    const signature = await signTyped(build.typedData!);
    await p.registerCancel!(ID, signature);
    expect(w.cancelled).toEqual([{orderUids: [UID], signature: signature.toLowerCase(), signingScheme: "eip712"}]);
  });

  it("only the order's account cancels, and only what can still be cancelled", async () => {
    const {w, p, t} = setup(listed({status: "open"}));
    await expect(p.buildCancel!({intentId: ID} as never, {owner: OTHER, onchain: false})).rejects.toThrow("cow: this order belongs to another account");
    await expect(p.buildCancel!({intentId: ID} as never, {owner: OTHER, onchain: true})).rejects.toThrow("cow: this order belongs to another account");
    const build = (await p.buildCancel!({intentId: ID} as never, {owner: ME, onchain: false}))!;
    await expect(p.registerCancel!(ID, await signTyped(build.typedData!, other as never))).rejects.toThrow("cow: the cancellation is not signed by the order's account");
    await expect(p.registerCancel!(ID, "0x12")).rejects.toThrow("cow: the cancellation is not signed by the order's account");
    await expect(p.registerCancel!("q:1:1-a", "0x12")).rejects.toThrow("cow: only an order in the orderbook can be cancelled off-chain");
    expect(w.cancelled).toEqual([]);
    for (const status of ["fulfilled", "cancelled", "expired"]) {
      w.orders.set(UID, {status});
      expect(await p.buildCancel!({intentId: ID} as never, {owner: ME, onchain: false})).toBeNull();
      expect(await p.buildCancel!({intentId: ID} as never, {owner: ME, onchain: true})).toBeNull();
    }
    w.orders.clear();
    expect(await p.buildCancel!({intentId: ID} as never, {owner: ME, onchain: true})).toBeNull();
    w.orders.set(UID, {status: "open"});
    t.pass(1201);
    expect(await p.buildCancel!({intentId: ID} as never, {owner: ME, onchain: true})).toBeNull();
    expect(await p.buildCancel!({intentId: "q:1:1-a"} as never, {owner: ME, onchain: true})).toBeNull();
  });

  it("an order cancelled already is cancelled; any other refusal reaches the caller", async () => {
    const s = setup({...listed({status: "open"}), cancelError: {status: 400, errorType: "AlreadyCancelled"}});
    const build = (await s.p.buildCancel!({intentId: ID} as never, {owner: ME, onchain: false}))!;
    const signature = await signTyped(build.typedData!);
    await expect(s.p.registerCancel!(ID, signature)).resolves.toBeUndefined();
    s.w.cancelError = {status: 400, errorType: "OnChainOrder"};
    await expect(s.p.registerCancel!(ID, signature)).rejects.toThrow(/^cow: /);
  });
});
