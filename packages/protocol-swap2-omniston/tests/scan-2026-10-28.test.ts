// Scan 2026-10-28, F6: a remote Omniston EVM typed order (1inch LOP v4) was signed with takingAmount, receiver,
// makerTraits and the extension unbound — the engine checked only the domain, the maker and the input. The engine now
// signs a remote typed order only after the app's verifyBuild ran, and omnistonVerifyBuild opens it with the order
// extension the build carries. The repro's order and its variants are refused before anything is approved or signed;
// the live EVM → TON and EVM → EVM orders still execute through the real provider behind the swap2 server handler,
// remoteProvider + omnistonPins + omnistonVerifyBuild, and the engine.
import "../src/buffer-global.js";
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {getAddress, keccak256, toHex} from "viem";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {omnistonPins, omnistonProvider, omnistonVerifyBuild} from "../src/provider.js";
import {AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS, AUDITED_OMNISTON_SETTLEMENT_CONTRACTS, createOmnistonTonValidators} from "../src/validators/index.js";

type Fixture = {
  chainId: number;
  quoteUpdated: {quoteId: string; rfqId: string; quoteTimestamp: number; outputUnits: string};
  buildRequest: {ownerSrcAddress: string; traderDstAddress: string; secretHex: string};
  payload: {typedData: string; orderExtensionHex: string; serializedOrderDetailsHex: string};
};
const evmTon = JSON.parse(readFileSync(new URL("./fixtures/live-evm-ton-2026-10-16.json", import.meta.url), "utf8")).chains as Record<string, Fixture>;
const evmEvm = JSON.parse(readFileSync(new URL("./fixtures/live-evm-evm-2026-10-20.json", import.meta.url), "utf8")).chains as Record<string, Fixture>;
const ATTACKER = "0xa77ac3e5a77ac3e5a77ac3e5a77ac3e5a77ac3e5";
const USDT_TON = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));

