// Scan 2026-10-27 (modules), F4: the engine now signs a provider's EIP-712 payload only when it is the swap's own
// Limit Order Protocol order (maker = this account, the source token, the exact input, the approved settlement
// contract). The live Omniston orders captured on 2026-10-16 and 2026-10-20 must still be signed as they are — hex
// amounts, lowercase addresses, hex chain ids — and the same orders with another maker must not.
import "../src/buffer-global.js";
import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {omnistonPins, validateEvmTypedOrder} from "../src/provider.js";

type Fixture = {chains: Record<string, {payload?: {typedData?: string}}>};
const load = (file: string) => JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8")) as Fixture;
const orders = [...Object.entries(load("live-evm-ton-2026-10-16.json").chains), ...Object.entries(load("live-evm-evm-2026-10-20.json").chains)]
  .filter(([, c]) => c.payload?.typedData)
  .map(([name, c]) => {
    const typedData = c.payload!.typedData!;
    const td = JSON.parse(typedData) as {domain: {chainId: string; verifyingContract: string}; message: {maker: string; makerAsset: string; makingAmount: string}};
    return {name, typedData, chain: `eip155:${Number(td.domain.chainId)}`, lop: td.domain.verifyingContract, maker: td.message.maker, token: td.message.makerAsset, amount: BigInt(td.message.makingAmount)};
  });
const ATTACKER = "0x9999999999999999999999999999999999999999";

/** The engine over a provider that answers the live order as its build, for an account `address`. */
function run(o: (typeof orders)[number], address: string, typedData = o.typedData) {
  const signed: unknown[] = [], sent: unknown[] = [], registered: string[] = [];
  const provider: CrossChainProvider = {
    name: "omniston", enabled: () => true, supportsRoute: () => true, supportsSameChain: true, trackIntent: async () => ({state: "pending"}),
    getQuote: async (params: QuoteParams) => ({
      provider: "omniston", intentId: `omniston:${o.name}`, depositAddress: "", depositMemo: null, sourceAmount: params.amountIn, destAmount: "1000", minDestAmount: "990",
      feeUsd: 0, etaSeconds: 60, reliability: 1, validUntilMs: Date.now() + 60_000,
    }) as Quote,
    buildDeposit: async () => ({chain: o.chain, to: o.lop, value: "0", chainId: Number(o.chain.slice(7)), approvalAddress: o.lop, typedData}),
    registerSignedOrder: async (_id, sig) => { registered.push(sig); },
  };
  const account = {
    getAddress: async () => address, getChainId: async () => Number(o.chain.slice(7)), getAllowance: async () => 0n, waitForTransaction: async () => {},
    sendTransaction: async (tx: unknown) => { sent.push(tx); return {hash: `0x${sent.length}`}; },
    signTypedData: async (td: unknown) => { signed.push(td); return "0x" + "11".repeat(65); },
  };
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  const p = new P(account as never, {fromChain: o.chain, allowUnlistedTokens: true} as never);
  const swap = () => p.swap2({fromToken: o.token, fromTokenDecimals: 6, toToken: o.token, toChain: o.chain, recipient: address, fromTokenAmount: o.amount, minAmountOut: 990n});
  return {signed, sent, registered, swap};
}

