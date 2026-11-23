// The provider end to end against a stubbed orderbook and node: what it asks, what it refuses, what it lets an
// account sign, and what leaves the device.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, parseAbi} from "viem";
import {assertGpv2Order, assertGpv2Permit} from "@anywalletkit/protocol-swap2-core";
import {buildAppData} from "../src/appdata.js";
import {COW_NATIVE} from "../src/deployments.js";
import {decodeEthFlowCall, ethFlowOrderId, ETH_FLOW_CREATE_SELECTOR} from "../src/ethflow.js";
import {orderDigest, orderUid, type CowOrder} from "../src/order.js";
import {PERMIT_SELECTOR, permitDigest, signedBy, splitSignature} from "../src/permit.js";
import {cowProvider, parseCowIntent} from "../src/provider.js";
import {D1, ME, NOW, RPC, OTHER, USDC, USDT, WETH, ZERO, ethToUsdc, listedOrder, other, setup, signTyped, uidOfPosted, usdcToWeth} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const PLAIN = buildAppData({slippageBps: 50});
const PERMIT_ABI = parseAbi(["function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)"]);
const orderOf = (typedData: string) => (JSON.parse(typedData) as {message: CowOrder}).message;

describe("what the provider offers", () => {
  it("ships dark: off until the app turns it on", () => {
    expect(cowProvider().enabled()).toBe(false);
    expect(cowProvider({enabled: true}).enabled()).toBe(true);
    expect(cowProvider().name).toBe("cow");
  });
  it("same-chain swaps on Ethereum, Base and Arbitrum — or the chains the app names", () => {
    const p = cowProvider({enabled: true});
    for (const chain of ["eip155:1", "eip155:8453", "eip155:42161"]) {
      expect(p.supportsChain!(chain)).toBe(true);
      expect(p.supportsChainPair!(chain, chain)).toBe(true);
    }
    expect(p.supportsChain!("eip155:100")).toBe(false);
    expect(p.supportsChain!("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBe(false);
    expect(p.supportsChainPair!("eip155:1", "eip155:8453")).toBe(false);
    const base = cowProvider({enabled: true, enabledChains: [8453]});
    expect([base.supportsChain!("eip155:8453"), base.supportsChain!("eip155:1"), base.supportsChain!("eip155:42161")]).toEqual([true, false, false]);
    // A chain taken out of the offer keeps its refunds and cancels reachable.
    expect(base.claimTargets!("eip155:1")).toEqual([D1.ethFlow]);
    expect(base.cancelTargets!("eip155:1")).toEqual([D1.settlement, D1.ethFlow]);
    expect(base.cancelTargets!("eip155:100")).toEqual([]);
  });
  it("has the engine send its calls with the account's own gas estimate: a fixed eth-flow limit ran short on Arbitrum", () => {
    // createOrder estimated 156 734 gas on Arbitrum (its L1 data counts as gas there) against the quoted 150 000.
    expect(cowProvider({enabled: true}).ownGasEstimate).toBe(true);
  });

  it("refuses a configuration it could not honour", () => {
    expect(() => cowProvider({validForSeconds: 60})).toThrow(/validForSeconds/);
    expect(() => cowProvider({validForSeconds: 3600})).toThrow(/validForSeconds/);
    expect(() => cowProvider({defaultSlippageBps: 5000})).toThrow(/defaultSlippageBps/);
    expect(() => cowProvider({appCode: 'a"b'})).toThrow(/appCode/);
  });
});

describe("ERC-20 quote", () => {
  it("asks the orderbook for exactly the caller's swap, and nothing about a partner fee", async () => {
    const {w, quote} = setup({}, {permit: false});
    await quote(usdcToWeth());
    expect(w.quotes).toEqual([{
      sellToken: USDC.toLowerCase(), buyToken: WETH.toLowerCase(), receiver: ME.toLowerCase(), from: ME.toLowerCase(), kind: "sell", sellAmountBeforeFee: "25000000",
      priceQuality: "verified", signingScheme: "eip712", validFor: 1200, appData: PLAIN.json, appDataHash: PLAIN.hash,
    }]);
  });

  it("prices the output, signs the minimum at the slippage, and names the network cost as included", async () => {
    const {quote} = setup({}, {permit: false});
    const q = (await quote(usdcToWeth()))!;
    expect(q).toMatchObject({
      provider: "cow", sourceAmount: "25000000", destAmount: "9999", minDestAmount: "9950", feeUsd: 0, etaSeconds: 45, depositAddress: "", depositMemo: null,
      validUntilMs: NOW * 1000 + 120_000,
      providerData: {kind: "order", verified: "true", validTo: String(NOW + 1200), slippageBps: "50", owner: ME, quoteId: "777", appData: PLAIN.hash, permit: "none"},
    });
    expect(q.fees).toEqual([expect.objectContaining({type: "network", amount: "1000", token: USDC.toLowerCase(), included: true})]);
    expect(parseCowIntent(q.intentId)).toMatchObject({kind: "quote", chainId: 1});
    expect(q.txRequest).toBeUndefined();
  });

  it("a price-only quote without any address is priced for a placeholder owner; an execution quote still needs the real one", async () => {
    // Funded run 2026-11-23: quoteSwap2 without a recipient (a route list before the account is known) was refused.
    const {quote, w, refusals} = setup({}, {permit: false});
    const dry = (await quote(usdcToWeth({destAddress: "", refundAddress: undefined, dry: true})))!;
    expect(dry).not.toBeNull();
    expect(w.quotes.at(-1)).toMatchObject({from: "0x1111111111111111111111111111111111111111", receiver: "0x1111111111111111111111111111111111111111"});
    refusals.length = 0;
    expect(await quote(usdcToWeth({destAddress: "", refundAddress: undefined, dry: false}))).toBeNull();
    expect(refusals[0]).toMatch(/recipient must be an EVM address/);
  });

  it("a token sale is gasless and names the vault relayer for the approval; a permit sale names none; eth-flow is the user's transaction", async () => {
    // SDK-291: the router subtracts the source gas from every route but a gasless one, and counts an approval only for
    // the spender a quote names.
    const {quote} = setup({}, {permit: false});
    const order = (await quote(usdcToWeth()))!;
    expect(order.gasless).toBe(true);
    expect(order.providerData?.approvalAddress).toBe(D1.vaultRelayer);
    const flow = (await quote(ethToUsdc()))!;
    expect(flow.gasless).toBeUndefined();
    expect(flow.txRequest).toBeDefined();
    const withPermit = setup({}, {rpcUrls: RPC});
    const signed = (await withPermit.quote(usdcToWeth({dry: false})))!;
    expect(signed.providerData?.permit).toBe("offered");
    expect(signed.gasless).toBe(true);
    expect(signed.providerData?.approvalAddress).toBeUndefined();
  });

  it("names the native coin's network cost as \"native\", like every other provider", async () => {
    // Funded run 2026-11-23: an eth-flow quote named it by the catalog's 1Click asset id (nep141:…omft.near).
    const {quote} = setup({}, {permit: false});
    const q = (await quote(ethToUsdc()))!;
    expect(q.fees).toEqual([expect.objectContaining({type: "network", token: "native", included: true})]);
  });

  it("the caller's slippage and a tighter minimum of its own are what the order signs", async () => {
    const {quote} = setup({}, {permit: false});
    expect((await quote(usdcToWeth({slippageBps: 100})))!.minDestAmount).toBe("9900");
    expect((await quote(usdcToWeth({slippageBps: 0})))!.minDestAmount).toBe("9999");
    expect((await quote(usdcToWeth({minAmountOut: "9990"})))!.minDestAmount).toBe("9990");
    expect((await quote(usdcToWeth({minAmountOut: "100"})))!.minDestAmount).toBe("9950");
  });

  it("a quote the orderbook could not simulate is still a quote, and says so", async () => {
    const {w, quote} = setup({verified: "refuse"}, {permit: false});
    const q = (await quote(usdcToWeth()))!;
    expect(w.quotes.map((b) => b.priceQuality)).toEqual(["verified", "optimal"]);
    expect(q.providerData!.verified).toBe("false");
  });

  it("the receiver is the caller's recipient, the owner is the account that signs", async () => {
    const {w, quote} = setup({}, {permit: false});
    const q = (await quote(usdcToWeth({destAddress: OTHER})))!;
    expect(w.quotes[0]).toMatchObject({receiver: OTHER.toLowerCase(), from: ME.toLowerCase()});
    expect(q.providerData!.owner).toBe(ME);
  });

  it("buying the native coin uses CoW's native marker", async () => {
    const {w, quote} = setup({}, {permit: false});
    expect(await quote(usdcToWeth({destToken: ZERO}))).not.toBeNull();
    expect(w.quotes[0]!.buyToken).toBe(COW_NATIVE.toLowerCase());
  });

  it("refuses, with a reason, everything that is not a same-chain sell of a known token", async () => {
    const {w, quote, refusals} = setup({}, {permit: false});
    const cases: [Record<string, unknown>, RegExp][] = [
      [{flex: true}, /amount-flexible/],
      [{destChain: "eip155:8453"}, /stay on one chain/],
      [{sourceChain: "eip155:100", destChain: "eip155:100"}, /is not offered/],
      [{sourceToken: "NOPE"}, /unknown source token/],
      [{destToken: "ETH"}, /destination token is not an EVM token/],
      [{sourceToken: "WETH"}, /same token in and out/],
      [{sourceToken: "WETH", destToken: ZERO}, /unwrapping the native coin is not a swap/],
      [{sourceToken: "ETH"}, /wrapping the native coin is not a swap/],
      [{sourceToken: "ETH", destToken: ZERO}, /same token in and out/],
      [{amountIn: "0"}, /positive whole number/],
      [{amountIn: "1.5"}, /positive whole number/],
      [{slippageBps: 10_000}, /slippage/],
      [{slippageBps: 0.5}, /slippage/],
      [{destAddress: "x", refundAddress: undefined}, /recipient must be an EVM address/],
      [{minAmountOut: "10000"}, /below the requested minimum/],
      [{minAmountOut: "abc"}, /below the requested minimum/],
    ];
    for (const [over, reason] of cases) {
      refusals.length = 0;
      expect(await quote(usdcToWeth(over)), JSON.stringify(over)).toBeNull();
      expect(refusals, JSON.stringify(over)).toHaveLength(1);
      expect(refusals[0]).toMatch(reason);
      expect(refusals[0]).toMatch(/^cow: /);
    }
    // Only the last two reached the orderbook at all.
    expect(w.quotes).toHaveLength(2);
  });

  it("refuses a quote the orderbook bent, naming what was bent", async () => {
    const bends: [(a: {quote: Record<string, unknown>; [k: string]: unknown}) => void, RegExp][] = [
      [(a) => { a.quote.receiver = OTHER.toLowerCase(); }, /pays another receiver/],
      [(a) => { a.quote.buyToken = USDT.toLowerCase(); }, /buys another token/],
      [(a) => { a.quote.sellAmount = "25000000"; }, /does not add up/],
      [(a) => { a.quote.validTo = 0xfffffffe; }, /expires at another time/],
      [(a) => { a.quote.appDataHash = `0x${"00".repeat(32)}`; }, /another appData document/],
      [(a) => { a.quote.kind = "buy"; }, /not a sell order/],
    ];
    for (const [bend, reason] of bends) {
      const {quote, refusals} = setup({tamper: (a) => (bend(a), a)}, {permit: false});
      expect(await quote(usdcToWeth())).toBeNull();
      expect(refusals[0]).toMatch(reason);
      vi.unstubAllGlobals();
    }
  });

  it("the orderbook's refusals reach the caller in plain words; an unreachable orderbook is said to be one", async () => {
    const a = setup({quoteError: {status: 400, errorType: "NoLiquidity"}}, {permit: false});
    expect(await a.quote(usdcToWeth())).toBeNull();
    expect(a.refusals).toEqual(["cow: no route for this pair"]);
    const b = setup({quoteError: {status: 400, errorType: "SellAmountDoesNotCoverFee"}}, {permit: false});
    await b.quote(usdcToWeth());
    expect(b.refusals[0]).toMatch(/too small to cover the network cost/);
    const c = setup({apiDown: true}, {permit: false});
    expect(await c.quote(usdcToWeth())).toBeNull();
    expect(c.refusals[0]).toMatch(/^cow: /);
  });

  it("a native payout to a contract is refused when the chain can be read", async () => {
    const withCode = setup({code: new Map([[OTHER.toLowerCase(), "0x6080"]])}, {permit: false});
    expect(await withCode.quote(usdcToWeth({destToken: ZERO, destAddress: OTHER}))).toBeNull();
    expect(withCode.refusals[0]).toMatch(/receiver is a contract/);
    // The wrapped token to the same contract is fine.
    expect(await withCode.quote(usdcToWeth({destAddress: OTHER}))).not.toBeNull();
  });
});

describe("the allowance and the permit offer", () => {
  it("offers a permit when the token proves EIP-2612, the allowance is short and no other order is open", async () => {
    const {w, quote, p} = setup();
    const q = (await quote(usdcToWeth()))!;
    expect(q.providerData!.permit).toBe("offered");
    // The quote was priced with a hook of the permit's shape; the order itself still commits to the plain document.
    const priced = JSON.parse(w.quotes[0]!.appData as string) as {metadata: {hooks: {pre: {target: string; callData: string; gasLimit: string}[]}}};
    expect(priced.metadata.hooks.pre).toHaveLength(1);
    expect(priced.metadata.hooks.pre[0]).toMatchObject({target: USDC.toLowerCase(), gasLimit: "100000"});
    expect(priced.metadata.hooks.pre[0]!.callData.slice(0, 10)).toBe(PERMIT_SELECTOR);
    expect(q.providerData!.appData).toBe(PLAIN.hash);

    const build = await p.buildDeposit(q);
    expect(orderOf(build.typedData!).appData).toBe(PLAIN.hash);
    const permit = JSON.parse(build.permit!) as {domain: unknown; message: Record<string, string>; primaryType: string};
    expect(permit.primaryType).toBe("Permit");
    expect(permit.domain).toEqual({name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC});
    expect(permit.message).toEqual({owner: ME, spender: D1.vaultRelayer, value: "25000000", nonce: "0", deadline: String(NOW + 1200)});
    // The engine's own gate accepts exactly this permit.
    expect(assertGpv2Permit(build.permit!, {self: ME, token: USDC, value: 25_000_000n, chainId: 1, deadline: NOW + 1200})).toEqual({amount: 25_000_000n, deadline: NOW + 1200});
  });

  it("offers none when it is switched off, the allowance covers the order, the token has no permit, or the chain cannot be read", async () => {
    const none = async (over: Parameters<typeof setup>[0], config: Parameters<typeof setup>[1] = {}) => {
      const s = setup(over, config);
      const q = (await s.quote(usdcToWeth()))!;
      const build = await s.p.buildDeposit(q);
      expect(q.providerData!.permit).toBe("none");
      expect(build.permit).toBeUndefined();
      expect(s.w.quotes[0]!.appData).toBe(PLAIN.json);
      vi.unstubAllGlobals();
      return build;
    };
    await none({}, {permit: false});
    await none({allowance: 25_000_000n});
    await none({permitToken: null});
    await none({rpcDown: true});
    await none({}, {rpcUrls: {}});
    // DAI's permit form is another call.
    await none({permitToken: {name: "Dai Stablecoin", version: "1", nonce: 0n, typeHash: `0x${"ea".repeat(32)}`}});
  });

  it("another open order of the same token: the allowance covers both, and the permit — one allowance, one order — is not offered", async () => {
    const open = await listedOrder({sellAmount: "5000000"});
    const {quote, p} = setup({accountOrders: [open]});
    const q = (await quote(usdcToWeth()))!;
    const build = await p.buildDeposit(q);
    expect(build.approvalAmount).toBe("30000000");
    expect(q.providerData!.permit).toBe("none");
    expect(build.permit).toBeUndefined();
  });

  it("counts what an open order may still pull: sellAmount + fee − executed, per order", async () => {
    const orders = [
      await listedOrder({sellAmount: "5000000"}, {executedSellAmount: "2000000"}),
      await listedOrder({sellAmount: "7000000", feeAmount: "10", validTo: NOW + 900}),
    ];
    const {quote, p} = setup({accountOrders: orders});
    expect((await p.buildDeposit((await quote(usdcToWeth()))!)).approvalAmount).toBe(String(25_000_000 + 3_000_000 + 7_000_010));
  });

  it("the orderbook cannot talk the allowance up: only open, unexpired orders of this token the account provably signed count", async () => {
    const forged = [
      await listedOrder({}, {sellAmount: "900000000"}), // fields no longer hash to the UID
      await listedOrder({}, {signature: await signTyped(JSON.stringify({domain: {name: "Gnosis Protocol", version: "v2", chainId: 1, verifyingContract: D1.settlement}, types: {EIP712Domain: [], OrderCancellations: [{name: "orderUids", type: "bytes[]"}]}, primaryType: "OrderCancellations", message: {orderUids: []}}), other as never)}),
      await listedOrder({}, {signingScheme: "presign"}),
      await listedOrder({}, {signingScheme: "eip1271"}),
      await listedOrder({}, {status: "fulfilled"}),
      await listedOrder({}, {status: "cancelled"}),
      await listedOrder({}, {invalidated: true}),
      await listedOrder({validTo: NOW - 1}),
      await listedOrder({sellToken: USDT.toLowerCase()}),
      await listedOrder({}, {uid: "0x1234"}),
      null, "x", 5,
    ];
    const {quote, p} = setup({accountOrders: forged});
    const q = (await quote(usdcToWeth()))!;
    expect((await p.buildDeposit(q)).approvalAmount).toBe("25000000");
    // None of them is an open order of the account: the permit is still on offer.
    expect(q.providerData!.permit).toBe("offered");
  });

  it("an order list that could not be read, or may be incomplete, covers this order alone and offers no permit", async () => {
    const down = setup({accountOrders: "down"});
    const q = (await down.quote(usdcToWeth()))!;
    expect((await down.p.buildDeposit(q)).approvalAmount).toBe("25000000");
    expect(q.providerData!.permit).toBe("none");
    vi.unstubAllGlobals();
    const full = setup({accountOrders: Array.from({length: 100}, () => ({status: "fulfilled"}))});
    expect((await full.quote(usdcToWeth()))!.providerData!.permit).toBe("none");
  });

  it("a dry quote reads nothing about the account and cannot be built", async () => {
    const {w, quote, p} = setup();
    const q = (await quote(usdcToWeth({dry: true})))!;
    expect(q.providerData!.permit).toBe("none");
    expect(w.rpcCalls).toEqual([]);
    expect(w.quotes[0]!.appData).toBe(PLAIN.json);
    await expect(p.buildDeposit(q)).rejects.toThrow("cow: this quote is no longer known to the provider — request a fresh quote");
  });
});

describe("the order an account signs", () => {
  it("is written from the request: tokens, receiver, the whole input, the minimum, a zero fee, a fill-or-kill sell", async () => {
    const {quote, p} = setup({}, {permit: false});
    const q = (await quote(usdcToWeth()))!;
    const build = await p.buildDeposit(q);
    expect(build).toMatchObject({chain: "eip155:1", to: D1.settlement, value: "0", chainId: 1, approvalAddress: D1.vaultRelayer, approvalAmount: "25000000"});
    expect(build.data).toBeUndefined();
    expect(orderOf(build.typedData!)).toEqual({
      sellToken: USDC, buyToken: WETH, receiver: ME, sellAmount: "25000000", buyAmount: "9950", validTo: NOW + 1200, appData: PLAIN.hash,
      feeAmount: "0", kind: "sell", partiallyFillable: false, sellTokenBalance: "erc20", buyTokenBalance: "erc20",
    });
    // The engine's gate over the signed struct accepts it for this swap — and for no other.
    const gate = {self: ME, token: USDC, amount: "25000000", chainId: 1, recipient: ME, destToken: WETH, minDest: "9950", now: NOW};
    expect(assertGpv2Order(build.typedData!, build.approvalAddress!, gate)).toMatchObject({validTo: NOW + 1200, appData: PLAIN.hash});
    expect(() => assertGpv2Order(build.typedData!, build.approvalAddress!, {...gate, recipient: OTHER})).toThrow(/receiver is not the swap's recipient/);
    expect(() => assertGpv2Order(build.typedData!, build.approvalAddress!, {...gate, minDest: "9951"})).toThrow(/below the quoted minimum/);
  });

  it("a quote that is not this provider's, was placed, or was altered after pricing is not built", async () => {
    const {quote, p} = setup({}, {permit: false});
    const q = (await quote(usdcToWeth()))!;
    await expect(p.buildDeposit({...q, intentId: "lifi:abc"})).rejects.toThrow("cow: this is not a CoW quote");
    await expect(p.buildDeposit({...q, intentId: `o:1:0x${"ab".repeat(56)}`})).rejects.toThrow("cow: this order was placed already");
    await expect(p.buildDeposit({...q, intentId: "q:1:zz-zz"})).rejects.toThrow(/no longer known/);
    await expect(p.buildDeposit({...q, intentId: q.intentId.replace("q:1:", "q:100:")})).rejects.toThrow(/not a CoW Protocol chain/);
    await expect(p.buildDeposit({...q, minDestAmount: "1"})).rejects.toThrow("cow: the quote does not match its order");
    await expect(p.buildDeposit({...q, sourceAmount: "1"})).rejects.toThrow("cow: the quote does not match its order");
  });

  it("is not signed when it would expire within five minutes", async () => {
    const {quote, p, t} = setup({}, {permit: false});
    const q = (await quote(usdcToWeth()))!;
    const build = await p.buildDeposit(q);
    await expect(p.preflightDeposit!(q, build)).resolves.toBeUndefined();
    t.pass(901);
    await expect(p.preflightDeposit!(q, build)).rejects.toThrow("cow: the order would expire too soon to be filled — request a fresh quote");
  });
});

describe("placing the signed order", () => {
  const placed = async (over: Parameters<typeof setup>[0] = {}, config: Parameters<typeof setup>[1] = {permit: false}) => {
    const s = setup(over, config);
    const q = (await s.quote(usdcToWeth()))!;
    const build = await s.p.buildDeposit(q);
    return {...s, q, build, order: orderOf(build.typedData!)};
  };

  it("posts the order as signed, with its appData document and the quote it was priced from; the id becomes the UID", async () => {
    const {w, p, q, build, order} = await placed();
    const signature = await signTyped(build.typedData!);
    const uid = orderUid(orderDigest(1, order), ME, order.validTo);
    expect(await p.registerSignedOrder!(q.intentId, signature)).toEqual({intentId: `o:1:${uid}`});
    expect(w.posted).toEqual([{...order, appData: PLAIN.json, appDataHash: PLAIN.hash, from: ME, signingScheme: "eip712", signature: signature.toLowerCase(), quoteId: 777}]);
    expect(uidOfPosted(1, w.posted[0]!)).toBe(uid);
    // Asked again (a lost answer), it is the same order — nothing is posted twice.
    expect(await p.registerSignedOrder!(q.intentId, signature)).toEqual({intentId: `o:1:${uid}`});
    expect(w.posted).toHaveLength(1);
  });

  it("only the quote's own account can place it, and only with a signature over this exact order", async () => {
    const {w, p, q, build, order} = await placed();
    await expect(p.registerSignedOrder!(q.intentId, await signTyped(build.typedData!, other as never))).rejects.toThrow(`cow: the order is not signed by ${ME} — only the account that requested the quote can place it`);
    const bent = JSON.stringify({...JSON.parse(build.typedData!), message: {...order, buyAmount: "1"}});
    await expect(p.registerSignedOrder!(q.intentId, await signTyped(bent))).rejects.toThrow(/is not signed by/);
    await expect(p.registerSignedOrder!(q.intentId, "0x1234")).rejects.toThrow(/is not signed by/);
    expect(w.posted).toEqual([]);
  });

  it("a signature that came too late is not posted", async () => {
    const {w, p, q, build, t} = await placed();
    const signature = await signTyped(build.typedData!);
    t.pass(901);
    await expect(p.registerSignedOrder!(q.intentId, signature)).rejects.toThrow(/expire too soon/);
    expect(w.posted).toEqual([]);
  });

  it("an order the orderbook already has is placed; a quote it forgot is posted without the quote", async () => {
    const dup = await placed({postErrors: [{status: 400, errorType: "DuplicatedOrder"}]});
    const uid = orderUid(orderDigest(1, dup.order), ME, dup.order.validTo);
    expect(await dup.p.registerSignedOrder!(dup.q.intentId, await signTyped(dup.build.typedData!))).toEqual({intentId: `o:1:${uid}`});
    vi.unstubAllGlobals();
    for (const errorType of ["QuoteNotFound", "InvalidQuote"]) {
      const s = await placed({postErrors: [{status: 400, errorType}]});
      await s.p.registerSignedOrder!(s.q.intentId, await signTyped(s.build.typedData!));
      expect(s.w.posted.map((b) => b.quoteId)).toEqual([777, undefined]);
      vi.unstubAllGlobals();
    }
  });

  it("the orderbook's refusal reaches the caller; another id than the local UID is not taken for the order", async () => {
    const refused = await placed({postErrors: [{status: 400, errorType: "InsufficientBalance"}]});
    await expect(refused.p.registerSignedOrder!(refused.q.intentId, await signTyped(refused.build.typedData!))).rejects.toThrow("cow: the wallet's balance is below the amount");
    vi.unstubAllGlobals();
    for (const answer of [`0x${"ab".repeat(56)}`, "0x", null, {uid: "x"}]) {
      const s = await placed({postAnswer: () => answer});
      await expect(s.p.registerSignedOrder!(s.q.intentId, await signTyped(s.build.typedData!))).rejects.toThrow(/answered with another order id/);
      vi.unstubAllGlobals();
    }
  });

  it("a quote without an id is posted without one", async () => {
    const {w, p, q, build} = await placed({quoteId: null});
    expect(q.providerData!.quoteId).toBeUndefined();
    await p.registerSignedOrder!(q.intentId, await signTyped(build.typedData!));
    expect("quoteId" in w.posted[0]!).toBe(false);
  });
});

describe("the permit path", () => {
  const offered = async (over: Parameters<typeof setup>[0] = {}) => {
    const s = setup(over);
    const q = (await s.quote(usdcToWeth()))!;
    const build = await s.p.buildDeposit(q);
    return {...s, q, build};
  };

  it("the signed permit becomes the order's one pre-hook; only appData changes in the order", async () => {
    const {w, p, q, build} = await offered();
    const permitSignature = await signTyped(build.permit!);
    const funded = await p.applyPermit!(q.intentId, permitSignature);
    expect({...funded, typedData: undefined}).toEqual({...build, permit: undefined, typedData: undefined});
    expect(funded.permit).toBeUndefined();
    const before = orderOf(build.typedData!);
    const after = orderOf(funded.typedData!);
    expect({...after, appData: before.appData}).toEqual(before);
    expect(after.appData).not.toBe(before.appData);
    // The exact call was simulated from the settlement contract before anything else was signed.
    const simulated = w.rpcCalls.find((c) => c.method === "eth_estimateGas")!.params[0] as {from: string; to: string; data: `0x${string}`};
    expect(simulated).toMatchObject({from: D1.settlement, to: USDC});
    const parts = splitSignature(permitSignature)!;
    expect(decodeFunctionData({abi: PERMIT_ABI, data: simulated.data}).args).toEqual([ME, D1.vaultRelayer, 25_000_000n, BigInt(NOW + 1200), parts.v, parts.r, parts.s]);

    // The order is posted with the document that carries the permit, and that document hashes to the signed appData.
    await p.registerSignedOrder!(q.intentId, await signTyped(funded.typedData!));
    const body = w.posted[0]!;
    expect(body.appDataHash).toBe(after.appData);
    expect(buildAppData({slippageBps: 50, permitHook: {target: USDC, callData: simulated.data, gasLimit: "100000"}})).toEqual({json: body.appData, hash: after.appData});
    expect(body.quoteId).toBe(777);
    // The pre-permit order's signature no longer places anything.
    await expect(p.registerSignedOrder!(q.intentId, await signTyped(build.typedData!))).resolves.toEqual({intentId: expect.stringMatching(/^o:1:0x/)});
    expect(w.posted).toHaveLength(1);
  });

  it("the order signed without the permit is posted without the quote id (it was priced with the hook's gas)", async () => {
    const {w, p, q, build} = await offered();
    await p.registerSignedOrder!(q.intentId, await signTyped(build.typedData!));
    expect(w.posted[0]!.appData).toBe(PLAIN.json);
    expect("quoteId" in w.posted[0]!).toBe(false);
  });

  it("a permit by another account, or for a quote that offered none, is refused", async () => {
    const {p, q, build} = await offered();
    await expect(p.applyPermit!(q.intentId, await signTyped(build.permit!, other as never))).rejects.toThrow("cow: the permit is not signed by the order's account");
    await expect(p.applyPermit!(q.intentId, "0x00")).rejects.toThrow("cow: the permit is not signed by the order's account");
    await expect(p.applyPermit!("q:1:zz-zz", "0x00")).rejects.toThrow(/no longer known/);
    vi.unstubAllGlobals();
    const none = setup({}, {permit: false});
    const plain = (await none.quote(usdcToWeth()))!;
    await expect(none.p.applyPermit!(plain.intentId, "0x00")).rejects.toThrow("cow: this quote offered no permit");
  });

  it("a permit the token refuses stops the order, and the next quote takes the approval transaction", async () => {
    const {p, q, build, quote, t} = await offered({permitGas: "revert"});
    await expect(p.applyPermit!(q.intentId, await signTyped(build.permit!))).rejects.toThrow("cow: the token refused the signed permit");
    expect((await quote(usdcToWeth()))!.providerData!.permit).toBe("none");
    t.pass(601);
    expect((await quote(usdcToWeth()))!.providerData!.permit).toBe("offered");
  });

  it("the permit digest is the token's: its own domain, this owner, the vault relayer, the order's expiry", async () => {
    const {build} = await offered({permitToken: {name: "USD Coin", version: "2", nonce: 9n}});
    const digest = permitDigest({chainId: 1, token: USDC, domain: {name: "USD Coin", version: "2"}, owner: ME, value: "25000000", nonce: "9", deadline: NOW + 1200});
    expect(await signedBy(digest, await signTyped(build.permit!), ME)).toBe(true);
  });
});

describe("native sell through eth-flow", () => {
  it("asks for an on-chain order and answers one transaction: createOrder with the input as its value", async () => {
    const {w, quote, p} = setup();
    const q = (await quote(ethToUsdc()))!;
    expect(w.quotes[0]).toMatchObject({sellToken: WETH.toLowerCase(), buyToken: USDC.toLowerCase(), signingScheme: "eip1271", onchainOrder: true, sellAmountBeforeFee: "10000000000000000", receiver: ME.toLowerCase(), from: ME.toLowerCase()});
    const out = (10n ** 16n - 1000n) / 2500n;
    const min = out - (out * 50n) / 10_000n;
    expect(q).toMatchObject({destAmount: out.toString(), minDestAmount: min.toString(), providerData: {kind: "ethflow", owner: ME, quoteId: "777", appData: PLAIN.hash}});
    expect(q.txRequest).toMatchObject({to: D1.ethFlow, value: "10000000000000000", chainId: 1, gasLimit: "150000"});
    const call = decodeEthFlowCall(q.txRequest!.data!)!;
    expect(call).toEqual({method: "createOrder", order: {buyToken: USDC, receiver: ME, sellAmount: "10000000000000000", buyAmount: min.toString(), appData: PLAIN.hash, validTo: NOW + 1200, quoteId: 777}});
    expect(parseCowIntent(q.intentId)).toEqual({kind: "ethflow", chainId: 1, data: call.order});

    const build = await p.buildDeposit(q);
    expect(build).toEqual({chain: "eip155:1", to: D1.ethFlow, value: "10000000000000000", data: q.txRequest!.data, chainId: 1, gasLimit: "150000"});
    expect(build.data!.slice(0, 10)).toBe(ETH_FLOW_CREATE_SELECTOR);
    expect(build.typedData).toBeUndefined();
    expect(build.approvalAddress).toBeUndefined();
  });

  it("nothing is sent before the orderbook knows the order's appData document", async () => {
    const {w, quote, p} = setup();
    const q = (await quote(ethToUsdc()))!;
    await p.preflightDeposit!(q, await p.buildDeposit(q));
    expect(w.appData).toEqual([{hash: PLAIN.hash, body: {fullAppData: PLAIN.json}}]);
    vi.unstubAllGlobals();
    const down = setup();
    const q2 = (await down.quote(ethToUsdc()))!;
    const build = await down.p.buildDeposit(q2);
    down.w.apiDown = true;
    await expect(down.p.preflightDeposit!(q2, build)).rejects.toThrow(/^cow: /);
  });

  it("a transaction that is not this quote's order is not sent", async () => {
    const {quote, p, t} = setup();
    const q = (await quote(ethToUsdc()))!;
    const build = await p.buildDeposit(q);
    const otherQuote = (await quote(ethToUsdc({destAddress: OTHER})))!;
    const wrong = "cow: the transaction is not this quote's eth-flow order";
    await expect(p.preflightDeposit!(q, {...build, data: otherQuote.txRequest!.data!})).rejects.toThrow(wrong);
    await expect(p.preflightDeposit!(q, {...build, to: D1.settlement})).rejects.toThrow(wrong);
    await expect(p.preflightDeposit!(q, {...build, data: `0x7bc41b96${build.data!.slice(10)}`})).rejects.toThrow(wrong);
    await expect(p.preflightDeposit!(q, {...build, data: undefined} as never)).rejects.toThrow(wrong);
    await expect(p.buildDeposit({...q, minDestAmount: "1"})).rejects.toThrow("cow: the quote does not match its eth-flow order");
    t.pass(901);
    await expect(p.preflightDeposit!(q, build)).rejects.toThrow(/expire too soon/);
  });

  it("an identical order already in the contract gets a slightly higher minimum; one that appears later stops the send", async () => {
    const first = setup();
    const q1 = (await first.quote(ethToUsdc()))!;
    const data1 = (parseCowIntent(q1.intentId) as {data: Parameters<typeof ethFlowOrderId>[1]}).data;
    vi.unstubAllGlobals();

    const again = setup({ethFlowOrders: new Map([[ethFlowOrderId(D1, data1).digest, {owner: ME, validTo: NOW + 1200}]])});
    const q2 = (await again.quote(ethToUsdc()))!;
    expect(BigInt(q2.minDestAmount)).toBe(BigInt(q1.minDestAmount) + 1n);
    const build = await again.p.buildDeposit(q2);
    await expect(again.p.preflightDeposit!(q2, build)).resolves.toBeUndefined();
    const data2 = (parseCowIntent(q2.intentId) as {data: Parameters<typeof ethFlowOrderId>[1]}).data;
    again.w.ethFlowOrders.set(ethFlowOrderId(D1, data2).digest, {owner: OTHER, validTo: NOW + 1200});
    await expect(again.p.preflightDeposit!(q2, build)).rejects.toThrow("cow: an identical order was placed already — request a fresh quote");
    // A refunded order still holds its slot.
    vi.unstubAllGlobals();
    const refunded = setup({ethFlowOrders: new Map([[ethFlowOrderId(D1, data1).digest, {owner: "0xffffffffffffffffffffffffffffffffffffffff", validTo: 0}]])});
    expect(BigInt((await refunded.quote(ethToUsdc()))!.minDestAmount)).toBe(BigInt(q1.minDestAmount) + 1n);
  });

  it("refuses a quote without an id (the contract links the order to it) and the swaps eth-flow cannot make", async () => {
    const noId = setup({quoteId: null});
    expect(await noId.quote(ethToUsdc())).toBeNull();
    expect(noId.refusals[0]).toMatch(/no quote id for an on-chain order/);
  });

  it("works without any RPC: the orderbook alone is enough to quote and build", async () => {
    const {quote, p, w} = setup({}, {rpcUrls: {}});
    const q = (await quote(ethToUsdc()))!;
    await p.preflightDeposit!(q, await p.buildDeposit(q));
    expect(w.rpcCalls).toEqual([]);
    expect(w.appData).toHaveLength(1);
  });
});

describe("status ids", () => {
  it("parse to a quote, an order or an eth-flow order — and to nothing else", () => {
    const uid = `0x${"ab".repeat(56)}`;
    expect(parseCowIntent("q:8453:1-abc")).toEqual({kind: "quote", chainId: 8453, key: "1-abc"});
    expect(parseCowIntent(`o:42161:${uid.toUpperCase().replace("0X", "0x")}`)).toEqual({kind: "order", chainId: 42161, uid});
    for (const bad of ["", "cow", "o:1:0x12", "x:1:abc", "o:0:" + uid, "o:1.5:" + uid, "e:1:abc", `o:1:${uid} `, null as never, 5 as never]) expect(parseCowIntent(bad), String(bad)).toBeNull();
  });
});
