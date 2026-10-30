// 2026-10-27 modules scan: the exploit inputs from the report against the engine's own gates. Mocked
// provider + account only — no network, no keys; every refusal asserts that nothing was sent.
import {describe, expect, it} from "vitest";
import {Swap2ValidationError} from "../src/errors.js";
import {createSwap2Handler} from "../src/server.js";
import {redactUrls} from "../src/util.js";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {Swap2EngineConfig} from "../src/swap2/base.js";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "../src/types.js";

const SELF = "0x4444444444444444444444444444444444444444";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const word = (v: string | bigint) => (typeof v === "bigint" ? v.toString(16) : v.replace(/^0x/, "")).padStart(64, "0");
const options = {fromToken: "USDC", toToken: "0xFd086bC7CD5C481DCC9C85EBE478A1C0b69FCbb9", toChain: 42161, recipient: RECIPIENT, fromTokenAmount: 1_000_000n, minAmountOut: 980_000n};

function harness(txRequest: Record<string, unknown>) {
  const sent: unknown[] = [];
  const quote = (params: QuoteParams): Quote => ({
    provider: "scan", intentId: `intent-${Math.random()}`, depositAddress: "", depositMemo: null, txRequest,
    sourceAmount: params.amountIn, destAmount: "990000", minDestAmount: "980000", feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
  } as Quote);
  const provider: CrossChainProvider = {
    name: "scan", enabled: () => true, supportsRoute: () => true,
    getQuote: async (params) => quote(params),
    buildDeposit: async (q) => ({...(q.txRequest as object), chain: "eip155:1", to: q.txRequest!.to!, value: q.txRequest!.value ?? "0"}) as UnsignedTx,
    trackIntent: async () => ({state: "pending"}),
  };
  const account = {getAddress: async () => SELF, getChainId: async () => 1, sendTransaction: async (tx: unknown) => { sent.push(tx); return {hash: "0x1"}; }, waitForTransaction: async () => {}};
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  return {sent, swap: () => new P(account as never, {fromChain: "eip155:1"} as Partial<Swap2EngineConfig> as never).swap2(options)};
}

describe("scan 2026-10-27 modules G1 (F3): the quote-calldata gate reads selectors in any case and refuses undecodable calldata", () => {
  it("an uppercase approve(attacker, max) as the swap call is refused; nothing is sent", async () => {
    const h = harness({to: USDC, data: "0x095EA7B3" + word(ATTACKER) + "F".repeat(64), value: "0", chainId: 1, gasLimit: "60000"});
    await expect(h.swap()).rejects.toBeInstanceOf(Swap2ValidationError);
    expect(h.sent).toHaveLength(0);
  });
  it("calldata that is not hex bytes is refused before anything is sent", async () => {
    const h = harness({to: USDC, data: "0x095ea7b" + word(ATTACKER), value: "0", chainId: 1, gasLimit: "60000"});
    await expect(h.swap()).rejects.toBeInstanceOf(Swap2ValidationError);
    expect(h.sent).toHaveLength(0);
  });
});

// ── G3 (F8, F9, F16): who may receive or spend the source token through a swap's calldata ─────────────────
import {remoteProvider, type RemoteProviderOptions} from "../src/remote.js";
import {remotePinRefusal} from "../src/validate.js";
import {Swap2QuoteError} from "../src/errors.js";

const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const DEPOSIT = "0x5555555555555555555555555555555555555555";
const MAX = (1n << 256n) - 1n;
const approveData = (spender: string, amount: bigint) => "0x095ea7b3" + word(spender) + word(amount);
const transferData = (to: string, amount: bigint) => "0xa9059cbb" + word(to) + word(amount);
const g3options = {...options, fromToken: "USDC"};