describe("live Omniston orders through the engine's typed-order gate (scan 2026-10-27 modules, F4)", () => {
  it(`all ${orders.length} live orders are approved for the input, signed and registered`, async () => {
    expect(orders.length).toBeGreaterThanOrEqual(8);
    for (const o of orders) {
      const r = run(o, o.maker);
      await r.swap();
      expect(r.signed, o.name).toHaveLength(1);
      expect(r.registered, o.name).toHaveLength(1);
      expect((r.signed[0] as {domain: {chainId: unknown}}).domain.chainId, o.name).toBe(Number(o.chain.slice(7)));
    }
  });

  it("the same orders are refused for any other account, and when the backend swaps the maker", async () => {
    for (const o of orders) {
      const other = run(o, ATTACKER);
      await expect(other.swap(), o.name).rejects.toThrow(/typed order refused — the maker is not this account/);
      expect([other.signed, other.sent], o.name).toEqual([[], []]);
      const td = JSON.parse(o.typedData) as {message: Record<string, unknown>};
      td.message.maker = ATTACKER;
      const swapped = run(o, o.maker, JSON.stringify(td));
      await expect(swapped.swap(), o.name).rejects.toThrow(/the maker is not this account/);
      expect([swapped.signed, swapped.sent], o.name).toEqual([[], []]);
    }
  });

  it("omnistonPins: the app's audited order protocols are the only spenders a remote order may name", () => {
    const pins = omnistonPins({"eip155:8453": ["0xe7405facdedb2512e91f2886bdff13231343af5e"], "eip155:1": ["0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9"]});
    expect(pins.spenders("eip155:8453")).toEqual(["0xe7405fAcDEDB2512e91F2886BDff13231343aF5E"]);
    expect(pins.spenders("eip155:137")).toEqual([]);
    expect(pins.callTargets("eip155:8453")).toEqual([]);
    expect(() => omnistonPins({"eip155:1": ["not an address"]})).toThrow();
    expect(typeof validateEvmTypedOrder).toBe("function");
  });
});

// ── G5 (F7, F13, F18, F19): a TON cell-body build is bound to the swap on the client ───────────────────────────────────
import {Address, Cell, beginCell} from "@ton/core";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {omnistonVerifyBuild} from "../src/provider.js";

type TonCase = {pair: string; protocols: string; trader: string; quote: {inputUnits: string; inputAsset: {chain: {value: {kind: {$case: string}}}}}; messages: Array<{targetAddress: string; sendAmount: string; payload: string}>};
const tonCases = (JSON.parse(readFileSync(new URL("./fixtures/live-ton-swaps-2026-10-22.json", import.meta.url), "utf8")) as {cases: TonCase[]}).cases;
const TON_ATTACKER = new Address(0, Buffer.alloc(32, 0x99)).toString({bounceable: false});
const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");

/** The engine over a provider whose build is `build`, for the case's trader; plans are recorded. */
function tonRun(c: TonCase, build: {to: string; value: string; bodyBoc: string}, opts: {ownWallet?: string | null; provider?: CrossChainProvider} = {}) {
  const sent: unknown[] = [], plans: unknown[] = [];
  const native = c.quote.inputAsset.chain.value.kind.$case === "native";
  const [from, to] = c.pair.split(">") as [string, string];
  const provider: CrossChainProvider = opts.provider ?? {
    name: "omniston", enabled: () => true, supportsRoute: () => true, supportsSameChain: true, trackIntent: async () => ({state: "pending"}),
    getQuote: async (params: QuoteParams) => ({provider: "omniston", intentId: "omniston:live", depositAddress: "", depositMemo: null, sourceAmount: params.amountIn,
      destAmount: "1000", minDestAmount: "990", feeUsd: 0, etaSeconds: 30, reliability: 1, validUntilMs: Date.now() + 60_000}) as Quote,
    buildDeposit: async () => ({chain: "ton:-239", ...build}),
  };
  const account = {
    getAddress: async () => c.trader, waitForTransaction: async () => {},
    sendTransaction: async (tx: unknown) => { sent.push(tx); return {hash: `h${sent.length}`}; },
    ...(opts.ownWallet === null ? {} : {getJettonWalletAddress: async () => Address.parse(opts.ownWallet ?? c.messages[0]!.targetAddress)}),
  };
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  const p = new P(account as never, {fromChain: "ton:-239", skipAccountChainCheck: true, decodeTonBody: (boc: string) => Cell.fromBase64(boc), reviewExecution: (plan: unknown) => { plans.push(plan); }} as never);
  const swap = () => p.swap2({fromToken: from, toToken: from === "GRAM" ? "USDT" : "GRAM", toChain: "ton:-239", recipient: c.trader, fromTokenAmount: BigInt(c.quote.inputUnits), minAmountOut: 990n});
  return {sent, plans, swap, native};
}
const live = (c: TonCase) => ({to: c.messages[0]!.targetAddress, value: c.messages[0]!.sendAmount, bodyBoc: b64(c.messages[0]!.payload)});
const jettonCase = tonCases.find((c) => c.pair.startsWith("USDT>"))!;
const nativeCase = tonCases.find((c) => c.pair.startsWith("GRAM>"))!;
/** A TEP-74 transfer body: `amount` to `destination`, excess to `response`. */
const jettonTransfer = (amount: bigint, destination: string, response: string, forwardTon = 100_000_000n) => beginCell()
  .storeUint(0x0f8a7ea5, 32).storeUint(0, 64).storeCoins(amount).storeAddress(Address.parse(destination)).storeAddress(Address.parse(response))
  .storeMaybeRef(null).storeCoins(forwardTon).storeMaybeRef(null).endCell().toBoc().toString("base64");

