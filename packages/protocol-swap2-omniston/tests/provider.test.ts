import "../src/buffer-global.js";
import {Buffer} from "buffer";
import {describe, expect, it} from "vitest";
import {omnistonProvider, validateEvmToTonOrderExtension} from "../src/provider.js";
import {OmnistonSwap2Protocol} from "../src/protocol.js";

describe("Omniston provider contract", () => {
  it("validates safety caps before opening a WebSocket", () => {
    expect(() => omnistonProvider({maxHtlcExecutions: 0})).toThrow(/positive integer/);
    expect(() => omnistonProvider({maxTonExecutionNano: "0"})).toThrow(/positive integer/);
    expect(() => omnistonProvider({apiUrl: "https://omni.invalid"})).toThrow(/ws or wss/);
    expect(() => omnistonProvider({maxUsd: "1e3"})).toThrow(/plain decimal/);
    expect(() => omnistonProvider({integratorAddress: "UQfees"})).toThrow(/configured together/);
  });

  it("fails closed without an independently configured settlement allowlist", () => {
    const provider = omnistonProvider({enabled: true});
    expect(provider.enabled()).toBe(false);
    expect(provider.supportsRoute(
      {chain: "eip155:1", token: "USDT"},
      {chain: "ton:-239", token: "USDT"},
    )).toBe(false);
    expect(() => omnistonProvider({
      trustedSettlementContracts: {"eip155:1": ["not-an-address"]},
    })).toThrow(/invalid trusted settlement contract/);
  });

  it("does not advertise TON-source execution without a semantic payload verifier", () => {
    const provider = omnistonProvider({
      enabled: true,
      trustedSettlementContracts: {
        "ton:-239": ["UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ"],
        "eip155:1": ["0x0000000000000000000000000000000000000001"],
      },
      validateTonJettonWallet: () => true,
    });
    expect(provider.supportsRoute(
      {chain: "ton:-239", token: "USDT"},
      {chain: "eip155:1", token: "USDT"},
    )).toBe(false);
  });

  it("advertises only TON-source routes when all independent validators exist", () => {
    const provider = omnistonProvider({
      enabled: true,
      trustedSettlementContracts: {
        "ton:-239": ["UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ"],
        "eip155:1": ["0x0000000000000000000000000000000000000001"],
      },
      validateTonJettonWallet: () => true,
      validateTonEscrowPayload: () => true,
      validateEvmOutputPosition: () => true,
    });
    expect(provider.supportsRoute(
      {chain: "ton:-239", token: "USDT"},
      {chain: "eip155:1", token: "USDT"},
    )).toBe(true);
    expect(provider.supportsRoute(
      {chain: "eip155:1", token: "USDT"},
      {chain: "ton:-239", token: "USDT"},
    )).toBe(false);
  });

  it("does not advertise a TON-source pair without both semantic validators", async () => {
    const protocol = new OmnistonSwap2Protocol(undefined, {
      fromChain: "ton:-239", enabled: true,
      trustedSettlementContracts: {
        "ton:-239": ["UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ"],
        "eip155:1": ["0x0000000000000000000000000000000000000001"],
      },
    });
    await expect(protocol.getSupportedTokens({fromChain: "ton:-239", toChain: "eip155:1"})).resolves.toEqual([]);
  });

  it("rejects legacy and malformed intent ids without opening a stream", async () => {
    const client = {orderTrack: () => { throw new Error("must not connect"); }} as never;
    await expect(omnistonProvider({client}).trackIntent({intentId: "omn1|q|trader|dest"})).rejects.toThrow(/malformed intent id/);
    await expect(omnistonProvider({client}).trackIntent({intentId: "omn1|%ZZ|trader|dest|eip155%3A1"})).rejects.toThrow(/malformed intent id/);
  });
});

function uintBe(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index--) {
    bytes[index] = Number(remaining & 255n);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw new Error("test integer overflow");
  return bytes;
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.replace(/^0x/, ""), "hex"));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

