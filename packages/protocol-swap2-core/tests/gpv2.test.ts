import {describe, expect, it} from "vitest";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import {
  EIP2612_PERMIT_FIELDS, GPV2_CANCELLATIONS_FIELDS, GPV2_MAX_VALIDITY_SECONDS, GPV2_NATIVE_BUY, GPV2_ORDER_FIELDS, GPV2_SETTLEMENT, GPV2_VAULT_RELAYER,
  assertGpv2Cancellation, assertGpv2Order, assertGpv2Permit, isGpv2Order,
} from "../src/swap2/gpv2.js";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "../src/types.js";

// CoW Protocol typed data at the engine's gate. A provider (or whatever answers for it) is not trusted with what
// the account signs: the order, the permit that funds it and the cancellation are each bound to the swap field by
// field, and the engine sends nothing for a cancel but plain calldata to a contract the provider declared.

const SELF = "0x4444444444444444444444444444444444444444";
const OTHER = "0x9999999999999999999999999999999999999999";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const NOW = 1_800_000_000;
const DOMAIN_TYPE = [{name: "name", type: "string"}, {name: "version", type: "string"}, {name: "chainId", type: "uint256"}, {name: "verifyingContract", type: "address"}];
const DOMAIN = {name: "Gnosis Protocol", version: "v2", chainId: 1, verifyingContract: GPV2_SETTLEMENT};
const ORDER = {
  sellToken: USDC, buyToken: WETH, receiver: SELF, sellAmount: "1000000", buyAmount: "400", validTo: NOW + 1200, appData: `0x${"11".repeat(32)}`,
  feeAmount: "0", kind: "sell", partiallyFillable: false, sellTokenBalance: "erc20", buyTokenBalance: "erc20",
};
type Bend = {domain?: Record<string, unknown>; message?: Record<string, unknown>; types?: Record<string, unknown>; primaryType?: string};
const order = (b: Bend = {}, now = NOW) => JSON.stringify({
  domain: {...DOMAIN, ...b.domain}, primaryType: b.primaryType ?? "Order", types: {EIP712Domain: DOMAIN_TYPE, Order: GPV2_ORDER_FIELDS, ...b.types},
  message: {...ORDER, validTo: now + 1200, ...b.message},
});
const EXPECT = {self: SELF, token: USDC, amount: "1000000", chainId: 1, recipient: SELF, destToken: WETH, minDest: "400", now: NOW};
const without = <T extends Record<string, unknown>>(o: T, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

describe("assertGpv2Order", () => {
  it("accepts the swap's own order and returns its expiry and appData", () => {
    expect(isGpv2Order(order())).toBe(true);
    expect(assertGpv2Order(order(), GPV2_VAULT_RELAYER, EXPECT)).toMatchObject({validTo: NOW + 1200, appData: `0x${"11".repeat(32)}`});
    // More than the minimum is fine; the native coin out is CoW's marker.
    expect(() => assertGpv2Order(order({message: {buyAmount: "401"}}), GPV2_VAULT_RELAYER, EXPECT)).not.toThrow();
    expect(() => assertGpv2Order(order({message: {buyToken: GPV2_NATIVE_BUY}}), GPV2_VAULT_RELAYER, {...EXPECT, destToken: `0x${"00".repeat(20)}`})).not.toThrow();
  });

  const bends: [string, Bend, RegExp][] = [
    ["another receiver", {message: {receiver: OTHER}}, /receiver is not the swap's recipient/],
    ["a zero receiver", {message: {receiver: `0x${"00".repeat(20)}`}}, /receiver/],
    ["another sell token", {message: {sellToken: WETH}}, /sellToken is not the source token/],
    ["another buy token", {message: {buyToken: USDC}}, /buyToken is not the destination token/],
    ["the native marker for a token swap", {message: {buyToken: GPV2_NATIVE_BUY}}, /buyToken/],
    ["a larger sell amount", {message: {sellAmount: "1000001"}}, /sellAmount/],
    ["a smaller sell amount", {message: {sellAmount: "999999"}}, /sellAmount/],
    ["a numeric sell amount", {message: {sellAmount: 1000000}}, /sellAmount/],
    ["a hex sell amount", {message: {sellAmount: "0xf4240"}}, /sellAmount/],
    ["less than the quoted minimum", {message: {buyAmount: "399"}}, /below the quoted minimum/],
    ["a zero minimum", {message: {buyAmount: "0"}}, /below the quoted minimum/],
    ["a signed fee", {message: {feeAmount: "1"}}, /signed fee/],
    ["a buy order", {message: {kind: "buy"}}, /not a sell order/],
    ["a partially fillable order", {message: {partiallyFillable: true}}, /partially fillable/],
    ["a truthy partiallyFillable", {message: {partiallyFillable: "false"}}, /partially fillable/],
    ["an internal sell balance", {message: {sellTokenBalance: "internal"}}, /internal vault balances/],
    ["an external sell balance", {message: {sellTokenBalance: "external"}}, /internal vault balances/],
    ["an internal buy balance", {message: {buyTokenBalance: "internal"}}, /internal vault balances/],
    ["a short appData", {message: {appData: "0x11"}}, /appData/],
    ["an expiry in the past", {message: {validTo: NOW}}, /near-future expiry/],
    ["an expiry days away", {message: {validTo: NOW + GPV2_MAX_VALIDITY_SECONDS + 1}}, /near-future expiry/],
    ["an order that never expires", {message: {validTo: 0xffffffff}}, /near-future expiry/],
    ["a string expiry", {message: {validTo: String(NOW + 1200)}}, /near-future expiry/],
    ["an extra field", {message: {extra: 1}}, /missing or extra fields/],
    ["another chain", {domain: {chainId: 8453}}, /chainId is not the source chain/],
    ["a string chain id", {domain: {chainId: "1"}}, /chainId/],
    ["another verifying contract", {domain: {verifyingContract: OTHER}}, /is not GPv2Settlement/],
    ["another domain name", {domain: {name: "Gnosis Protocol v3"}}, /not GPv2Settlement's/],
    ["another domain version", {domain: {version: "v3"}}, /not GPv2Settlement's/],
    ["a salted domain", {domain: {salt: `0x${"00".repeat(32)}`}}, /domain is not/],
    ["another primary type", {primaryType: "Permit"}, /primaryType/],
    ["a shadow type", {types: {Other: [{name: "x", type: "uint256"}]}}, /unexpected type Other/],
    ["a reordered Order type", {types: {Order: [...GPV2_ORDER_FIELDS].reverse()}}, /not the canonical one/],
    ["an Order type with a retyped field", {types: {Order: GPV2_ORDER_FIELDS.map((f) => (f.name === "receiver" ? {...f, type: "bytes32"} : f))}}, /not the canonical one/],
    ["a bent EIP712Domain type", {types: {EIP712Domain: DOMAIN_TYPE.slice(0, 3)}}, /EIP712Domain/],
  ];
  for (const [name, bend, reason] of bends) {
    it(`refuses ${name}`, () => {
      expect(() => assertGpv2Order(order(bend), GPV2_VAULT_RELAYER, EXPECT)).toThrow(reason);
      expect(() => assertGpv2Order(order(bend), GPV2_VAULT_RELAYER, EXPECT)).toThrow(/^swap2: CoW order refused — /);
    });
  }
  it("refuses a missing field, another spender, a native source, an unknown chain, and what is not typed data", () => {
    const td = JSON.parse(order()) as {message: Record<string, unknown>};
    expect(() => assertGpv2Order(JSON.stringify({...td, message: without(td.message, "feeAmount")}), GPV2_VAULT_RELAYER, EXPECT)).toThrow(/missing or extra fields/);
    expect(() => assertGpv2Order(order(), OTHER, EXPECT)).toThrow(/not the GPv2 vault relayer/);
    expect(() => assertGpv2Order(order(), undefined, EXPECT)).toThrow(/not the GPv2 vault relayer/);
    expect(() => assertGpv2Order(order(), GPV2_VAULT_RELAYER, {...EXPECT, token: undefined})).toThrow(/sellToken/);
    expect(() => assertGpv2Order(order(), GPV2_VAULT_RELAYER, {...EXPECT, chainId: null})).toThrow(/chainId/);
    expect(() => assertGpv2Order(order(), GPV2_VAULT_RELAYER, {...EXPECT, minDest: "0"})).toThrow(/below the quoted minimum/);
    for (const junk of ["", "{", "null", "[]", "{}", JSON.stringify({domain: [], types: {}, message: {}, primaryType: "Order"})]) {
      expect(() => assertGpv2Order(junk, GPV2_VAULT_RELAYER, EXPECT)).toThrow(/CoW order refused/);
    }
  });
  it("only an Order type that declares sellToken is taken for a GPv2 order", () => {
    expect(isGpv2Order(JSON.stringify({types: {Order: [{name: "maker", type: "address"}]}}))).toBe(false);
    expect(isGpv2Order("{")).toBe(false);
    expect(isGpv2Order("null")).toBe(false);
  });
});

const PERMIT_DOMAIN = {name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC};
const PERMIT = {owner: SELF, spender: GPV2_VAULT_RELAYER, value: "1000000", nonce: "3", deadline: String(NOW + 1200)};
const permit = (b: Bend = {}, now = NOW) => JSON.stringify({
  domain: b.domain ?? PERMIT_DOMAIN, primaryType: b.primaryType ?? "Permit", types: {EIP712Domain: DOMAIN_TYPE, Permit: EIP2612_PERMIT_FIELDS, ...b.types},
  message: {...PERMIT, deadline: String(now + 1200), ...b.message},
});
const PERMIT_EXPECT = {self: SELF, token: USDC, value: 1_000_000n, chainId: 1, deadline: NOW + 1200};

describe("assertGpv2Permit", () => {
  it("accepts the exact allowance for the vault relayer, expiring with the order", () => {
    expect(assertGpv2Permit(permit(), PERMIT_EXPECT)).toEqual({amount: 1_000_000n, deadline: NOW + 1200});
    // A token whose domain has no version.
    const {version: _v, ...noVersion} = PERMIT_DOMAIN;
    expect(() => assertGpv2Permit(permit({domain: noVersion, types: {EIP712Domain: DOMAIN_TYPE.filter((f) => f.name !== "version")}}), PERMIT_EXPECT)).not.toThrow();
  });
  const bends: [string, Bend, RegExp][] = [
    ["another spender", {message: {spender: OTHER}}, /not the GPv2 vault relayer/],
    ["the settlement contract as the spender", {message: {spender: GPV2_SETTLEMENT}}, /not the GPv2 vault relayer/],
    ["another owner", {message: {owner: OTHER}}, /owner is not this account/],
    ["a larger allowance", {message: {value: "1000001"}}, /is not the swap's allowance/],
    ["an unlimited allowance", {message: {value: ((1n << 256n) - 1n).toString()}}, /is not the swap's allowance/],
    ["a longer deadline", {message: {deadline: String(NOW + 1201)}}, /deadline is not the order's expiry/],
    ["a deadline that never comes", {message: {deadline: ((1n << 256n) - 1n).toString()}}, /deadline/],
    ["a bad nonce", {message: {nonce: "x"}}, /nonce/],
    ["an extra field", {message: {allowed: true}}, /missing or extra fields/],
    ["another token", {domain: {...PERMIT_DOMAIN, verifyingContract: WETH}}, /verifying contract is not the source token/],
    ["another chain", {domain: {...PERMIT_DOMAIN, chainId: 8453}}, /chainId is not the source chain/],
    ["a salted domain", {domain: {...PERMIT_DOMAIN, salt: "0x00"}}, /not an EIP-2612 token domain/],
    ["a DAI-style permit", {types: {Permit: [{name: "holder", type: "address"}, {name: "spender", type: "address"}, {name: "nonce", type: "uint256"}, {name: "expiry", type: "uint256"}, {name: "allowed", type: "bool"}]}}, /not the canonical one/],
    ["a Permit2 type", {types: {PermitSingle: [{name: "spender", type: "address"}]}}, /unexpected type/],
    ["another primary type", {primaryType: "Order"}, /primaryType/],
  ];
  for (const [name, bend, reason] of bends) {
    it(`refuses ${name}`, () => {
      expect(() => assertGpv2Permit(permit(bend), PERMIT_EXPECT)).toThrow(reason);
      expect(() => assertGpv2Permit(permit(bend), PERMIT_EXPECT)).toThrow(/^swap2: CoW permit refused — /);
    });
  }
});

const uidOf = (owner: string, validTo = NOW + 1200) => `0x${"ab".repeat(32)}${owner.slice(2).toLowerCase()}${validTo.toString(16).padStart(8, "0")}`;
const cancellation = (uids: unknown, b: Bend = {}) => JSON.stringify({
  domain: {...DOMAIN, ...b.domain}, primaryType: b.primaryType ?? "OrderCancellations", types: {EIP712Domain: DOMAIN_TYPE, OrderCancellations: GPV2_CANCELLATIONS_FIELDS, ...b.types}, message: {orderUids: uids, ...b.message},
});

describe("assertGpv2Cancellation", () => {
  it("accepts a cancellation of this account's own orders", () => {
    expect(assertGpv2Cancellation(cancellation([uidOf(SELF)]), {self: SELF, chainId: 1})).toEqual([uidOf(SELF)]);
  });
  it("refuses another account's order, no order, a malformed UID, another domain, an Order dressed as a cancellation", () => {
    const e = {self: SELF, chainId: 1};
    expect(() => assertGpv2Cancellation(cancellation([uidOf(OTHER)]), e)).toThrow(/does not belong to this account/);
    expect(() => assertGpv2Cancellation(cancellation([uidOf(SELF), uidOf(OTHER)]), e)).toThrow(/does not belong to this account/);
    expect(() => assertGpv2Cancellation(cancellation([]), e)).toThrow(/names no order/);
    expect(() => assertGpv2Cancellation(cancellation("0x"), e)).toThrow(/names no order/);
    expect(() => assertGpv2Cancellation(cancellation(["0x1234"]), e)).toThrow(/not 56 bytes/);
    expect(() => assertGpv2Cancellation(cancellation([uidOf(SELF)], {domain: {chainId: 8453}}), e)).toThrow(/chainId/);
    expect(() => assertGpv2Cancellation(cancellation([uidOf(SELF)], {domain: {verifyingContract: OTHER}}), e)).toThrow(/not GPv2Settlement/);
    expect(() => assertGpv2Cancellation(cancellation([uidOf(SELF)], {message: {extra: 1}}), e)).toThrow(/missing or extra fields/);
    expect(() => assertGpv2Cancellation(order(), e)).toThrow(/^swap2: CoW cancellation refused — /);
  });
});

// ── through the engine, against a provider that is not trusted ──────────────────────────────────────────────────

const now = () => Math.floor(Date.now() / 1000);
const options = {fromToken: "USDC", toToken: WETH, toChain: 1, recipient: SELF, fromTokenAmount: 1_000_000n, minAmountOut: 400n};
const quote = (p: QuoteParams): Quote => ({
  provider: "resting", intentId: "q-1", depositAddress: "", depositMemo: null, sourceAmount: p.amountIn, destAmount: "410", minDestAmount: "400",
  feeUsd: 0, etaSeconds: 30, reliability: 1, validUntilMs: Date.now() + 60_000,
}) as Quote;

function run(build: Partial<UnsignedTx>, over: Partial<CrossChainProvider> = {}, accountOver: Record<string, unknown> = {}) {
  const log: string[] = [];
  const provider: CrossChainProvider = {
    name: "resting", enabled: () => true, supportsRoute: () => true, supportsSameChain: true, getQuote: async (p) => quote(p),
    buildDeposit: async () => ({chain: "eip155:1", to: GPV2_SETTLEMENT, value: "0", chainId: 1, approvalAddress: GPV2_VAULT_RELAYER, typedData: order({}, now()), ...build}),
    registerSignedOrder: async () => { log.push("placed"); },
    trackIntent: async () => ({state: "pending"}),
    ...over,
  };
  const account: Record<string, unknown> = {
    getAddress: async () => SELF, getChainId: async () => 1, getBalance: async () => 10n ** 30n, waitForTransaction: async () => {},
    sendTransaction: async (tx: {to?: string; data?: string}) => {
      log.push(tx.data?.startsWith("0x095ea7b3") ? `approve ${tx.data.slice(34, 74)} ${BigInt(`0x${tx.data.slice(74)}`)}` : `send ${tx.to} ${tx.data?.slice(0, 10)}`);
      return {hash: `0x${"01".repeat(32)}`};
    },
    signTypedData: async (td: {primaryType: string}) => { log.push(`sign ${td.primaryType}`); return `0x${"12".repeat(65)}`; },
    ...accountOver,
  };
  for (const k of Object.keys(account)) if (account[k] === undefined) delete account[k];
  class P extends SingleProviderSwap2 {
    protected readonly provider = provider;
    protected chainSupported(): boolean { return true; }
  }
  const p = new P(account as never, {fromChain: "eip155:1"});
  return {p, account, log, swap: () => p.swap2(options)};
}
const RELAYER = GPV2_VAULT_RELAYER.slice(2).toLowerCase();

describe("a CoW order through the engine", () => {
  it("approves exactly the input to the vault relayer, signs the order, and tracks the id the provider returns", async () => {
    const r = run({}, {registerSignedOrder: async () => ({intentId: "o-9"})});
    const out = await r.swap();
    expect(r.log).toEqual([`approve ${RELAYER} 1000000`, "sign Order"]);
    expect(out.id).toContain("o-9");
    const plain = run({});
    expect((await plain.swap()).id).toContain("q-1");
  });

  it("an allowance target covering the account's other orders is approved; a sufficient allowance is left alone", async () => {
    const more = run({approvalAmount: "3000000"}, {}, {getAllowance: async () => 500_000n});
    await more.swap();
    expect(more.log).toEqual([`approve ${RELAYER} 3000000`, "sign Order", "placed"]);
    const enough = run({approvalAmount: "3000000"}, {}, {getAllowance: async () => 5_000_000n});
    await enough.swap();
    expect(enough.log).toEqual(["sign Order", "placed"]);
  });

  it("an allowance target below the input, unbounded, or not a number is refused", async () => {
    for (const approvalAmount of ["999999", ((1n << 256n) - 1n).toString(), (1n << 255n).toString(), "0x10", "-1", ""]) {
      const r = run({approvalAmount});
      await expect(r.swap(), approvalAmount).rejects.toThrow(/allowance target .* is not a finite amount covering/);
      expect(r.log).toEqual([]);
    }
  });

  it("a permit or an allowance target on anything but a CoW order is refused", async () => {
    const other = JSON.stringify({domain: {name: "X", chainId: 1, verifyingContract: OTHER}, primaryType: "Order", types: {Order: [{name: "maker", type: "address"}]}, message: {maker: SELF}});
    for (const build of [{typedData: other, permit: permit({}, now())}, {typedData: other, approvalAmount: "1000000"}]) {
      const r = run(build);
      await expect(r.swap()).rejects.toThrow();
      expect(r.log).toEqual([]);
    }
    const calldata = run({typedData: undefined, data: "0xdeadbeef", approvalAmount: "1000000"} as never);
    await expect(calldata.swap()).rejects.toThrow();
    expect(calldata.log).toEqual([]);
  });

  it("a bent order is refused before any approval; an account that cannot sign is told so before any approval", async () => {
    for (const message of [{receiver: OTHER}, {buyAmount: "399"}, {feeAmount: "1"}, {sellAmount: "2000000"}, {validTo: now() + 86_400}]) {
      const r = run({typedData: order({message}, now())});
      await expect(r.swap()).rejects.toThrow(/CoW order refused/);
      expect(r.log).toEqual([]);
    }
    const spender = run({approvalAddress: OTHER});
    await expect(spender.swap()).rejects.toThrow(/not the GPv2 vault relayer/);
    const mute = run({}, {}, {signTypedData: undefined});
    await expect(mute.swap()).rejects.toThrow("swap2: a CoW order needs an account with signTypedData");
    expect(mute.log).toEqual([]);
  });

  it("a permit replaces the approval: Permit, then the same order with another appData", async () => {
    const t = now();
    const funded = order({message: {appData: `0x${"22".repeat(32)}`}}, t);
    const seen: string[] = [];
    const r = run({typedData: order({}, t), permit: permit({}, t)}, {
      applyPermit: async (id, sig) => { seen.push(id, sig); return {chain: "eip155:1", to: GPV2_SETTLEMENT, value: "0", chainId: 1, approvalAddress: GPV2_VAULT_RELAYER, typedData: funded}; },
    });
    await r.swap();
    expect(r.log).toEqual(["sign Permit", "sign Order", "placed"]);
    expect(seen).toEqual(["q-1", `0x${"12".repeat(65)}`]);
  });

  it("a permit is not signed for another spender, a larger allowance or a longer life than the order", async () => {
    const t = now();
    for (const message of [{spender: OTHER}, {value: "1000001"}, {deadline: String(t + 86_400)}, {owner: OTHER}]) {
      const r = run({typedData: order({}, t), permit: permit({message}, t)}, {applyPermit: async () => ({chain: "eip155:1", to: GPV2_SETTLEMENT, value: "0"})});
      await expect(r.swap()).rejects.toThrow(/CoW permit refused/);
      expect(r.log).toEqual([]);
    }
  });

  it("after the permit is signed the order may change in appData only", async () => {
    const t = now();
    const base = {chain: "eip155:1", to: GPV2_SETTLEMENT, value: "0", chainId: 1, approvalAddress: GPV2_VAULT_RELAYER};
    const cases: [Partial<UnsignedTx>, RegExp][] = [
      [{...base, typedData: order({message: {buyAmount: "401"}}, t)}, /changed buyAmount/],
      [{...base, typedData: order({message: {validTo: t + 1300}}, t)}, /changed validTo/],
      [{...base, typedData: order({message: {receiver: OTHER}}, t)}, /CoW order refused/],
      [{...base, to: OTHER, typedData: order({}, t)}, /not the reviewed order's build/],
      [{...base, data: "0x12", typedData: order({}, t)}, /not the reviewed order's build/],
      [{...base, value: "1", typedData: order({}, t)}, /not the reviewed order's build/],
      [{...base}, /not the reviewed order's build/],
    ];
    for (const [funded, reason] of cases) {
      const r = run({typedData: order({}, t), permit: permit({}, t)}, {applyPermit: async () => funded as UnsignedTx});
      await expect(r.swap()).rejects.toThrow(reason);
      expect(r.log).toEqual(["sign Permit"]);
    }
  });

  it("without applyPermit, or with a sufficient allowance, the offered permit is ignored", async () => {
    const t = now();
    const noHook = run({typedData: order({}, t), permit: permit({}, t)});
    await noHook.swap();
    expect(noHook.log).toEqual([`approve ${RELAYER} 1000000`, "sign Order", "placed"]);
    const funded = run({typedData: order({}, t), permit: permit({}, t)}, {applyPermit: async () => { throw new Error("unused"); }}, {getAllowance: async () => 1_000_000n});
    await funded.swap();
    expect(funded.log).toEqual(["sign Order", "placed"]);
  });
});

describe("cancelSwap2", () => {
  const ID = "awk1.resting.o-1";
  const typed = () => ({chain: "eip155:1", to: GPV2_SETTLEMENT, value: "0", chainId: 1, typedData: cancellation([uidOf(SELF)])});
  const tx = (over: Partial<UnsignedTx> = {}) => ({chain: "eip155:1", to: GPV2_SETTLEMENT, value: "0", chainId: 1, data: `0x15337bc0${"00".repeat(64)}`, ...over});

  it("off-chain: signs the cancellation of the account's own order and hands it to the provider", async () => {
    const got: string[] = [];
    const r = run({}, {buildCancel: async (_ref, o) => (got.push(`${o.owner} ${o.onchain}`), typed()), registerCancel: async (id, sig) => void got.push(id, sig)});
    expect(await r.p.cancelSwap2(ID, r.account as never)).toEqual({mode: "offchain", id: ID});
    expect(r.log).toEqual(["sign OrderCancellations"]);
    expect(got).toEqual([`${SELF} false`, "o-1", `0x${"12".repeat(65)}`]);
  });

  it("on-chain: sends plain calldata to a contract the provider declared, with no value", async () => {
    const r = run({}, {buildCancel: async () => tx(), cancelTargets: () => [GPV2_SETTLEMENT]});
    expect(await r.p.cancelSwap2(ID, r.account as never, {onchain: true})).toEqual({mode: "onchain", hash: `0x${"01".repeat(32)}`, chain: "eip155:1", id: ID});
    expect(r.log).toEqual([`send ${GPV2_SETTLEMENT} 0x15337bc0`]);
  });

  it("refuses what a cancellation must never be", async () => {
    const approve = `0x095ea7b3${OTHER.slice(2).padStart(64, "0")}${"ff".repeat(32)}`;
    const transfer = `0xa9059cbb${OTHER.slice(2).padStart(64, "0")}${"00".repeat(31)}01`;
    const cases: [string, Partial<CrossChainProvider>, {onchain?: boolean}, RegExp][] = [
      ["another account's order", {buildCancel: async () => ({...typed(), typedData: cancellation([uidOf(OTHER)])}), registerCancel: async () => {}}, {}, /does not belong to this account/],
      ["an order in the cancellation's clothes", {buildCancel: async () => ({...typed(), typedData: order({}, now())}), registerCancel: async () => {}}, {}, /CoW cancellation refused/],
      ["typed data for an on-chain cancel", {buildCancel: async () => typed(), registerCancel: async () => {}}, {onchain: true}, /typed cancellation for an on-chain cancel/],
      ["a transaction when the free cancel was asked", {buildCancel: async () => tx(), cancelTargets: () => [GPV2_SETTLEMENT]}, {}, /only be cancelled by an on-chain transaction/],
      ["an undeclared target", {buildCancel: async () => tx({to: OTHER}), cancelTargets: () => [GPV2_SETTLEMENT]}, {onchain: true}, /is not a contract 'resting' declares/],
      ["no declared targets", {buildCancel: async () => tx()}, {onchain: true}, /declares no cancelTargets/],
      ["an approval", {buildCancel: async () => tx({to: USDC, data: approve}), cancelTargets: () => [USDC]}, {onchain: true}, /moves tokens or grants an allowance/],
      ["a token transfer", {buildCancel: async () => tx({to: USDC, data: transfer}), cancelTargets: () => [USDC]}, {onchain: true}, /moves tokens or grants an allowance/],
      ["native value", {buildCancel: async () => tx({value: "1"}), cancelTargets: () => [GPV2_SETTLEMENT]}, {onchain: true}, /must not carry native value/],
      ["a spender", {buildCancel: async () => tx({approvalAddress: OTHER}), cancelTargets: () => [GPV2_SETTLEMENT]}, {onchain: true}, /typed message or plain calldata/],
      ["a serialized transaction", {buildCancel: async () => tx({serializedTx: "AQID"}), cancelTargets: () => [GPV2_SETTLEMENT]}, {onchain: true}, /typed message or plain calldata/],
      ["another chain than the account's", {buildCancel: async () => tx({chain: "eip155:8453", chainId: 8453}), cancelTargets: () => [GPV2_SETTLEMENT]}, {onchain: true}, /account is bound to/],
      ["a chain id that disagrees with the chain", {buildCancel: async () => tx({chainId: 8453}), cancelTargets: () => [GPV2_SETTLEMENT]}, {onchain: true}, /does not match/],
      ["no calldata", {buildCancel: async () => tx({data: undefined} as never), cancelTargets: () => [GPV2_SETTLEMENT]}, {onchain: true}, /malformed cancel transaction/],
      ["nothing left to cancel", {buildCancel: async () => null}, {}, /nothing to cancel/],
      ["a provider without a cancel step", {}, {}, /has no cancel step/],
    ];
    for (const [name, over, opts, reason] of cases) {
      const r = run({}, over);
      await expect(r.p.cancelSwap2(ID, r.account as never, opts), name).rejects.toThrow(reason);
      expect(r.log, name).toEqual([]);
    }
  });

  it("needs the signing account; the free cancel needs one that signs typed data", async () => {
    const r = run({}, {buildCancel: async () => typed(), registerCancel: async () => {}}, {signTypedData: undefined});
    await expect(r.p.cancelSwap2(ID, r.account as never)).rejects.toThrow(/needs an account with signTypedData/);
    await expect(r.p.cancelSwap2(ID, undefined as never)).rejects.toThrow(/requires the signing account/);
    await expect(r.p.cancelSwap2("awk1.nobody.x", r.account as never)).rejects.toThrow(/no swap2 found/);
  });
});
