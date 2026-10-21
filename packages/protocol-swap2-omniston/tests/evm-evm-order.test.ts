import "../src/buffer-global.js";
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {keccak256} from "viem";
import {omnistonProvider, type OmnistonProviderOptions} from "../src/provider.js";

/**
 * EVM → EVM orders against responses captured live on 2026-10-20 (resolver
 * Arbiter, SDK 0.8.11, 20 USDC Base → Arbitrum USDT0 and 20 USDT0 Plasma →
 * Base USDC). Payloads were built with a FIXED test secret and never signed.
 */
const live = JSON.parse(readFileSync(new URL("./fixtures/live-evm-evm-2026-10-20.json", import.meta.url), "utf8"));
const SECRET = Buffer.from("11".repeat(32), "hex");
const SECRET_HASH = Buffer.from(keccak256(SECRET).slice(2), "hex");
const OWNER = "0x4444444444444444444444444444444444444444";
const DEST = "0x3333333333333333333333333333333333333333";
const RESOLVER = "0x2b654E50C83801AC79CE3011Ff94245E2937b1B7";
const BASE_LOP = "0xe7405fAcDEDB2512e91F2886BDff13231343aF5E";
const BASE_FACTORY = "0xACa3E2F9b61a44892926bC6c3e104192E7D1c3cd";
const ARB_FACTORY = "0xafCF681272AF10959736f45616eeCBC22D7095E2";
const PLASMA_LOP = "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9";
const PLASMA_FACTORY = "0xd602079AFa5c38F550510a2a988CbFa698Fa0189";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDT0_ARB = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
const SRC_POSITION = "0x0CD4d5758313baAdB792c51175B383Bb64Ea6909";
const DST_POSITION = "0x1111111111111111111111111111111111111111";
const TRUSTED = {"eip155:8453": [BASE_FACTORY], "eip155:42161": [ARB_FACTORY], "eip155:9745": [PLASMA_FACTORY]};
const PROTOCOLS = {"eip155:8453": [BASE_LOP], "eip155:9745": [PLASMA_LOP]};
const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));

type Chain = (typeof live.chains)[string];
const chain = (name: "baseToArbitrum" | "plasmaToBase"): Chain => live.chains[name];
const quoteOf = (name: "baseToArbitrum" | "plasmaToBase") => structuredClone(chain(name).quoteUpdated);
const payloadOf = (name: "baseToArbitrum" | "plasmaToBase", ext?: Uint8Array) => ({
  typedData: chain(name).payload.typedData as string,
  orderExtension: ext ?? hex(chain(name).payload.orderExtensionHex),
  serializedOrderDetails: hex(chain(name).payload.serializedOrderDetailsHex),
});

function observable<T>(events: T[]) {
  return {subscribe(o: {next: (e: T) => void; complete?: () => void}) { for (const e of events) o.next(e); o.complete?.(); return {unsubscribe() {}}; }};
}

function clientFor(q: ReturnType<typeof quoteOf> | null, built: ReturnType<typeof payloadOf>, snapshot: unknown = null) {
  const calls: Record<string, unknown[]> = {};
  return {
    calls,
    requestForQuote(request: unknown) {
      (calls.requestForQuote ??= []).push(request);
      return observable([{$case: "ack", value: {rfqId: q?.rfqId ?? "r"}}, ...(q ? [{$case: "quoteUpdated", rfqId: q.rfqId, value: q}] : [])]);
    },
    async evmBuildOrderPayload(request: unknown) { (calls.evmBuildOrderPayload ??= []).push(request); return built; },
    async orderRegisterSignedOrder(request: unknown) { (calls.orderRegisterSignedOrder ??= []).push(request); },
    orderTrack(request: unknown) { (calls.orderTrack ??= []).push(request); return observable(snapshot ? [{$case: "order", value: snapshot}] : []); },
    async orderDiscloseHtlcSecret(request: unknown) { (calls.orderDiscloseHtlcSecret ??= []).push(request); },
    tonBuildEscrowTransfer() { throw new Error("EVM-source orders never build a TON escrow"); },
  };
}