describe("Omniston EVM→TON signed extension", () => {
  const target = "0xACa3E2F9b61a44892926bC6c3e104192E7D1c3cd";
  const resolver = "0x2b654E50C83801AC79CE3011Ff94245E2937b1B7";
  const takerAsset = "0xbDdba5647D24c4a513f8F85e596B111B511A6E5e";
  const quoteTimestamp = 1_786_610_936;
  const quoteId = "44".repeat(32);
  const outputTokenAddress = `0:${"11".repeat(32)}`;
  const traderDstAddress = `0:${"22".repeat(32)}`;
  const secretHash = hexBytes("7b062064095a97578a0f0cf535dd321f48f102ebc87a8ca16dd4b4c5fc6c4da8");
  const srcDeposit = 600_000_000_000_000n;
  const dstDeposit = 0n;

  function extensionFixture(): Uint8Array {
    const resolverLow80 = BigInt(resolver) & ((1n << 80n) - 1n);
    const getter = concat(
      hexBytes(target), uintBe(0n, 3), uintBe(0n, 4), uintBe(BigInt(quoteTimestamp), 4),
      uintBe(1800n, 3), uintBe(900000n, 3), uintBe(5n, 1),
      ...[[800000n, 100n], [700000n, 100n], [600000n, 100n], [500000n, 100n], [400000n, 100n]]
        .flatMap(([rate, delta]) => [uintBe(rate!, 3), uintBe(delta!, 2)]),
      uintBe(0n, 2), uintBe(100n, 1), uintBe(30n, 2), uintBe(50n, 1),
      uintBe(1n, 1), uintBe(resolverLow80, 10),
    );
    const timelocks = [1n, 120n, 240n, 300n, 1n, 120n, 180n, 0n]
      .reduce((packed, value, index) => packed | (value << BigInt(index * 32)), 0n);
    const post = concat(
      hexBytes(target), new Uint8Array(40),
      uintBe(0n, 2), uintBe(100n, 1), uintBe(30n, 2), uintBe(50n, 1),
      uintBe(BigInt(quoteTimestamp), 4), uintBe(1n, 1), uintBe(resolverLow80, 10), uintBe(0n, 2),
      secretHash, uintBe(0n, 32), uintBe(BigInt(takerAsset), 32),
      uintBe((srcDeposit << 128n) | dstDeposit, 32), uintBe(timelocks, 32),
    );
    const fields = [new Uint8Array(), new Uint8Array(), getter, getter, new Uint8Array(), new Uint8Array(), new Uint8Array(), post];
    const header = new Uint8Array(32);
    const view = new DataView(header.buffer);
    let cumulative = 0;
    fields.forEach((field, index) => {
      cumulative += field.length;
      view.setUint32(28 - index * 4, cumulative, false);
    });
    const custom = concat(
      uintBe(0n, 1), hexBytes("11".repeat(32)),
      uintBe(0n, 1), hexBytes("22".repeat(32)),
      new Uint8Array(33), hexBytes(quoteId),
    );
    return concat(header, ...fields, custom);
  }

  const expected = {
    quoteId,
    quoteTimestamp,
    tradeStartDeadline: quoteTimestamp + 60,
    protocolFeePips: 300,
    integratorFeePips: 0,
    initialResolverAddress: resolver,
    outputTokenAddress,
    traderDstAddress,
    takerAsset,
    srcSecurityDepositUnits: srcDeposit.toString(),
    dstSecurityDepositUnits: dstDeposit.toString(),
    secretHash,
    trustedTarget: (address: string) => address.toLowerCase() === target.toLowerCase(),
  };

  it("accepts the exact pinned v1beta8 profile and semantic duplicates", async () => {
    await expect(validateEvmToTonOrderExtension(extensionFixture(), expected)).resolves.toBeUndefined();
  });

  it("binds a quote id that comes without its leading zero (63 hex chars) as 32 bytes", async () => {
    const unpadded = "4".repeat(63); // 0x0444…: on the wire without the leading 0
    const extension = extensionFixture();
    extension.set(hexBytes(unpadded.padStart(64, "0")), extension.length - 32);
    await expect(validateEvmToTonOrderExtension(extension, {...expected, quoteId: unpadded})).resolves.toBeUndefined();
    await expect(validateEvmToTonOrderExtension(extension, {...expected, quoteId: "5".repeat(63)})).rejects.toThrow(/bound to the quote id/);
  });

  it("rejects a resolver-substituted signed hashlock", async () => {
    const extension = extensionFixture();
    // header32 + two 80-byte getters + field7 prefix83
    extension[32 + 160 + 83] = extension[32 + 160 + 83]! ^ 1;
    await expect(validateEvmToTonOrderExtension(extension, expected)).rejects.toThrow(/HTLC terms/);
  });

  it("rejects a recipient substitution in exact TON customData", async () => {
    const extension = extensionFixture();
    extension[extension.length - 131 + 34] = extension[extension.length - 131 + 34]! ^ 1;
    await expect(validateEvmToTonOrderExtension(extension, expected)).rejects.toThrow(/address/);
  });
});