/** The quote a provider answers with, deposit-address or calldata. */
const g3quote = (params: QuoteParams, over: Partial<Quote>): Quote => ({
  provider: "scan", intentId: `intent-${Math.random()}`, depositAddress: "", depositMemo: null,
  sourceAmount: params.amountIn, destAmount: "990000", minDestAmount: "980000", feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000, ...over,
} as Quote);
const g3build = (q: Quote): UnsignedTx => {
  if (!q.txRequest) return {chain: "eip155:1", to: q.depositAddress, value: q.sourceAmount};
  const {nativeFee: _fee, ...tx} = q.txRequest;
  return {...tx, chain: "eip155:1", to: tx.to!, value: tx.value ?? "0"};
};
/** Records every send: approve / revoke / transfer / call, with its target. */
function g3account() {
  const sent: Array<{to: string; data?: string}> = [];
  let n = 0;
  return {
    sent,
    account: {
      getAddress: async () => SELF, getChainId: async () => 1, getAllowance: async () => 0n, waitForTransaction: async () => {},
      sendTransaction: async (tx: {to: string; data?: string}) => { sent.push(tx); n += 1; return {hash: `0x${n}`}; },
    },
  };
}
function g3protocol(provider: CrossChainProvider, account: unknown) {
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  return new P(account as never, {fromChain: "eip155:1"} as Partial<Swap2EngineConfig> as never);
}
/** An in-process provider (the app ships its code) answering `over`. */
const local = (over: Partial<Quote>): CrossChainProvider => ({
  name: "scan", enabled: () => true, supportsRoute: () => true, trackIntent: async () => ({state: "pending"}),
  getQuote: async (params) => g3quote(params, over), buildDeposit: async (q) => g3build(q),
});
/** A remoteProvider stub whose backend (a fake fetch) answers `over`. */
function remote(over: Partial<Quote>, opts: Partial<RemoteProviderOptions> = {}) {
  const fetchImpl = (async (url: string, init: {body: string}) => {
    const action = String(url).split("/").at(-1);
    const body = JSON.parse(init.body) as {params?: QuoteParams; quote?: Quote};
    const reply = (v: unknown) => new Response(JSON.stringify(v), {status: 200, headers: {"content-type": "application/json"}});
    if (action === "quote") return reply(g3quote(body.params!, over));
    if (action === "build") return reply(g3build(body.quote!));
    if (action === "preflight") return reply({});
    return new Response("{}", {status: 404});
  }) as unknown as typeof fetch;
  return remoteProvider({name: "scan", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, ...opts});
}
const diamondPins = {callTargets: () => [DIAMOND], spenders: () => [DIAMOND]};