function provider(client: ReturnType<typeof clientFor>, extra: Partial<OmnistonProviderOptions> = {}) {
  return omnistonProvider({
    client: client as never,
    quoteSettleMs: 0,
    maxHtlcExecutions: 1,
    trustedSettlementContracts: TRUSTED,
    trustedEvmOrderProtocols: PROTOCOLS,
    validateEvmInputPosition: () => true,
    validateEvmOutputPosition: () => true,
    ...extra,
  });
}

const baseParams = (extra: Record<string, unknown> = {}) => ({
  sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: USDT0_ARB,
  amountIn: "20000000", destAddress: DEST, refundAddress: OWNER, slippageBps: 100, dry: false, ...extra,
});

function pin(name: "baseToArbitrum" | "plasmaToBase") {
  vi.useFakeTimers({toFake: ["Date"], now: (quoteOf(name).quoteTimestamp + 5) * 1000});
  vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => { array.set(SECRET); return array; }) as never);
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Overwrite one 32-byte ExtraDataArgs word (0 hashlock, 1 dstChainId, 2 dstToken, 3 deposits, 4 timelocks). */
function withExtraWord(ext: Uint8Array, index: number, value: bigint): Uint8Array {
  const out = new Uint8Array(ext);
  const view = new DataView(out.buffer);
  const postBegin = view.getUint32(28 - 6 * 4, false);
  const at = 32 + postBegin + 20 + 20 + 20 + 2 + 1 + 2 + 1 + 4 + 1 + 12 + index * 32;
  out.set(hex(value.toString(16).padStart(64, "0")), at);
  return out;
}