/** Every live order: source chain and token symbol, destination chain, token and recipient. */
const corridors: Array<{name: string; fx: Fixture; from: string; token: string; toChain: string; toToken: string}> = [
  {name: "ethereum → TON", fx: evmTon.ethereum!, from: "eip155:1", token: "USDT", toChain: "ton:-239", toToken: USDT_TON},
  {name: "bnb → TON", fx: evmTon.bnb!, from: "eip155:56", token: "USDT", toChain: "ton:-239", toToken: USDT_TON},
  {name: "polygon → TON", fx: evmTon.polygon!, from: "eip155:137", token: "USDT", toChain: "ton:-239", toToken: USDT_TON},
  {name: "arbitrum → TON", fx: evmTon.arbitrum!, from: "eip155:42161", token: "USDT0", toChain: "ton:-239", toToken: USDT_TON},
  {name: "avalanche → TON", fx: evmTon.avalanche!, from: "eip155:43114", token: "USDT", toChain: "ton:-239", toToken: USDT_TON},
  {name: "base → TON", fx: evmTon.base!, from: "eip155:8453", token: "USDT", toChain: "ton:-239", toToken: USDT_TON},
  {name: "base → arbitrum", fx: evmEvm.baseToArbitrum!, from: "eip155:8453", token: "USDC", toChain: "eip155:42161", toToken: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"},
  {name: "plasma → base", fx: evmEvm.plasmaToBase!, from: "eip155:9745", token: "USDT0", toChain: "eip155:8453", toToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"},
];

function observable<T>(events: T[]) {
  return {subscribe(o: {next: (e: T) => void; complete?: () => void}) { for (const e of events) o.next(e); o.complete?.(); return {unsubscribe() {}}; }};
}
/** The Omniston SDK client answering with the live quote and order payload. */
function clientFor(fx: Fixture) {
  const calls: Record<string, unknown[]> = {};
  const q = structuredClone(fx.quoteUpdated);
  return {
    calls,
    requestForQuote: () => observable([{$case: "ack", value: {rfqId: q.rfqId}}, {$case: "quoteUpdated", rfqId: q.rfqId, value: q}]),
    async evmBuildOrderPayload() {
      return {typedData: fx.payload.typedData, orderExtension: hex(fx.payload.orderExtensionHex), serializedOrderDetails: hex(fx.payload.serializedOrderDetailsHex)};
    },
    async orderRegisterSignedOrder(request: unknown) { (calls.orderRegisterSignedOrder ??= []).push(request); },
    orderTrack: () => observable([]),
    async orderDiscloseHtlcSecret() {},
    tonBuildEscrowTransfer() { throw new Error("EVM-source orders never build a TON escrow"); },
  };
}

/** The live clock and the fixed secret the payloads were built with. */
function pin(fx: Fixture) {
  vi.useFakeTimers({toFake: ["Date"], now: (fx.quoteUpdated.quoteTimestamp + 5) * 1000});
  const secret = hex(fx.buildRequest.secretHex);
  const real = crypto.getRandomValues.bind(crypto);
  vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => (array.length === 32 ? (array.set(secret), array) : real(array))) as never);
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The backend: the real provider behind the real swap2 handler; `tamper` rewrites its build answer (the attacker). */
function backend(fx: Fixture, tamper?: (tx: UnsignedTx) => UnsignedTx) {
  const client = clientFor(fx);
  const real = omnistonProvider({
    client: client as never, quoteSettleMs: 0, maxHtlcExecutions: 1,
    trustedSettlementContracts: AUDITED_OMNISTON_SETTLEMENT_CONTRACTS, trustedEvmOrderProtocols: AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS,
    validateEvmInputPosition: () => true, validateTonOutputPosition: () => true, validateEvmOutputPosition: () => true,
  });
  const handle = createSwap2Handler<string>({providers: [real], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const action = String(url).split("/").pop()!;
    const res = await handle(action, JSON.parse(String(init.body)), "alice");
    const body = action === "build" && tamper && res.status === 200 ? tamper(res.body as UnsignedTx) : res.body;
    return new Response(JSON.stringify(body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
  return {client, fetchImpl};
}

/** The app: the remote stub as documented, under the engine, with an account that records approvals and signatures. */
function app(c: (typeof corridors)[number], fetchImpl: typeof fetch, verify = true) {
  const owner = c.fx.buildRequest.ownerSrcAddress;
  const sent: unknown[] = [], signed: unknown[] = [];
  const account = {
    getAddress: async () => owner, getChainId: async () => c.fx.chainId, getAllowance: async () => 0n, waitForTransaction: async () => {},
    sendTransaction: async (tx: unknown) => { sent.push(tx); return {hash: `0x${String(sent.length).padStart(64, "0")}`}; },
    signTypedData: async (td: unknown) => { signed.push(td); return `0x${"ab".repeat(65)}`; },
  };
  const provider: CrossChainProvider = remoteProvider({
    name: "omniston", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl,
    ...omnistonPins(AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS),
    ...(verify ? {verifyBuild: omnistonVerifyBuild({...createOmnistonTonValidators()})} : {}),
  });
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  const p = new P(account as never, {fromChain: c.from} as never);
  const min = (BigInt(c.fx.quoteUpdated.outputUnits) * 99n) / 100n;
  const swap = () => p.swap2({fromToken: c.token, toToken: c.toToken, toChain: c.toChain, recipient: c.fx.buildRequest.traderDstAddress, fromTokenAmount: BigInt(JSON.parse(c.fx.payload.typedData).message.makingAmount), minAmountOut: min} as never);
  return {sent, signed, swap};
}

/** The build's typed order with message fields replaced. */
const withMessage = (over: Record<string, string>) => (tx: UnsignedTx): UnsignedTx => {
  const td = JSON.parse(tx.typedData!);
  Object.assign(td.message, over);
  return {...tx, typedData: JSON.stringify(td)};
};
/** A different extension, with the salt re-committed to it — what a backend writing its own order would send. */
const withExtension = (edit: (ext: Uint8Array) => void) => (tx: UnsignedTx): UnsignedTx => {
  const ext = hex(tx.orderExtension!.slice(2));
  edit(ext);
  const td = JSON.parse(tx.typedData!);
  const mask = (1n << 160n) - 1n;
  td.message.salt = toHex((BigInt(td.message.salt) & ~mask) | (BigInt(keccak256(ext)) & mask));
  return {...tx, typedData: JSON.stringify(td), orderExtension: `0x${Buffer.from(ext).toString("hex")}`};
};
const flip = (bytes: Uint8Array, at: number) => { bytes[at] = (bytes[at] ?? 0) ^ 1; };
/** Start of extension field `i` (offsets packed big-endian, field i ends at word 28 - 4i). */
const fieldStart = (ext: Uint8Array, i: number) => (i === 0 ? 0 : new DataView(ext.buffer, ext.byteOffset).getUint32(28 - (i - 1) * 4, false)) + 32;

describe("scan 2026-10-28 F6: a remote Omniston EVM typed order is opened on the client before it is signed", () => {
  const BASE = corridors.find((c) => c.name === "base → TON")!;
  const BASE_ARB = corridors.find((c) => c.name === "base → arbitrum")!;

  it("the repro's order — takingAmount 1, receiver = attacker, makerTraits 0 — is refused, with or without the extension; nothing approved or signed", async () => {
    for (const c of [BASE, BASE_ARB]) {
      for (const keepExtension of [true, false]) {
        pin(c.fx);
        const evil = withMessage({takingAmount: "1", receiver: ATTACKER, makerTraits: "0"});
        const b = backend(c.fx, (tx) => { const t = evil(tx); if (!keepExtension) delete t.orderExtension; return t; });
        const a = app(c, b.fetchImpl);
        await expect(a.swap(), c.name).rejects.toThrow(/fails this app's own check/);
        expect([a.sent, a.signed, b.client.calls.orderRegisterSignedOrder ?? []], c.name).toEqual([[], [], []]);
        vi.useRealTimers();
        vi.restoreAllMocks();
      }
    }
  });

  it("each economic field is bound: price, receiver, traits, expiry, extension target, salt, TON recipient, destination", async () => {
    const cases: Array<[string, (typeof corridors)[number], (tx: UnsignedTx) => UnsignedTx, RegExp]> = [
      ["takingAmount 1", BASE, withMessage({takingAmount: "1"}), /takingAmount 1 is below the quote's minimum/],
      ["receiver = attacker", BASE, withMessage({receiver: ATTACKER}), /receiver is not the resolver its extension whitelists/],
      ["makerTraits 0 (no extension, open)", BASE, withMessage({makerTraits: "0"}), /makerTraits flags/],
      ["multiple fills", BASE, (tx) => withMessage({makerTraits: toHex(BigInt(JSON.parse(tx.typedData!).message.makerTraits) | (1n << 254n))})(tx), /makerTraits flags/],
      ["an allowed sender", BASE, (tx) => withMessage({makerTraits: toHex(BigInt(JSON.parse(tx.typedData!).message.makerTraits) | 1n)})(tx), /restrict the taker/],
      ["an expiry years away", BASE, (tx) => withMessage({makerTraits: toHex(BigInt(JSON.parse(tx.typedData!).message.makerTraits) | (((1n << 40n) - 1n) << 80n))})(tx), /expiry/],
      ["takerAsset = makerAsset", BASE, (tx) => withMessage({takerAsset: JSON.parse(tx.typedData!).message.makerAsset})(tx), /takerAsset is the makerAsset/],
      ["no extension", BASE, (tx) => { const t = {...tx}; delete t.orderExtension; return t; }, /no order extension/],
      ["an extension the salt does not commit", BASE, (tx) => ({...tx, orderExtension: tx.orderExtension!.slice(0, -2) + "00"}), /salt does not commit/],
      ["the escrow target = attacker", BASE, withExtension((ext) => { for (const i of [2, 3, 7]) ext.set(hex(ATTACKER.slice(2)), fieldStart(ext, i)); }), /not a trusted escrow factory/],
      ["the TON recipient", BASE, withExtension((ext) => { flip(ext, ext.length - 131 + 34); }), /EVM→TON address does not match/],
      ["the destination chain", BASE_ARB, withExtension((ext) => { const at = fieldStart(ext, 7) + 20 + 20 + 20 + 2 + 1 + 2 + 1 + 4 + 1 + 12 + 32 + 31; flip(ext, at); }), /another destination chain or token/],
      ["the auction profile", BASE, withExtension((ext) => { for (const i of [2, 3]) flip(ext, fieldStart(ext, i) + 20 + 3 + 4 + 4); }), /pinned v1beta8 profile/],
      ["a typed message with an extra field", BASE, withMessage({extra: "1"}), /not exactly a v4 Order/],
    ];
    for (const [what, c, tamper, why] of cases) {
      pin(c.fx);
      const b = backend(c.fx, tamper);
      const a = app(c, b.fetchImpl);
      const outcome = await a.swap().then(() => "RESOLVED", (e: Error) => e.message);
      expect(outcome, what).toMatch(why);
      expect([a.sent, a.signed], what).toEqual([[], []]);
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("without verifyBuild the engine refuses a remote typed order, even the live one", async () => {
    pin(BASE.fx);
    const b = backend(BASE.fx);
    const a = app(BASE, b.fetchImpl, false);
    await expect(a.swap()).rejects.toThrow(/asks to sign a typed order, which needs the app's own validator/);
    expect([a.sent, a.signed]).toEqual([[], []]);
  });

  for (const c of corridors) {
    it(`corridor ${c.name}: the live order executes through the server handler, remoteProvider + pins + verifyBuild and the engine`, async () => {
      pin(c.fx);
      const b = backend(c.fx);
      const a = app(c, b.fetchImpl);
      await a.swap();
      const td = JSON.parse(c.fx.payload.typedData) as {domain: {verifyingContract: string}; message: {makerAsset: string}};
      // One exact approval of the order protocol on the source token, one signature, the order registered with Omniston.
      expect(a.sent.map((t) => getAddress((t as {to: string}).to))).toEqual([getAddress(td.message.makerAsset)]);
      expect(a.signed).toHaveLength(1);
      expect(b.client.calls.orderRegisterSignedOrder).toHaveLength(1);
    });
  }

  it("omnistonVerifyBuild passes every live order the provider builds, and refuses one without its request", async () => {
    for (const c of corridors) {
      pin(c.fx);
      const real = omnistonProvider({
        client: clientFor(c.fx) as never, quoteSettleMs: 0, maxHtlcExecutions: 1,
        trustedSettlementContracts: AUDITED_OMNISTON_SETTLEMENT_CONTRACTS, trustedEvmOrderProtocols: AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS,
        validateEvmInputPosition: () => true, validateTonOutputPosition: () => true, validateEvmOutputPosition: () => true,
      });
      const params: QuoteParams = {sourceChain: c.from, sourceToken: c.token, destChain: c.toChain, destToken: c.toToken,
        amountIn: BigInt(JSON.parse(c.fx.payload.typedData).message.makingAmount).toString(), destAddress: c.fx.buildRequest.traderDstAddress, refundAddress: c.fx.buildRequest.ownerSrcAddress, slippageBps: 100, dry: false};
      const q = (await real.getQuote(params)) as Quote;
      expect(q, c.name).not.toBeNull();
      const tx = await real.buildDeposit(q);
      const verify = omnistonVerifyBuild({...createOmnistonTonValidators()});
      expect(await verify(q, tx, params), c.name).toBeNull();
      expect(await verify(q, tx), c.name).toMatch(/request this quote answered is unknown/);
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
