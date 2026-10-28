// 2026-10-27 modules scan: the exploit inputs from the report against the engine's own gates. Mocked
// provider + account only — no network, no keys; every refusal asserts that nothing was sent.
import {describe, expect, it} from "vitest";
import {Swap2ValidationError} from "../src/errors.js";
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

  it("fail closed: a remote stub without pins gets no calldata route; its deposit-address routes still work", async () => {
    const diamondRoute = {txRequest: {to: DIAMOND, data: "0xdeadbeef", value: "0", chainId: 1, gasLimit: "60000", approvalAddress: DIAMOND}};
    const unpinned = g3account();
    await expect(g3protocol(remote(diamondRoute), unpinned.account).swap2(g3options)).rejects.toThrow(/did not pin/);
    expect(unpinned.sent).toHaveLength(0);
    // A deposit address needs no pin: the engine writes transfer(depositAddress, amount) on the source token itself.
    const deposit = g3account();
    await g3protocol(remote({depositAddress: DEPOSIT}), deposit.account).swap2(g3options);
    expect(deposit.sent.map((t) => [t.to.toLowerCase(), t.data?.toLowerCase()])).toEqual([[USDC.toLowerCase(), transferData(DEPOSIT, 1_000_000n).toLowerCase()]]);
  });

  it("with the pins, the pinned route executes: approve the pinned spender for the exact amount, then the call", async () => {
    const {sent, account} = g3account();
    await g3protocol(remote({txRequest: {to: DIAMOND, data: "0xdeadbeef", value: "0", chainId: 1, gasLimit: "60000", approvalAddress: DIAMOND}}, diamondPins), account).swap2(g3options);
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
    expect(remotePinRefusal({name: "x", remote: true, ...diamondPins}, {txRequest: {to: DIAMOND, data: "0x01", approvalAddress: DIAMOND}} as unknown as Quote, "eip155:1")).toBeNull();
  });
});