describe("Omniston EVM → EVM orders (live 2026-10-20 fixtures)", () => {
  it("advertises EVM→EVM only with trusted contracts on both chains AND both EVM position validators", () => {
    const BASE = {chain: "eip155:8453", token: "USDC"}, ARB = {chain: "eip155:42161", token: "USDT0"};
    const c = clientFor(null, payloadOf("baseToArbitrum"));
    expect(provider(c).supportsRoute(BASE, ARB)).toBe(true);
    expect(provider(c, {validateEvmOutputPosition: undefined} as never).supportsRoute(BASE, ARB)).toBe(false);
    expect(provider(c, {validateEvmInputPosition: undefined} as never).supportsRoute(BASE, ARB)).toBe(false);
    expect(provider(c, {trustedEvmOrderProtocols: {}}).supportsRoute(BASE, ARB)).toBe(false);
    expect(provider(c, {trustedSettlementContracts: {"eip155:8453": [BASE_FACTORY]}}).supportsRoute(BASE, ARB)).toBe(false);
    // Same-chain EVM is not an order corridor.
    expect(provider(c).supportsRoute(BASE, {chain: "eip155:8453", token: "USDT"})).toBe(false);
  });

  it("quotes Base USDC → Arbitrum USDT0 and builds the gasless order bound to the destination chain and token", async () => {
    pin("baseToArbitrum");
    const client = clientFor(quoteOf("baseToArbitrum"), payloadOf("baseToArbitrum"));
    const p = provider(client);
    const q = await p.getQuote(baseParams());
    expect(q).toMatchObject({provider: "omniston", sourceAmount: "20000000", destAmount: quoteOf("baseToArbitrum").outputUnits});
    const tx = await p.buildDeposit(q!);
    expect(tx).toMatchObject({chain: "eip155:8453", to: BASE_LOP, approvalAddress: BASE_LOP, value: "0", chainId: 8453});
    expect(client.calls.evmBuildOrderPayload).toEqual([expect.objectContaining({
      ownerSrcAddress: {chain: {$case: "base", value: OWNER}},
      traderDstAddress: {chain: {$case: "arbitrum", value: DEST}},
    })]);
  });

  it("refuses a signed extension that names another destination chain, token or deposit, or carries TON slots", async () => {
    const {validateEvmToTonOrderExtension} = await import("../src/provider.js");
    const c = chain("baseToArbitrum"), q = c.quoteUpdated, s = q.settlementData.value, td = JSON.parse(c.payload.typedData);
    const expected = {
      quoteId: q.quoteId, quoteTimestamp: q.quoteTimestamp, tradeStartDeadline: s.tradeStartDeadline,
      protocolFeePips: s.protocolFeePips, integratorFeePips: s.integratorFeePips ?? 0,
      initialResolverAddress: s.srcInitialResolverAddress.chain.value, outputTokenAddress: USDT0_ARB, traderDstAddress: DEST,
      takerAsset: td.message.takerAsset, srcSecurityDepositUnits: s.srcHtlcSecurityDepositUnits, dstSecurityDepositUnits: s.dstSecurityDepositUnits,
      secretHash: SECRET_HASH, trustedTarget: (a: string) => a === BASE_FACTORY, dstChainId: 42161,
    };
    const ext = hex(c.payload.orderExtensionHex);
    await expect(validateEvmToTonOrderExtension(ext, expected)).resolves.toBeUndefined();
    // Read as a TON-destination order, the same bytes fail: the chain word is not 0.
    const {dstChainId: _evm, ...asTon} = expected;
    await expect(validateEvmToTonOrderExtension(ext, {...asTon, dstSecurityDepositUnits: "0"})).rejects.toThrow();
    const tonSlots = new Uint8Array(ext);
    tonSlots[tonSlots.length - 131 + 5] = 1;
    const recipient = new Uint8Array(ext);
    const postBegin = new DataView(recipient.buffer).getUint32(28 - 6 * 4, false);
    recipient[32 + postBegin + 20 + 20 + 19]! ^= 1; // protocol-fee recipient, last byte
    const cases: [string, Uint8Array, Partial<typeof expected>, RegExp][] = [
      ["chain", withExtraWord(ext, 1, 8453n), {}, /HTLC terms/],
      ["token", withExtraWord(ext, 2, BigInt(USDC_BASE)), {}, /HTLC terms/],
      ["deposit", withExtraWord(ext, 3, (BigInt(s.srcHtlcSecurityDepositUnits) << 128n) | 1n), {}, /HTLC terms/],
      ["expected chain", ext, {dstChainId: 8453}, /HTLC terms/],
      ["ton slots", tonSlots, {}, /unexpected TON addresses/],
      ["fee recipient", recipient, {}, /post-interaction terms/],
    ];
    for (const [label, bytes, override, pattern] of cases) {
      await expect(validateEvmToTonOrderExtension(bytes, {...expected, ...override}), label).rejects.toThrow(pattern);
    }
    // Through the provider, a tampered extension never reaches the wallet (the
    // order salt commits to the extension hash, so it fails even earlier).
    pin("baseToArbitrum");
    const p = provider(clientFor(quoteOf("baseToArbitrum"), payloadOf("baseToArbitrum", withExtraWord(ext, 1, 8453n))));
    const quote = await p.getQuote(baseParams());
    await expect(p.buildDeposit(quote!)).rejects.toThrow(/omniston:/);
  });

  it("refuses a non-EVM destination address and same-chain requests by name", async () => {
    pin("baseToArbitrum");
    const reasons = async (params: Record<string, unknown>) => {
      const refusals: string[] = [];
      await provider(clientFor(quoteOf("baseToArbitrum"), payloadOf("baseToArbitrum"))).getQuote({...baseParams(params), onRefusal: (r: string) => refusals.push(r)} as never);
      return refusals;
    };
    expect(await reasons({destAddress: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"})).toEqual(["omniston: destination is not an EVM address"]);
    expect(await reasons({destChain: "eip155:8453", destToken: USDC_BASE})).toEqual(["omniston: route is not an Omniston order corridor"]);
  });

  it("discloses only after the source fill AND the destination escrow paying the recipient are proven", async () => {
    pin("baseToArbitrum");
    const s = quoteOf("baseToArbitrum").settlementData.value;
    const snapshot = (overrides: Record<string, unknown> = {}) => ({
      quoteId: quoteOf("baseToArbitrum").quoteId, status: "ORDER_STATUS_ACTIVE",
      executions: [{
        index: 0, secretHash: new Uint8Array(SECRET_HASH), inputUnits: "20000000", outputUnits: quoteOf("baseToArbitrum").outputUnits,
        resolverSendsUnits: s.resolverSendsUnits,
        inputPositionAddress: {chain: {$case: "base", value: SRC_POSITION}},
        outputPositionAddress: {chain: {$case: "arbitrum", value: DST_POSITION}}, outputPositionPhase: "EXECUTION_PHASE_READY_FOR_PRIVATE_COMPLETION",
        ...overrides,
      }],
    });
    const run = async (extra: Partial<OmnistonProviderOptions>) => {
      const client = clientFor(quoteOf("baseToArbitrum"), payloadOf("baseToArbitrum"), snapshot());
      const p = provider(client, extra);
      const q = await p.getQuote(baseParams());
      await p.buildDeposit(q!);
      await p.trackIntent({intentId: q!.intentId});
      return client.calls.orderDiscloseHtlcSecret ?? [];
    };
    const input = vi.fn(async () => true);
    const output = vi.fn(async () => true);
    expect(await run({validateEvmInputPosition: input, validateEvmOutputPosition: output})).toEqual([{quoteId: quoteOf("baseToArbitrum").quoteId, executionIndex: 0, secret: new Uint8Array(SECRET)}]);
    expect(input).toHaveBeenCalledWith(expect.objectContaining({
      chain: "eip155:8453", positionAddress: SRC_POSITION, factoryAddress: BASE_FACTORY, ownerAddress: OWNER, resolverAddress: RESOLVER, inputTokenAddress: USDC_BASE,
      destinationChainId: 42161, destinationTokenAddress: USDT0_ARB, dstSecurityDepositUnits: s.dstSecurityDepositUnits,
    }));
    expect(output).toHaveBeenCalledWith(expect.objectContaining({chain: "eip155:42161", positionAddress: DST_POSITION, factoryAddress: ARB_FACTORY, recipientAddress: DEST, outputTokenAddress: USDT0_ARB, dstSecurityDepositUnits: s.dstSecurityDepositUnits,
      // scan F12: the fee split the escrow must carry comes from the quote.
      protocolFeeUnits: quoteOf("baseToArbitrum").protocolFeeUnits, integratorFeeUnits: "0",
      protocolFeeRecipientAddress: "0x076268146B4EC6D21fc49C27586Cfa91B9079a00"}));
    expect(await run({validateEvmOutputPosition: () => false})).toEqual([]);
    expect(await run({validateEvmInputPosition: () => false})).toEqual([]);
    expect(await run({validateEvmOutputPosition: () => { throw new Error("rpc down"); }})).toEqual([]);
  });

  it("builds Plasma USDT0 → Base USDC against Plasma's own order protocol and factory", async () => {
    pin("plasmaToBase");
    const client = clientFor(quoteOf("plasmaToBase"), payloadOf("plasmaToBase"));
    const p = provider(client);
    const q = await p.getQuote({sourceChain: "eip155:9745", sourceToken: "USDT0", destChain: "eip155:8453", destToken: USDC_BASE, amountIn: "20000000", destAddress: DEST, refundAddress: OWNER, slippageBps: 100, dry: false});
    expect(q).not.toBeNull();
    await expect(p.buildDeposit(q!)).resolves.toMatchObject({chain: "eip155:9745", to: PLASMA_LOP, chainId: 9745});
  });

  it("a completed EVM-destination order reports the delivery transaction the locator finds", async () => {
    pin("baseToArbitrum");
    const s = quoteOf("baseToArbitrum").settlementData.value;
    const snapshot = {
      quoteId: quoteOf("baseToArbitrum").quoteId, status: "TRADE_STATUS_FULLY_FILLED",
      executions: [{
        index: 0, secretHash: new Uint8Array(SECRET_HASH), inputUnits: "20000000", outputUnits: quoteOf("baseToArbitrum").outputUnits,
        resolverSendsUnits: s.resolverSendsUnits,
        inputPositionAddress: {chain: {$case: "base", value: SRC_POSITION}},
        outputPositionAddress: {chain: {$case: "arbitrum", value: DST_POSITION}}, outputPositionPhase: "EXECUTION_PHASE_COMPLETED",
      }],
    };
    const locate = vi.fn(async () => `0x${"cd".repeat(32)}`);
    const client = clientFor(quoteOf("baseToArbitrum"), payloadOf("baseToArbitrum"), snapshot);
    const p = provider(client, {locateEvmDelivery: locate});
    const q = await p.getQuote(baseParams());
    await p.buildDeposit(q!);
    await expect(p.trackIntent({intentId: q!.intentId})).resolves.toEqual({state: "completed", depositReceived: true, destTxHash: `0x${"cd".repeat(32)}`});
    expect(locate).toHaveBeenCalledWith({chain: "eip155:42161", positionAddress: DST_POSITION, recipientAddress: DEST, tokenAddress: USDT0_ARB, minUnits: quoteOf("baseToArbitrum").outputUnits});
  });
});