describe("live TON swap messages through the engine's cell-body gate (scan 2026-10-27 modules, F7/F13/F18/F19)", () => {
  it(`all ${tonCases.length} live messages are sent as built; a jetton source's transfer reaches the review decoded`, async () => {
    expect(tonCases.length).toBeGreaterThanOrEqual(18);
    for (const c of tonCases) {
      const r = tonRun(c, live(c));
      await r.swap();
      expect(r.sent, c.pair).toHaveLength(1);
      const source = (r.plans[0] as {source: {cellBody?: boolean; cellBodyDecoded?: {jettonTransfer?: {amount: bigint}}}}).source;
      expect(source.cellBody, c.pair).toBe(true);
      if (!r.native) expect(source.cellBodyDecoded?.jettonTransfer?.amount, c.pair).toBe(BigInt(c.quote.inputUnits));
    }
  });
});

describe("TON cell-body builds that are not the swap are refused (scan 2026-10-27 modules, F7/F13/F18/F19)", () => {
  it("{to: attacker, value: the whole balance, bodyBoc} is refused: more TON than the input plus the gas ceiling", async () => {
    const r = tonRun(nativeCase, {to: TON_ATTACKER, value: "500000000000000", bodyBoc: b64(nativeCase.messages[0]!.payload)});
    await expect(r.swap()).rejects.toThrow(/TON cell-body build refused — it attaches 500000000000000 nanoTON/);
    expect(r.sent).toHaveLength(0);
  });

  it("{to: the user's USDT jetton wallet, bodyBoc: transfer(everything → attacker)} is refused", async () => {
    const r = tonRun(jettonCase, {to: jettonCase.messages[0]!.targetAddress, value: "260000000", bodyBoc: jettonTransfer(10n ** 15n, TON_ATTACKER, jettonCase.trader)});
    await expect(r.swap()).rejects.toThrow(/the jetton transfer moves 1000000000000000, not the swap's/);
    expect(r.sent).toHaveLength(0);
  });

  it("the input to the attacker with the excess to the attacker, another jetton wallet, too much gas, or no way to name the wallet: refused", async () => {
    const input = BigInt(jettonCase.quote.inputUnits);
    const target = jettonCase.messages[0]!.targetAddress;
    const cases: Array<[string, ReturnType<typeof tonRun>, RegExp]> = [
      ["excess elsewhere", tonRun(jettonCase, {to: target, value: "260000000", bodyBoc: jettonTransfer(input, TON_ATTACKER, TON_ATTACKER)}), /returns its excess to another wallet/],
      ["not our jetton wallet", tonRun(jettonCase, {to: target, value: "260000000", bodyBoc: b64(jettonCase.messages[0]!.payload)}, {ownWallet: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"}), /not this account's USDT jetton wallet/],
      ["gas over the ceiling", tonRun(jettonCase, {to: target, value: "5000000000", bodyBoc: b64(jettonCase.messages[0]!.payload)}), /more than the 1000000000 gas ceiling/],
      ["account cannot name its wallet", tonRun(jettonCase, live(jettonCase), {ownWallet: null}), /cannot name its own jetton wallet/],
      ["not a jetton transfer", tonRun(jettonCase, {to: target, value: "260000000", bodyBoc: beginCell().storeUint(0x12345678, 32).endCell().toBoc().toString("base64")}), /must be a jetton transfer/],
    ];
    for (const [what, r, why] of cases) {
      await expect(r.swap(), what).rejects.toThrow(why);
      expect(r.sent, what).toHaveLength(0);
    }
  });
});

describe("remote TON cell bodies need the app's own check (scan 2026-10-27 modules, F18/F19)", () => {
  /** A remote stub whose backend answers the live quote and message. */
  const stub = (c: TonCase, build: ReturnType<typeof live>, verifyBuild?: Parameters<typeof remoteProvider>[0]["verifyBuild"]) => {
    const fetchImpl = (async (url: string, init: {body: string}) => {
      const action = String(url).split("/").at(-1);
      const body = JSON.parse(init.body) as {params?: QuoteParams};
      const reply = (v: unknown) => new Response(JSON.stringify(v), {status: 200, headers: {"content-type": "application/json"}});
      if (action === "quote") return reply({provider: "omniston", intentId: "omniston:remote", depositAddress: "", depositMemo: null, sourceAmount: body.params!.amountIn, destAmount: "1000", minDestAmount: "990",
        feeUsd: 0, etaSeconds: 30, reliability: 1, validUntilMs: Date.now() + 60_000, providerData: {settlement: "swap", protocols: c.protocols, routeSteps: JSON.stringify([{protocol: c.protocols, inputJetton: null, outputJetton: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"}])}});
      if (action === "build") return reply({chain: "ton:-239", ...build});
      return reply({});
    }) as unknown as typeof fetch;
    return remoteProvider({name: "omniston", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, supportsSameChain: true, ...(verifyBuild ? {verifyBuild} : {})});
  };

  it("without verifyBuild a remote cell body is refused; nothing is sent", async () => {
    const r = tonRun(nativeCase, live(nativeCase), {provider: stub(nativeCase, live(nativeCase))});
    await expect(r.swap()).rejects.toThrow(/needs the app's own validator/);
    expect(r.sent).toHaveLength(0);
  });

  it("omnistonVerifyBuild opens the body against the app's request and asks the app's validator about the DEX", async () => {
    const targets: string[] = [];
    const verify = omnistonVerifyBuild({validateTonSwapTarget: ({address}) => { targets.push(address); return true; }});
    const ok = tonRun(nativeCase, live(nativeCase), {provider: stub(nativeCase, live(nativeCase), verify)});
    await ok.swap();
    expect(ok.sent).toHaveLength(1);
    expect(targets).toEqual([nativeCase.messages[0]!.targetAddress]);
    // The validator says no: refused before anything is signed.
    const no = tonRun(nativeCase, live(nativeCase), {provider: stub(nativeCase, live(nativeCase), omnistonVerifyBuild({validateTonSwapTarget: () => false}))});
    await expect(no.swap()).rejects.toThrow(/is not a recognized DEX contract/);
    expect(no.sent).toHaveLength(0);
    // checkTonSwapPayload on the client: a body whose on-chain minimum is below the quote, or for another trader, is refused.
    const params = {sourceChain: "ton:-239", sourceToken: "GRAM", destChain: "ton:-239", destToken: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs", amountIn: nativeCase.quote.inputUnits, destAddress: nativeCase.trader, refundAddress: nativeCase.trader} as QuoteParams;
    const quote = {sourceAmount: nativeCase.quote.inputUnits, minDestAmount: "990", providerData: {settlement: "swap", protocols: nativeCase.protocols, routeSteps: JSON.stringify([{protocol: nativeCase.protocols, inputJetton: null, outputJetton: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"}])}} as unknown as Quote;
    const tx = {chain: "ton:-239", ...live(nativeCase)};
    expect(await verify(quote, tx, params)).toBeNull();
    expect(await verify({...quote, minDestAmount: "999999999999"} as Quote, tx, params)).toMatch(/min/i);
    expect(await verify(quote, tx, {...params, destAddress: TON_ATTACKER, refundAddress: TON_ATTACKER})).toMatch(/receiver|refund|trader|dest/i);
    expect(await verify({...quote, providerData: {settlement: "escrow"}} as unknown as Quote, tx, params)).toMatch(/only TON swap bodies/);
    expect(await verify(quote, tx, undefined)).toMatch(/request this quote answered is unknown/);
  });
});