describe("scan 2026-10-27 modules G3: a swap's token calls move only the source token, to addresses the app trusts", () => {
  it("F8: approve(attacker, MAX) as the swap call, with the attacker declared as spender, is refused (local provider)", async () => {
    const {sent, account} = g3account();
    const p = g3protocol(local({txRequest: {to: USDC, data: approveData(ATTACKER, MAX), value: "0", chainId: 1, gasLimit: "60000", approvalAddress: ATTACKER}}), account);
    await expect(p.swap2(g3options)).rejects.toThrow(/an unlimited amount of the source token/);
    expect(sent).toHaveLength(0);
  });

  it("F8: operator and Permit2 approvals are never a swap's main call", async () => {
    const operator = "0xa22cb465" + word(ATTACKER) + word(1n);
    const permit2 = "0x87517c45" + word(USDC) + word(ATTACKER) + word((1n << 160n) - 1n) + word((1n << 48n) - 1n);
    for (const [to, data] of [[USDC, operator], [PERMIT2, permit2]] as const) {
      const {sent, account} = g3account();
      await expect(g3protocol(local({txRequest: {to, data, value: "0", chainId: 1, gasLimit: "60000"}}), account).swap2(g3options)).rejects.toThrow(/never a swap's main call/);
      expect(sent).toHaveLength(0);
    }
  });

  it("F16: cbBTC.transfer(attacker, everything) on a USDC swap, with depositAddress = attacker, is refused: not the source token", async () => {
    const {sent, account} = g3account();
    const p = g3protocol(local({depositAddress: ATTACKER, txRequest: {to: CBBTC, data: transferData(ATTACKER, 10n ** 12n), value: "0", chainId: 1, gasLimit: "60000"}}), account);
    await expect(p.swap2(g3options)).rejects.toThrow(/moves 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf, not the source token/);
    expect(sent).toHaveLength(0);
  });

  it("a token call moving more than the swap amount is refused even to a declared spender", async () => {
    const {sent, account} = g3account();
    const p = g3protocol(local({txRequest: {to: USDC, data: transferData(DIAMOND, 1_000_001n), value: "0", chainId: 1, gasLimit: "60000", approvalAddress: DIAMOND}}), account);
    await expect(p.swap2(g3options)).rejects.toThrow(/covers 1000001 of the source token, more than the swap's 1000000/);
    expect(sent).toHaveLength(0);
  });
});

describe("scan 2026-10-27 modules G3: a remote provider's addresses come from the app's pins, never from its backend", () => {
  it("F9: a remote USDC → ETH route paying the attacker with USDT is refused before anything is approved", async () => {
    const {sent, account} = g3account();
    const route = {txRequest: {to: USDT, data: transferData(ATTACKER, 10n ** 12n), value: "0", chainId: 1, gasLimit: "60000", approvalAddress: ATTACKER}};
    await expect(g3protocol(remote(route, diamondPins), account).swap2(g3options)).rejects.toThrow(/did not pin as a spender/);
    expect(sent).toHaveLength(0);
  });

  it("F8: a remote approve(attacker, MAX) is refused although the backend declared the attacker as spender", async () => {
    const {sent, account} = g3account();
    const route = {txRequest: {to: USDC, data: approveData(ATTACKER, MAX), value: "0", chainId: 1, gasLimit: "60000", approvalAddress: ATTACKER}};
    await expect(g3protocol(remote(route, diamondPins), account).swap2(g3options)).rejects.toBeInstanceOf(Swap2QuoteError);
    expect(sent).toHaveLength(0);
  });

  it("F16: a remote route with depositAddress = attacker and a cbBTC transfer is refused", async () => {
    const {sent, account} = g3account();
    const route = {depositAddress: ATTACKER, txRequest: {to: CBBTC, data: transferData(ATTACKER, 10n ** 12n), value: "0", chainId: 1, gasLimit: "60000"}};
    await expect(g3protocol(remote(route, diamondPins), account).swap2(g3options)).rejects.toThrow(/did not pin as a call target/);
    expect(sent).toHaveLength(0);
  });

  it("fail closed: a remote stub without pins gets no calldata route; its deposit-address routes need the app's opt-in", async () => {
    const diamondRoute = {txRequest: {to: DIAMOND, data: "0xdeadbeef", value: "0", chainId: 1, gasLimit: "60000", approvalAddress: DIAMOND}};
    const unpinned = g3account();
    await expect(g3protocol(remote(diamondRoute), unpinned.account).swap2(g3options)).rejects.toThrow(/did not pin/);
    expect(unpinned.sent).toHaveLength(0);
    // Scan 2026-10-28 F9: a deposit address is the backend's word, so it is refused unless the app opened the stub to
    // deposit-address routes (NEAR Intents, a THORChain / Chainflip Tron vault)…
    const closed = g3account();
    await expect(g3protocol(remote({depositAddress: DEPOSIT}), closed.account).swap2(g3options)).rejects.toThrow(/did not allow deposit-address routes/);
    expect(closed.sent).toHaveLength(0);
    // …and with the opt-in the engine writes transfer(depositAddress, amount) on the source token itself.
    const deposit = g3account();
    await g3protocol(remote({depositAddress: DEPOSIT}, {depositAddressRoutes: true}), deposit.account).swap2(g3options);
    expect(deposit.sent.map((t) => [t.to.toLowerCase(), t.data?.toLowerCase()])).toEqual([[USDC.toLowerCase(), transferData(DEPOSIT, 1_000_000n).toLowerCase()]]);
  });

  it("with the pins (and the app's check of the call, scan 2026-10-30 F3), the pinned route executes: approve the pinned spender for the exact amount, then the call", async () => {
    const {sent, account} = g3account();
    await g3protocol(remote({txRequest: {to: DIAMOND, data: "0xdeadbeef", value: "0", chainId: 1, gasLimit: "60000", approvalAddress: DIAMOND}}, {...diamondPins, verifyQuote: () => null}), account).swap2(g3options);
    expect(sent.map((t) => [t.to.toLowerCase(), t.data?.toLowerCase()])).toEqual([[USDC.toLowerCase(), approveData(DIAMOND, 1_000_000n).toLowerCase()], [DIAMOND.toLowerCase(), "0xdeadbeef"]]);
  });

  it("verifyQuote: the provider's own check runs on the client and its refusal keeps the quote out", async () => {
    const {sent, account} = g3account();
    const route = {txRequest: {to: DIAMOND, data: "0xdeadbeef", value: "0", chainId: 1, gasLimit: "60000", approvalAddress: DIAMOND}};
    await expect(g3protocol(remote(route, {...diamondPins, verifyQuote: () => "calldata pays someone else"}), account).swap2(g3options)).rejects.toThrow(/fails this app's own check — calldata pays someone else/);
    expect(sent).toHaveLength(0);
  });

  it("remotePinRefusal judges only remote stubs on EVM", () => {
    const q = {txRequest: {to: ATTACKER, data: "0x01", approvalAddress: ATTACKER}} as unknown as Quote;
    expect(remotePinRefusal({name: "x"}, q, "eip155:1")).toBeNull()
    expect(remotePinRefusal({name: "x", remote: true}, q, "ton:-239")).toBeNull()
    expect(remotePinRefusal({name: "x", remote: true, ...diamondPins}, q, "eip155:1")).toMatch(/approves .* did not pin as a spender/);
    expect(remotePinRefusal({name: "x", remote: true, verifiesQuotes: true, ...diamondPins}, {txRequest: {to: DIAMOND, data: "0x01", approvalAddress: DIAMOND}} as unknown as Quote, "eip155:1")).toBeNull();
  });

  it("scan 2026-10-28 F9: remotePinRefusal drops a remote deposit-address or plain-value route unless the app opted in, on every chain", () => {
    const deposit = {depositAddress: ATTACKER} as unknown as Quote;
    const plain = {depositAddress: "", txRequest: {to: ATTACKER, value: "1"}} as unknown as Quote;
    for (const chain of ["eip155:1", "tron:728126428", "bitcoin:000000000019d6689c085ae165831e93"]) {
      expect(remotePinRefusal({name: "x", remote: true, ...diamondPins}, deposit, chain)).toMatch(/did not allow deposit-address routes/);
      expect(remotePinRefusal({name: "x", remote: true}, deposit, chain)).toMatch(/did not allow deposit-address routes/);
      expect(remotePinRefusal({name: "x", remote: true, depositAddressRoutes: true}, deposit, chain)).toBeNull();
      expect(remotePinRefusal({name: "x"}, deposit, chain)).toBeNull();
    }
    expect(remotePinRefusal({name: "x", remote: true, ...diamondPins}, plain, "eip155:1")).toMatch(/pays 0x[0-9a-fA-F]{40}, an address the backend named/);
    expect(remotePinRefusal({name: "x", remote: true, depositAddressRoutes: true, ...diamondPins}, plain, "eip155:1")).toBeNull();
    // An order or cell-body route names no deposit address and is judged at build time.
    expect(remotePinRefusal({name: "x", remote: true}, {depositAddress: ""} as unknown as Quote, "ton:-239")).toBeNull();
    // A serialized transaction is not a plain send.
    expect(remotePinRefusal({name: "x", remote: true}, {depositAddress: "", txRequest: {serializedTx: "AQ==", value: "0"}} as unknown as Quote, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBeNull();
  });
});

// ── G4 (F4): an EIP-712 payload is signed only when it is the swap's own order ─────────────────────────────────────────
const LOP = "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9";
const ORDER_TYPE = [
  {name: "salt", type: "uint256"}, {name: "maker", type: "address"}, {name: "receiver", type: "address"}, {name: "makerAsset", type: "address"},
  {name: "takerAsset", type: "address"}, {name: "makingAmount", type: "uint256"}, {name: "takingAmount", type: "uint256"}, {name: "makerTraits", type: "uint256"},
];
const order = (over: {domain?: Record<string, unknown>; message?: Record<string, unknown>; primaryType?: string; types?: Record<string, unknown>} = {}) => JSON.stringify({
  domain: {name: "1inch Limit Order Protocol", version: "4", chainId: "0x1", verifyingContract: LOP, ...over.domain},
  types: over.types ?? {EIP712Domain: [], Order: ORDER_TYPE},
  primaryType: over.primaryType ?? "Order",
  message: {salt: "0x1", maker: SELF, receiver: "0x2b654e50c83801ac79ce3011ff94245e2937b1b7", makerAsset: USDC, takerAsset: USDT, makingAmount: "0xf4240", takingAmount: "990000", makerTraits: "0x0", ...over.message},
});
const permit = JSON.stringify({
  domain: {name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC},
  types: {Permit: [{name: "owner", type: "address"}, {name: "spender", type: "address"}, {name: "value", type: "uint256"}, {name: "nonce", type: "uint256"}, {name: "deadline", type: "uint256"}]},
  primaryType: "Permit",
  message: {owner: SELF, spender: ATTACKER, value: MAX.toString(), nonce: "0", deadline: MAX.toString()},
});
/** Records sends, signatures and registrations. */
function typedAccount() {
  const sent: unknown[] = [], signed: unknown[] = [];
  return {sent, signed, account: {
    getAddress: async () => SELF, getChainId: async () => 1, getAllowance: async () => 0n, waitForTransaction: async () => {},
    sendTransaction: async (tx: unknown) => { sent.push(tx); return {hash: `0x${sent.length}`}; },
    signTypedData: async (td: unknown) => { signed.push(td); return "0x" + "11".repeat(65); },
  }};
}
const typedLocal = (typedData: string, approvalAddress: string | null = LOP, registered: string[] = []): CrossChainProvider => ({
  name: "scan", enabled: () => true, supportsRoute: () => true, trackIntent: async () => ({state: "pending"}),
  getQuote: async (params) => g3quote(params, {}),
  buildDeposit: async () => ({chain: "eip155:1", to: LOP, value: "0", chainId: 1, ...(approvalAddress ? {approvalAddress} : {}), typedData}),
  registerSignedOrder: async (_id, sig) => { registered.push(sig); },
});
function typedRemote(typedData: string, approvalAddress: string, opts: Partial<RemoteProviderOptions> = {}) {
  const registered: unknown[] = [];
  const fetchImpl = (async (url: string, init: {body: string}) => {
    const action = String(url).split("/").at(-1);
    const body = JSON.parse(init.body) as {params?: QuoteParams};
    const reply = (v: unknown) => new Response(JSON.stringify(v), {status: 200, headers: {"content-type": "application/json"}});
    if (action === "quote") return reply(g3quote(body.params!, {}));
    if (action === "build") return reply({chain: "eip155:1", to: LOP, value: "0", chainId: 1, approvalAddress, typedData});
    if (action === "register") { registered.push(body); return reply({}); }
    return reply({});
  }) as unknown as typeof fetch;
  return {registered, provider: remoteProvider({name: "scan", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, callTargets: () => [], spenders: () => [LOP], ...opts})};
}

describe("scan 2026-10-27 modules G4 (F4): typed data from a provider is signed only when it is the swap's own order", () => {
  it("a remote build whose typedData is an EIP-2612 Permit to the attacker is refused; nothing approved, signed or registered", async () => {
    // A permissive app validator: the engine's own order check is what refuses it.
    const t = typedAccount();
    const r = typedRemote(permit, LOP, {verifyBuild: () => null});
    await expect(g3protocol(r.provider, t.account).swap2(g3options)).rejects.toThrow(/typed order refused — Permit is a token approval/);
    expect([t.sent, t.signed, r.registered]).toEqual([[], [], []]);
    // …and with the permit's own token as the "settlement contract": not a spender the app pinned.
    const u = typedAccount();
    await expect(g3protocol(typedRemote(permit, USDC, {verifyBuild: () => null}).provider, u.account).swap2(g3options)).rejects.toThrow(/did not pin as a spender/);
    expect([u.sent, u.signed]).toEqual([[], []]);
  });

  it("scan 2026-10-28 F6: a remote typed order is signed only after the app's own validator ran on it", async () => {
    // The swap's own order, well formed for the engine — but no verifyBuild: its price, receiver and traits are unchecked.
    const t = typedAccount();
    const r = typedRemote(order(), LOP);
    await expect(g3protocol(r.provider, t.account).swap2(g3options)).rejects.toThrow(/asks to sign a typed order, which needs the app's own validator/);
    expect([t.sent, t.signed, r.registered]).toEqual([[], [], []]);
    // With a validator that passes it, the same order is approved, signed and registered.
    const u = typedAccount();
    const v = typedRemote(order(), LOP, {verifyBuild: () => null});
    await g3protocol(v.provider, u.account).swap2(g3options);
    expect([u.sent.length, u.signed.length, v.registered.length]).toEqual([1, 1, 1]);
  });

  it("refuses Permit2 permits, other typed messages and orders that are not this swap's", async () => {
    const permitSingle = JSON.parse(permit) as Record<string, unknown>;
    const cases: Array<[string, string, string | null, RegExp]> = [
      ["PermitSingle", JSON.stringify({...permitSingle, primaryType: "PermitSingle", types: {PermitSingle: []}}), LOP, /PermitSingle is a token approval/],
      ["another primary type", order({primaryType: "Swap", types: {Swap: ORDER_TYPE}}), LOP, /primaryType Swap is not an order/],
      ["maker", order({message: {maker: ATTACKER}}), LOP, /maker is not this account/],
      ["maker asset", order({message: {makerAsset: USDT}}), LOP, /makerAsset is not the source token/],
      ["making amount", order({message: {makingAmount: "0xf4241"}}), LOP, /makingAmount 0xf4241 is not the swap's 1000000/],
      ["verifying contract", order({domain: {verifyingContract: ATTACKER}}), LOP, /verifyingContract .* is not the settlement contract/],
      ["no spender declared", order(), null, /verifyingContract .* is not the settlement contract/],
      ["chain id", order({domain: {chainId: "0x2105"}}), LOP, /chainId is not the source chain/],
      ["schema without the fields", order({types: {Order: [{name: "salt", type: "uint256"}]}}), LOP, /no maker \/ makerAsset \/ makingAmount/],
    ];
    for (const [what, td, approval, why] of cases) {
      const t = typedAccount();
      const registered: string[] = [];
      const outcome = await g3protocol(typedLocal(td, approval, registered), t.account).swap2(g3options).then(() => "RESOLVED", (e: Error) => e.message);
      if (outcome === "RESOLVED") throw new Error(`case '${what}' was not refused`);
      expect(outcome, what).toMatch(why);
      expect([t.sent, t.signed, registered], what).toEqual([[], [], []]);
    }
  });

  it("the swap's own order is approved for the input, signed and registered (hex or decimal amounts)", async () => {
    for (const makingAmount of ["0xf4240", "1000000"]) {
      const t = typedAccount();
      const registered: string[] = [];
      await g3protocol(typedLocal(order({message: {makingAmount}}), LOP, registered), t.account).swap2(g3options);
      expect(t.sent.map((x) => (x as {data?: string}).data?.toLowerCase())).toEqual([approveData(LOP, 1_000_000n).toLowerCase()]);
      expect(t.signed).toHaveLength(1);
      expect(registered).toHaveLength(1);
    }
  });

  it("remoteProvider: an absolute baseUrl must be https (a same-origin path, or the dev flag, otherwise)", () => {
    expect(() => remoteProvider({name: "x", baseUrl: "http://backend.example/swap2"})).toThrow(/must be https/);
    expect(() => remoteProvider({name: "x", baseUrl: "ws://backend.example/swap2"})).toThrow(/must be https/);
    expect(() => remoteProvider({name: "x", baseUrl: "/api/v2/swap2"})).not.toThrow();
    expect(() => remoteProvider({name: "x", baseUrl: "https://backend.example/swap2"})).not.toThrow();
    expect(() => remoteProvider({name: "x", baseUrl: "http://localhost:3000/api/v2/swap2", allowInsecureBaseUrl: true})).not.toThrow();
  });

  it("remoteProvider: a baseUrl with leading spaces or no scheme (//host) is not a way around https (2026-10-28 review)", () => {
    for (const baseUrl of [" http://api.example.com/swap2", "\thttp://x/swap2", "//api.example.com/swap2", "\\\\api.example.com/swap2"]) {
      expect(() => remoteProvider({name: "x", baseUrl}), JSON.stringify(baseUrl)).toThrow(/must be https:\/\/ or a same-origin path/);
    }
    expect(() => remoteProvider({name: "x", baseUrl: "  https://api.example.com/swap2  "})).not.toThrow();
    expect(() => remoteProvider({name: "x", baseUrl: "/api/swap2"})).not.toThrow();
    expect(() => remoteProvider({name: "x", baseUrl: "//localhost:3000/swap2", allowInsecureBaseUrl: true})).not.toThrow();
  });

  it("verifyBuild: the provider's own check of the build runs on the client before anything is approved", async () => {
    const t = typedAccount();
    const r = typedRemote(order(), LOP, {verifyBuild: () => "salt does not commit the order extension"});
    await expect(g3protocol(r.provider, t.account).swap2(g3options)).rejects.toThrow(/the build fails this app's own check — salt does not commit/);
    expect([t.sent, t.signed, r.registered]).toEqual([[], [], []]);
  });
});

// G11 (F34): `redactUrls` ran an unbounded-scheme regex from every word boundary, and the server ran it over a provider's
// whole refusal or error before cutting it to 300 characters — text an API controls ("a.a.a…") cost quadratic time.
describe("scan 2026-10-27 modules G11 (F34): text a client sees is cut before the URL pass, and the pass is linear", () => {
  const KEYED = "https://base-mainnet.example-rpc.io/v2/sk_live_9f8e7d6c5b4a";
  const timed = async <T>(fn: () => T | Promise<T>): Promise<{value: T; ms: number}> => {
    const t0 = performance.now();
    const value = await fn();
    return {value, ms: performance.now() - t0};
  };
  const PARAMS: QuoteParams = {sourceChain: "eip155:1", sourceToken: "USDC", destChain: "eip155:1", destToken: USDC, amountIn: "1000000", destAddress: SELF, refundAddress: SELF, dry: false};
  function handlerWith(text: string) {
    const provider: CrossChainProvider = {
      name: "mock", enabled: () => true, supportsRoute: () => true,
      getQuote: async (params) => { params.onRefusal?.(`mock: ${text}`); return null; },
      buildDeposit: async () => { throw new Error(`mock: ${text}`); },
      trackIntent: async () => ({state: "pending"}),
    };
    return createSwap2Handler({providers: [provider], sealSecret: "s".repeat(32), guard: () => {}});
  }

  it("64 KB of scheme characters: redactUrls and the server's refusal well under 100 ms (was quadratic)", async () => {
    const text = "a.".repeat(32_768);
    expect((await timed(() => redactUrls(text))).ms).toBeLessThan(100);
    const {value, ms} = await timed(() => handlerWith(text)("quote", {provider: "mock", params: PARAMS}, null));
    expect(ms).toBeLessThan(100);
    expect(((value.body as {noQuote: string}).noQuote).length).toBeLessThanOrEqual(300);
  });

  it("1 MB inputs of every hostile shape: well under 100 ms, refusals and build errors at most 300 characters, no URL", async () => {
    for (const text of ["a.".repeat(500_000), "a".repeat(1_000_000), "a://".repeat(250_000), "://".repeat(333_333), "a:// ".repeat(200_000), `${"x".repeat(999_000)} ${KEYED}`]) {
      expect((await timed(() => redactUrls(text))).ms).toBeLessThan(100);
      const handle = handlerWith(text);
      const refusal = await timed(() => handle("quote", {provider: "mock", params: PARAMS}, null));
      expect(refusal.ms).toBeLessThan(100);
      expect((refusal.value.body as {noQuote: string}).noQuote.length).toBeLessThanOrEqual(300);
      expect(JSON.stringify(refusal.value.body)).not.toContain("sk_live");
    }
  });

  it("replaces exactly what the bounded regex would, on 20 000 random strings (seeded)", () => {
    const REFERENCE = /[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>]+/gi;
    const alphabet = ["a", "Z", "h", "s", "1", ".", "+", "-", ":", "/", "//", "://", " ", "\n", "\u00a0", '"', "'", "<", ">", "(", "é", "_", "https://k.example/v2/KEY"];
    let seed = 0x5eed;
    const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let n = 0; n < 20_000; n++) {
      let text = "";
      for (let len = Math.floor(rand() * 48); len > 0; len--) text += alphabet[Math.floor(rand() * alphabet.length)];
      if (n % 7 === 0) text = `${"w".repeat(Math.floor(rand() * 40))}${text}`; // long words before a scheme
      expect(redactUrls(text), JSON.stringify(text)).toBe(text.replace(REFERENCE, "<url>"));
    }
  });

  it("URLs still go: keyed RPC URLs, one glued to a long word, one cut by the window", async () => {
    expect(redactUrls(`no RPC answered (${KEYED})`)).toBe("no RPC answered (<url>"); // a URL runs to whitespace or a quote, as before
    expect(redactUrls(`${"w".repeat(40)}${KEYED} failed`)).toMatch(/<url> failed$/);
    const cut = await handlerWith(`${"z ".repeat(1_010)}${KEYED}`)("quote", {provider: "mock", params: PARAMS}, null);
    expect(JSON.stringify(cut.body)).not.toContain("sk_live");
  });
});