describe("Omniston TON↔TON swap settlement", () => {
  const TRADER = "UQCbXJ1-Hd_CyyAt3TNgircduNIn5QH5dj1_LBNz__y4fQaq";
  const USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
  const POOL = "EQAH4MY1EbqP7Gg2wJkoZvoCG4BYPsEG5lVBXPZn0UqXNz4y";
  const JETTON_WALLET = "EQB15F1CTmKEBo6qAiljTPnYtSU3131xyY31MPFBVA_dsl3o";
  const QUOTE_ID = "ab".repeat(32);
  const trusted = {"ton:-239": ["UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ"], "eip155:1": ["0x0000000000000000000000000000000000000001"]};
  const native = {chain: {$case: "ton", value: {kind: {$case: "native", value: {}}}}};
  const jetton = (a: string) => ({chain: {$case: "ton", value: {kind: {$case: "jetton", value: a}}}});

  function observable<T>(events: T[]) {
    return {
      subscribe(observer: {next: (e: T) => void; error?: (e: unknown) => void; complete?: () => void}) {
        for (const e of events) observer.next(e);
        observer.complete?.();
        return {unsubscribe() {}};
      },
    };
  }

  async function swapCell(builder: (b: import("@ton/core").Builder) => import("@ton/core").Builder): Promise<string> {
    const {beginCell} = await import("@ton/core");
    return builder(beginCell()).endCell().toBoc().toString("hex");
  }

  /** A DeDust CPMM v2 call in the real layout (scan F11 decodes it): the payment
   *  payload (swap#c442500f, min out) and the payout config paying the trader. */
  async function dedustV2Call(minOut: bigint): Promise<{payment: import("@ton/core").Cell; payout: import("@ton/core").Cell}> {
    const {Address, beginCell} = await import("@ton/core");
    const trader = Address.parse(TRADER);
    const payment = beginCell().storeUint(0xc442500f, 32).storeCoins(minOut).storeUint(0, 40).storeMaybeRef(null).storeBit(false).storeBit(false).endCell();
    const options = (b: import("@ton/core").Builder) => b.storeAddress(trader).storeCoins(0).storeMaybeRef(null).storeBit(false);
    const payout = options(options(beginCell())).storeAddress(trader).endCell();
    return {payment, payout};
  }
  async function payNative(amount: bigint, minOut: bigint): Promise<string> {
    const {payment, payout} = await dedustV2Call(minOut);
    return swapCell((b) => b.storeUint(0xa5a7cbf8, 32).storeUint(1, 64).storeCoins(amount).storeRef(payment).storeRef(payout));
  }

  function swapQuote(input: unknown, output: unknown, inputUnits: string, outputUnits: string, extra: Record<string, unknown> = {}) {
    return {
      rfqId: "rfq1", quoteId: QUOTE_ID, inputAsset: input, outputAsset: output, inputUnits, outputUnits,
      protocolFeeUnits: "0", integratorFeeUnits: "0", quoteTimestamp: Math.floor(Date.now() / 1000), gasBudget: "100000000",
      settlementData: {$case: "swap", value: {
        routes: [{steps: [{inputAsset: input, outputAsset: output, chunks: [{protocol: "DeDustCPMMV2", inputUnits, outputUnits}]}]}],
        minOutputAmount: String(BigInt(outputUnits) - 1000n), recommendedMinOutputAmount: String(BigInt(outputUnits) - 500n), recommendedSlippagePips: 5000,
      }},
      ...extra,
    };
  }

  function clientFor(quote: unknown, messages: {targetAddress: string; sendAmount: string; payload: string}[], progress: {status: string; outgoingTxHash?: string} | null = null) {
    const calls: Record<string, unknown[]> = {};
    return {
      calls,
      requestForQuote(request: unknown) {
        (calls.requestForQuote ??= []).push(request);
        return observable([{$case: "ack", value: {rfqId: "rfq1"}}, {$case: "quoteUpdated", rfqId: "rfq1", value: quote}]);
      },
      async tonBuildSwap(request: unknown) { (calls.tonBuildSwap ??= []).push(request); return {messages}; },
      swapTrack(request: unknown) { (calls.swapTrack ??= []).push(request); return observable(progress ? [{$case: "progress", value: progress}] : [{$case: "awaitingTransfer"}]); },
      orderTrack() { throw new Error("must not track an order for a swap"); },
      tonBuildEscrowTransfer() { throw new Error("must not build an escrow for a swap"); },
    };
  }

  it("advertises TON↔TON only with the jetton-wallet and swap-target validators", () => {
    const base = {enabled: true, trustedSettlementContracts: trusted, validateTonJettonWallet: () => true};
    expect(omnistonProvider(base).supportsRoute({chain: "ton:-239", token: "GRAM"}, {chain: "ton:-239", token: "USDT"})).toBe(false);
    const full = omnistonProvider({...base, validateTonSwapTarget: () => true});
    expect(full.supportsRoute({chain: "ton:-239", token: "GRAM"}, {chain: "ton:-239", token: "USDT"})).toBe(true);
    expect(full.supportsSameChain).toBe(true);
    expect(full.supportsRoute({chain: "eip155:1", token: "ETH"}, {chain: "eip155:8453", token: "ETH"})).toBe(false);
  });

  it("quotes native GRAM → USDT as a one-route swap and builds a DEX-bound message (input + gas)", async () => {
    const quote = swapQuote(native, jetton(USDT), "1000000000", "1419292");
    const payload = await payNative(1000000000n, 1418292n);
    const client = clientFor(quote, [{targetAddress: POOL, sendAmount: "1100000000", payload}]);
    const targets: string[] = [];
    const provider = omnistonProvider({
      client: client as never, enabled: true, trustedSettlementContracts: trusted, quoteSettleMs: 0,
      validateTonJettonWallet: () => true,
      validateTonSwapTarget: ({address, protocols}) => { targets.push(`${address}:${protocols.join(",")}`); return true; },
    });
    const q = await provider.getQuote({sourceChain: "ton:-239", sourceToken: "GRAM", destChain: "ton:-239", destToken: USDT, amountIn: "1000000000", destAddress: TRADER, refundAddress: TRADER, dry: false, slippageBps: 50});
    expect(q).not.toBeNull();
    expect(q!.destAmount).toBe("1419292");
    expect(q!.minDestAmount).toBe("1418292");
    expect(q!.providerData?.settlement).toBe("swap");
    const request = (client.calls.requestForQuote![0] as {settlementParams: {params: {$case: string; value: {maxRoutes: number; maxPriceSlippagePips: number}}}[]});
    expect(request.settlementParams[0]!.params.$case).toBe("swap");
    expect(request.settlementParams[0]!.params.value.maxRoutes).toBe(1);
    expect(request.settlementParams[0]!.params.value.maxPriceSlippagePips).toBe(5000);

    const tx = await provider.buildDeposit(q!);
    expect(tx.to).toBe(POOL);
    expect(tx.value).toBe("1100000000");
    expect(tx.bodyBoc).toBe(Buffer.from(payload, "hex").toString("base64"));
    expect(targets).toEqual([`${POOL}:DeDustCPMMV2`]);
    expect(client.calls.tonBuildSwap![0]).toMatchObject({quoteId: QUOTE_ID, useRecommendedSlippage: false, traderDstAddress: {chain: {$case: "ton", value: TRADER}}});
  });

  it("accepts a quote id without leading-zero padding (live: ~1 in 16 is 63 hex chars), refuses a short one", async () => {
    const payload = await payNative(1000000000n, 1418292n);
    const run = async (quoteId: string) => {
      const reasons: string[] = [];
      const provider = omnistonProvider({
        client: clientFor(swapQuote(native, jetton(USDT), "1000000000", "1419292", {quoteId}), [{targetAddress: POOL, sendAmount: "1100000000", payload}]) as never,
        enabled: true, trustedSettlementContracts: trusted, quoteSettleMs: 0, validateTonJettonWallet: () => true, validateTonSwapTarget: () => true,
      });
      const q = await provider.getQuote({sourceChain: "ton:-239", sourceToken: "GRAM", destChain: "ton:-239", destToken: USDT, amountIn: "1000000000", destAddress: TRADER, refundAddress: TRADER, dry: false, onRefusal: (r) => reasons.push(r)});
      return {q, reasons, provider};
    };
    const ok = await run("82c4da72814ea8d350916b0bd38921266446ac305ff053a016fdd949c4028c3");
    expect(ok.q).not.toBeNull();
    await expect(ok.provider.buildDeposit(ok.q!)).resolves.toMatchObject({value: "1100000000"});
    const bad = await run("abc123");
    expect(bad.q).toBeNull();
    expect(bad.reasons[0]).toMatch(/malformed quote id/);
  });

  it("refuses a native-input message that attaches more than the gas budget or an unrecognised target", async () => {
    const quote = swapQuote(native, jetton(USDT), "1000000000", "1419292");
    const payload = await payNative(1000000000n, 1418292n);
    const greedy = omnistonProvider({
      client: clientFor(quote, [{targetAddress: POOL, sendAmount: "1300000000", payload}]) as never,
      enabled: true, trustedSettlementContracts: trusted, quoteSettleMs: 0, validateTonJettonWallet: () => true, validateTonSwapTarget: () => true,
    });
    const q = await greedy.getQuote({sourceChain: "ton:-239", sourceToken: "GRAM", destChain: "ton:-239", destToken: USDT, amountIn: "1000000000", destAddress: TRADER, refundAddress: TRADER, dry: false});
    await expect(greedy.buildDeposit(q!)).rejects.toThrow(/gas budget/);

    const unknownTarget = omnistonProvider({
      client: clientFor(quote, [{targetAddress: POOL, sendAmount: "1100000000", payload}]) as never,
      enabled: true, trustedSettlementContracts: trusted, quoteSettleMs: 0, validateTonJettonWallet: () => true, validateTonSwapTarget: () => false,
    });
    const q2 = await unknownTarget.getQuote({sourceChain: "ton:-239", sourceToken: "GRAM", destChain: "ton:-239", destToken: USDT, amountIn: "1000000000", destAddress: TRADER, refundAddress: TRADER, dry: false});
    await expect(unknownTarget.buildDeposit(q2!)).rejects.toThrow(/recognized DEX contract/);
  });

  it("jetton input must be a transfer from the trader's own wallet, for the quoted amount, refunding the trader, into a DEX", async () => {
    const {Address, beginCell} = await import("@ton/core");
    const quote = swapQuote(jetton(USDT), native, "1000000", "730825926", {gasBudget: "150000000"});
    const call = await dedustV2Call(730824926n);
    const transfer = (amount: bigint, response: string | null) => swapCell((b) => {
      b.storeUint(0x0f8a7ea5, 32).storeUint(0, 64).storeCoins(amount).storeAddress(Address.parse(POOL));
      b.storeAddress(response ? Address.parse(response) : null).storeMaybeRef(null).storeCoins(100000000n);
      // forward payload: DeDust CPMM v2 pay_jetton#cbc33949 to the pool
      return b.storeBit(1).storeRef(beginCell().storeUint(0xcbc33949, 32).storeRef(call.payment).storeRef(call.payout).endCell());
    });
    const good = await transfer(1000000n, TRADER);
    const wallets: string[] = [];
    const provider = omnistonProvider({
      client: clientFor(quote, [{targetAddress: JETTON_WALLET, sendAmount: "150000000", payload: good}]) as never,
      enabled: true, trustedSettlementContracts: trusted, quoteSettleMs: 0,
      validateTonJettonWallet: ({walletAddress, jettonMasterAddress}) => { wallets.push(`${walletAddress}:${jettonMasterAddress}`); return true; },
      validateTonSwapTarget: ({address}) => address === POOL,
    });
    const params = {sourceChain: "ton:-239", sourceToken: "USDT", destChain: "ton:-239", destToken: "", amountIn: "1000000", destAddress: TRADER, refundAddress: TRADER, dry: false};
    const q = await provider.getQuote(params);
    expect(q).not.toBeNull();
    const tx = await provider.buildDeposit(q!);
    expect(tx.to).toBe(JETTON_WALLET);
    expect(tx.value).toBe("150000000");
    expect(wallets).toEqual([`${JETTON_WALLET}:${USDT}`]);

    for (const [label, payload, sendAmount] of [
      ["wrong amount", await transfer(999999n, TRADER), "150000000"],
      ["excess to a stranger", await transfer(1000000n, POOL), "150000000"],
      ["gas above budget", good, "5000000000"],
    ] as const) {
      const bad = omnistonProvider({
        client: clientFor(quote, [{targetAddress: JETTON_WALLET, sendAmount, payload}]) as never,
        enabled: true, trustedSettlementContracts: trusted, quoteSettleMs: 0, validateTonJettonWallet: () => true, validateTonSwapTarget: () => true,
      });
      const qb = await bad.getQuote(params);
      await expect(bad.buildDeposit(qb!), label).rejects.toThrow();
    }
  });

  it("refuses a body that is only an op and a query id (the pre-F11 synthetic body) as an unknown layout", async () => {
    const quote = swapQuote(native, jetton(USDT), "1000000000", "1419292");
    const payload = await swapCell((b) => b.storeUint(0xa5a7cbf8, 32).storeUint(1, 64));
    const provider = omnistonProvider({
      client: clientFor(quote, [{targetAddress: POOL, sendAmount: "1100000000", payload}]) as never,
      enabled: true, trustedSettlementContracts: trusted, quoteSettleMs: 0, validateTonJettonWallet: () => true, validateTonSwapTarget: () => true,
    });
    const q = await provider.getQuote({sourceChain: "ton:-239", sourceToken: "GRAM", destChain: "ton:-239", destToken: USDT, amountIn: "1000000000", destAddress: TRADER, refundAddress: TRADER, dry: false});
    await expect(provider.buildDeposit(q!)).rejects.toThrow(/ton-swap-payload/);
  });

  it("re-quotes once at the slippage that puts the minimum on the caller's floor", async () => {
    // First RFQ: min 1418292 at 0.5%; the preview promised 1418500 → tighten.
    const quotes = [
      swapQuote(native, jetton(USDT), "1000000000", "1419292"),
      {...swapQuote(native, jetton(USDT), "1000000000", "1419292"), settlementData: {$case: "swap", value: {
        routes: [{steps: [{chunks: [{protocol: "DeDustCPMMV2", inputUnits: "1000000000", outputUnits: "1419292"}]}]}],
        minOutputAmount: "1418500", recommendedMinOutputAmount: "1418292", recommendedSlippagePips: 5000,
      }}},
    ];
    const requests: {settlementParams: {params: {value: {maxPriceSlippagePips: number}}}[]}[] = [];
    const client = {
      requestForQuote(request: never) { requests.push(request); return observable([{$case: "ack", value: {rfqId: "rfq1"}}, {$case: "quoteUpdated", rfqId: "rfq1", value: quotes[requests.length - 1]}]); },
      async tonBuildSwap() { return {messages: []}; }, swapTrack() { return observable([]); }, orderTrack() { throw new Error("no"); }, tonBuildEscrowTransfer() { throw new Error("no"); },
    };
    const provider = omnistonProvider({client: client as never, enabled: true, trustedSettlementContracts: trusted, quoteSettleMs: 0, validateTonJettonWallet: () => true, validateTonSwapTarget: () => true});
    const q = await provider.getQuote({sourceChain: "ton:-239", sourceToken: "GRAM", destChain: "ton:-239", destToken: USDT, amountIn: "1000000000", destAddress: TRADER, refundAddress: TRADER, dry: false, minAmountOut: "1418500"});
    expect(requests.length).toBe(2);
    expect(requests[0]!.settlementParams[0]!.params.value.maxPriceSlippagePips).toBe(5000);
    // (1419292 − 1418500) / 1419292 = 0.0558% → 558 pips
    expect(requests[1]!.settlementParams[0]!.params.value.maxPriceSlippagePips).toBe(558);
    expect(q!.minDestAmount).toBe("1418500");

    // A floor the live price can't reach at all is refused, not faked.
    requests.length = 0;
    const none = await provider.getQuote({sourceChain: "ton:-239", sourceToken: "GRAM", destChain: "ton:-239", destToken: USDT, amountIn: "1000000000", destAddress: TRADER, refundAddress: TRADER, dry: false, minAmountOut: "1500000"});
    expect(none).toBeNull();
    expect(requests.length).toBe(1);
  });

  it("meets the router's slippage floor even when Omniston rounds its minimum down", async () => {
    // out 1428814 at 0.5% → router requires ceil(1428814 × 0.995) = 1421670;
    // Omniston floors to 1421669 → one unit short → the module re-quotes.
    const mk = (min: string) => ({...swapQuote(native, jetton(USDT), "1000000000", "1428814"), settlementData: {$case: "swap", value: {
      routes: [{steps: [{chunks: [{protocol: "DeDustCPMMV2", inputUnits: "1000000000", outputUnits: "1428814"}]}]}],
      minOutputAmount: min, recommendedMinOutputAmount: min, recommendedSlippagePips: 5000,
    }}});
    const quotes = [mk("1421669"), mk("1421670")];
    const pips: number[] = [];
    const client = {
      requestForQuote(request: {settlementParams: {params: {value: {maxPriceSlippagePips: number}}}[]}) { pips.push(request.settlementParams[0]!.params.value.maxPriceSlippagePips); return observable([{$case: "ack", value: {rfqId: "rfq1"}}, {$case: "quoteUpdated", rfqId: "rfq1", value: quotes[pips.length - 1]}]); },
      async tonBuildSwap() { return {messages: []}; }, swapTrack() { return observable([]); }, orderTrack() { throw new Error("no"); }, tonBuildEscrowTransfer() { throw new Error("no"); },
    };
    const provider = omnistonProvider({client: client as never, enabled: true, trustedSettlementContracts: trusted, quoteSettleMs: 0, validateTonJettonWallet: () => true, validateTonSwapTarget: () => true});
    const q = await provider.getQuote({sourceChain: "ton:-239", sourceToken: "GRAM", destChain: "ton:-239", destToken: USDT, amountIn: "1000000000", destAddress: TRADER, refundAddress: TRADER, dry: false, slippageBps: 50});
    expect(pips).toEqual([5000, 4999]);
    expect(q!.minDestAmount).toBe("1421670");
  });

  it("tracks a swap through swapTrack by the outgoing tx and maps trade statuses", async () => {
    const quote = swapQuote(native, jetton(USDT), "1000000000", "1419292");
    const make = (progress: {status: string; outgoingTxHash?: string} | null) => omnistonProvider({
      client: clientFor(quote, [], progress) as never, enabled: true, trustedSettlementContracts: trusted, quoteSettleMs: 0, validateTonJettonWallet: () => true, validateTonSwapTarget: () => true,
    });
    const intentId = (await make(null).getQuote({sourceChain: "ton:-239", sourceToken: "GRAM", destChain: "ton:-239", destToken: USDT, amountIn: "1000000000", destAddress: TRADER, refundAddress: TRADER, dry: false}))!.intentId;
    expect(intentId.endsWith("|swap")).toBe(true);
    expect(await make(null).trackIntent({intentId})).toEqual({state: "pending"});
    expect(await make(null).trackIntent({intentId, sourceTxHash: "abc"})).toEqual({state: "pending"});
    expect(await make({status: "TRADE_STATUS_FULLY_FILLED", outgoingTxHash: "0xdead"}).trackIntent({intentId, sourceTxHash: "abc"})).toEqual({state: "completed", depositReceived: true, destTxHash: "0xdead"});
    expect(await make({status: "TRADE_STATUS_FAILED"}).trackIntent({intentId, sourceTxHash: "abc"})).toEqual({state: "failed", depositReceived: true});
    expect(await make({status: "TRADE_STATUS_IN_PROGRESS"}).trackIntent({intentId, sourceTxHash: "abc"})).toEqual({state: "pending", depositReceived: true});
  });
});
