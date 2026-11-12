import "../src/buffer-global.js";
import {Buffer} from "buffer";
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {Address, beginCell, Cell} from "@ton/core";
import {parseActivityFixture, type ActivityFixtureJson} from "@anywalletkit/conformance";
import {validQuote} from "@anywalletkit/protocol-swap2-core/validate";
import {keccak256} from "viem";
import {inMemoryQuoteStore, inMemorySecretStore, omnistonProvider, type OmnistonProviderOptions} from "../src/provider.js";
import {describeOmnistonActivity, OMNISTON_ESCROWS} from "../src/activity.js";
import {AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS, AUDITED_OMNISTON_SETTLEMENT_CONTRACTS} from "../src/validators/settlement.js";
import {createOmnistonTonValidators, DEFAULT_OMNISTON_TON_CODE_HASHES} from "../src/validators/ton.js";

/**
 * Omniston's rev2 TON Escrow Minter EQDybO88… (SDK-306). Since 2026-11-10 every TON <-> EVM quote names it instead
 * of EQAbWJ3Y… (rev1), and the rev2 minter deploys EVM → TON positions with code eb503578…. Since 2026-11-12 the
 * audited tables trust rev2 only: a quote or build naming rev1 is refused by default (its address in the reason), a
 * rev1 position fails position-code-hash, and rev1 stays in OMNISTON_ESCROWS for history. Old orders need no trust:
 * trackIntent reads no trust table, and every disclosure check refuses a quote older than 6 h. Passing rev1 in
 * trustedSettlementContracts / trustedProtocolAddresses is an explicit widening that trusts it for NEW orders again.
 * Captured 2026-11-11/12, read-only: RFQs and UNSIGNED builds (nothing signed, registered, disclosed or sent) and
 * tonapi / toncenter account reads of a real rev2 and a real rev1 position. The rev1 fixtures stay as they are: they
 * are the history of the old minter.
 */
const live = JSON.parse(readFileSync(new URL("./fixtures/live-ton-settlement-rev2-2026-11-11.json", import.meta.url), "utf8"));
/** The rev1 captures: TON → EVM escrow builds of 2026-10-10, EVM → TON orders of 2026-10-16, a settled rev1 position. */
const rev1Escrows = JSON.parse(readFileSync(new URL("./fixtures/live-2026-10-10.json", import.meta.url), "utf8"));
const rev1Orders = JSON.parse(readFileSync(new URL("./fixtures/live-evm-ton-2026-10-16.json", import.meta.url), "utf8")).chains;
const rev1Position = JSON.parse(readFileSync(new URL("./fixtures/live-ton-rev1-position-2026-11-11.json", import.meta.url), "utf8"));
const REV1 = "EQAbWJ3Y1HgIIvcMq1prG1anlDC0T3cZlAU7luPT6LmTpmrZ";
const REV2 = "EQDybO88l2lrrAmALRUqpmgEE_tuxk510F4Yd4xjbQZxC9IA";
const POSITION_REV1 = "e4d5115a321ade7b827e38fb522c20d2f2cd46e4c6b0b5f7dd8b6b096792d77b";
const POSITION_REV2 = "eb503578b4d9cd791c9c0ecd0da6da4064aae2bcb19d3c924d4001c493386bc5";
/** The rev1 minter's USD₮ wallet (tonapi, 2026-10-16), for a rev2 position offered against a rev1 order. */
const REV1_USDT_WALLET = "EQA76qndaGh9F43jfgTVAuvJvuGzA8uLNQ7iC1XZ-X5X6CDa";
const USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const GRAM = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** A lookalike of the rev2 minter: same workchain and account hash except the last byte. */
const LOOKALIKE = (() => {
  const rev2 = Address.parse(REV2);
  const hash = Buffer.from(rev2.hash);
  hash[31] = hash[31]! ^ 0x01;
  return new Address(rev2.workChain, hash).toString();
})();
const raw = (address: string) => Address.parse(address).toRawString();
/** An explicit widening back to rev1 (new orders included): both minters, both position codes. The rev1 tests use it so
 *  the real rev1 captures keep exercising the same checks. */
const SETTLEMENT_WITH_REV1 = {...AUDITED_OMNISTON_SETTLEMENT_CONTRACTS, "ton:-239": [REV2, REV1]};
const PROTOCOLS_WITH_REV1 = {trustedProtocolAddresses: [REV2, REV1]};
const POSITIONS_WITH_REV1 = {positionCodeHashes: [POSITION_REV2, POSITION_REV1]};

type Quote = Record<string, unknown> & {quoteTimestamp: number; settlementData: {value: Record<string, unknown> & {srcProtocolContractAddress: {chain: {value: string}}; dstProtocolContractAddress: {chain: {value: string}}}}};

function observable<T>(events: T[]) {
  return {
    subscribe(observer: {next: (e: T) => void; complete?: () => void}) {
      for (const e of events) observer.next(e);
      observer.complete?.();
      return {unsubscribe() {}};
    },
  };
}

function clientFor(quote: Quote | null, escrow: unknown = live.tonToEvm.escrowResponse) {
  const calls: Record<string, unknown[]> = {};
  return {
    calls,
    requestForQuote(request: unknown) {
      (calls.requestForQuote ??= []).push(request);
      const rfqId = (quote?.rfqId as string | undefined) ?? "r";
      return observable([{$case: "ack", value: {rfqId}}, ...(quote ? [{$case: "quoteUpdated", rfqId, value: quote}] : [])]);
    },
    async tonBuildEscrowTransfer(request: unknown) { (calls.tonBuildEscrowTransfer ??= []).push(request); return structuredClone(escrow); },
    async evmBuildOrderPayload() { throw new Error("not used"); },
    orderTrack() { throw new Error("not used"); },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SDK-306: the audited TON tables", () => {
  it("trust the rev2 Escrow Minter only, in the exact string form Omniston's quotes use (the provider compares TON addresses as strings)", () => {
    expect(AUDITED_OMNISTON_SETTLEMENT_CONTRACTS["ton:-239"]).toEqual([REV2]);
    expect(live.tonToEvm.quoteUpdated.settlementData.value.srcProtocolContractAddress.chain.value).toBe(REV2);
    expect(live.evmToTonQuotes.baseUsdc.quoteUpdated.settlementData.value.dstProtocolContractAddress.chain.value).toBe(REV2);
    expect(live.evmToTonQuotes.ethUsdt.quoteUpdated.settlementData.value.dstProtocolContractAddress.chain.value).toBe(REV2);
  });

  it("pin the rev2 position code only, and leave every other TON pin as audited (the rev2 minter's whitelist holds the pinned escrow, execution and output-escrow codes, plus a TON <-> TON code the SDK does not pin)", () => {
    expect(DEFAULT_OMNISTON_TON_CODE_HASHES.position).toEqual([POSITION_REV2]);
    expect(live.evmToTonPosition.codeHash).toBe(POSITION_REV2);
    expect(DEFAULT_OMNISTON_TON_CODE_HASHES.escrow).toEqual(["9e77cb9e8fd7406d4e85e5f57378eb51e51b862424cf988306c783d50ade697a"]);
    expect(DEFAULT_OMNISTON_TON_CODE_HASHES.execution).toEqual(["f6edbc76e6fbcd6bac573cb942401a3d9198ee9605f9403b0f5c8081259210e5"]);
    expect(DEFAULT_OMNISTON_TON_CODE_HASHES.authorityKeys).toEqual(["ed210da12aa96ea42de4f2f61dc172bbaa3da86051a1b2a6f342f69a777d2770"]);
    expect(DEFAULT_OMNISTON_TON_CODE_HASHES.outputEscrow).toEqual(["d30423575384773abaad8d3c6f763898afa3d57a5693005904b7c61e95cee630"]);
  });

  it("recognize history on both minters (a list that grants no trust)", () => {
    expect(OMNISTON_ESCROWS).toEqual([REV1, REV2]);
  });
});

describe("SDK-306: TON → EVM on the rev2 minter (live 2026-11-11, TON USD₮ → Base USDC)", () => {
  const TON = live.tonToEvm;
  const order = TON.quoteUpdated.settlementData.value;
  const TRADER = TON.escrowRequest.ownerSrcAddress.chain.value as string;
  const RECIPIENT = TON.escrowRequest.traderDstAddress.chain.value as string;
  const JETTON_WALLET = TON.escrowResponse.messages[0].targetAddress as string;
  const PAYLOAD = TON.escrowResponse.messages[0].payload as string;
  const SECRET_HASH = Buffer.from(TON.escrowRequest.secretHashHex, "hex");
  const params = {...TON.params, dry: true};

  /** The live quote with its timestamps moved to now; every other byte is what the venue sent. */
  const fresh = (patch: (q: Quote) => void = () => {}): Quote => {
    const q = structuredClone(TON.quoteUpdated) as Quote;
    const now = Math.floor(Date.now() / 1000);
    q.quoteTimestamp = now;
    q.settlementData.value.tradeStartDeadline = now + 300;
    patch(q);
    return q;
  };
  const provider = (client: ReturnType<typeof clientFor>, extra: Partial<OmnistonProviderOptions> = {}) => omnistonProvider({
    client: client as never,
    quoteSettleMs: 0,
    maxHtlcExecutions: 1,
    trustedSettlementContracts: AUDITED_OMNISTON_SETTLEMENT_CONTRACTS,
    validateTonJettonWallet: ({walletAddress}) => walletAddress === JETTON_WALLET,
    validateTonEscrowPayload: () => true,
    validateEvmOutputPosition: () => true,
    ...extra,
  });
  const refusals = async (quote: Quote, extra: Partial<OmnistonProviderOptions> = {}) => {
    const seen: string[] = [];
    const q = await provider(clientFor(quote), extra).getQuote({...params, onRefusal: (r: string) => seen.push(r)});
    return {q, seen};
  };
  /** The same jetton transfer with another destination; everything after the address is copied as is. */
  const retarget = (payloadHex: string, to: string): string => {
    const s = Cell.fromBoc(Buffer.from(payloadHex, "hex"))[0]!.beginParse();
    const op = s.loadUint(32);
    const queryId = s.loadUintBig(64);
    const amount = s.loadCoins();
    s.loadAddress();
    return beginCell().storeUint(op, 32).storeUint(queryId, 64).storeCoins(amount).storeAddress(Address.parse(to)).storeSlice(s).endCell().toBoc().toString("hex");
  };
  const payloadInput = {
    payloadBocHex: PAYLOAD,
    forwardPayloadBocHex: Cell.fromBoc(Buffer.from(PAYLOAD, "hex"))[0]!.refs[0]!.toBoc().toString("hex"),
    quoteId: TON.quoteUpdated.quoteId as string,
    inputUnits: TON.quoteUpdated.inputUnits as string,
    resolverSendsUnits: order.resolverSendsUnits as string,
    srcHtlcSecurityDepositUnits: order.srcHtlcSecurityDepositUnits as string,
    protocolAddress: order.srcProtocolContractAddress.chain.value as string,
    ownerAddress: TRADER,
    destinationChain: "base",
    destinationAddress: RECIPIENT,
    outputTokenAddress: BASE_USDC,
    initialResolverAddress: order.srcInitialResolverAddress.chain.value as string,
    secretHashes: [new Uint8Array(SECRET_HASH)],
    hashingFunction: order.htlcHashingFunction as string,
    exclusivityTimeout: order.exclusivityTimeout as number,
  };
  const expectation = {
    payloadBocHex: PAYLOAD, ownerAddress: TRADER, inputUnits: TON.quoteUpdated.inputUnits as string, destinationChain: "eip155:8453",
    destinationAddress: RECIPIENT, outputTokenAddress: BASE_USDC, minResolverSendsUnits: order.resolverSendsUnits as string,
  };

  it("quotes on rev2 with the audited table and passes validQuote", async () => {
    const {q, seen} = await refusals(fresh());
    expect(seen).toEqual([]);
    expect(q?.destAmount).toBe(TON.quoteUpdated.outputUnits);
    expect(validQuote(q!, params, "omniston")).toBe(true);
  });

  it("refuses the same quote by name when only rev1 is trusted, and a lookalike minter", async () => {
    expect((await refusals(fresh(), {trustedSettlementContracts: {...AUDITED_OMNISTON_SETTLEMENT_CONTRACTS, "ton:-239": [REV1]}})).seen)
      .toEqual([`omniston: untrusted TON settlement contract ${REV2}`]);
    const lookalike = fresh((q) => { q.settlementData.value.srcProtocolContractAddress.chain.value = LOOKALIKE; });
    expect((await refusals(lookalike)).seen).toEqual([`omniston: untrusted TON settlement contract ${LOOKALIKE}`]);
  });

  it("refuses a quote naming rev1 by default, by name; an app that lists rev1 explicitly gets it again (a widening for new orders)", async () => {
    const onRev1 = () => fresh((q) => { q.settlementData.value.srcProtocolContractAddress.chain.value = REV1; });
    const byDefault = await refusals(onRev1());
    expect(byDefault.q).toBeNull();
    expect(byDefault.seen).toEqual([`omniston: untrusted TON settlement contract ${REV1}`]);
    const explicit = await refusals(onRev1(), {trustedSettlementContracts: SETTLEMENT_WITH_REV1});
    expect(explicit.seen).toEqual([]);
    expect(explicit.q?.destAmount).toBe(TON.quoteUpdated.outputUnits);
  });

  it("builds the live escrow transfer; the default pins accept everything the provider binds, and the hashlock binds the provider's own secret", async () => {
    const seen: Parameters<NonNullable<OmnistonProviderOptions["validateTonEscrowPayload"]>>[0][] = [];
    const client = clientFor(fresh());
    const p = provider(client, {validateTonEscrowPayload: (input) => { seen.push(input); return true; }});
    const tx = await p.buildDeposit((await p.getQuote(params))!);
    expect(tx).toMatchObject({chain: "ton:-239", to: JETTON_WALLET, value: TON.escrowResponse.messages[0].sendAmount});
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({protocolAddress: REV2, ownerAddress: TRADER, destinationAddress: RECIPIENT, inputUnits: payloadInput.inputUnits, exclusivityTimeout: 300});
    const v = createOmnistonTonValidators();
    // The venue built this body for the capture's hashlock; this test's provider drew another secret.
    expect(v.validateTonEscrowPayload({...seen[0]!, secretHashes: [new Uint8Array(SECRET_HASH)]})).toBe(true);
    expect(v.validateTonEscrowPayload(seen[0]!)).toBe(false);
  });

  it("validateTonEscrowPayload: the live rev2 body passes with the default pins; any other recipient, amount, hashlock, owner, minter or escrow code is refused", () => {
    const v = createOmnistonTonValidators().validateTonEscrowPayload;
    expect(v(payloadInput)).toBe(true);
    expect(v({...payloadInput, destinationAddress: `0x${"dd".repeat(20)}`})).toBe(false);
    expect(v({...payloadInput, resolverSendsUnits: String(BigInt(payloadInput.resolverSendsUnits) + 1n)})).toBe(false);
    expect(v({...payloadInput, inputUnits: String(BigInt(payloadInput.inputUnits) + 1n)})).toBe(false);
    expect(v({...payloadInput, secretHashes: [new Uint8Array(32).fill(8)]})).toBe(false);
    expect(v({...payloadInput, ownerAddress: REV1})).toBe(false);
    expect(v({...payloadInput, protocolAddress: REV1})).toBe(false);
    expect(createOmnistonTonValidators({escrowCodeHashes: ["00".repeat(32)]}).validateTonEscrowPayload(payloadInput)).toBe(false);
  });

  it("verifyTonEscrowBuild (the app's check of a remote build): accepts the rev2 body with the default table; refuses it without rev2, from a lookalike, under the quote's minimum, or with unaudited escrow code", () => {
    expect(createOmnistonTonValidators().verifyTonEscrowBuild(expectation)).toBeNull();
    expect(createOmnistonTonValidators({trustedProtocolAddresses: [REV1]}).verifyTonEscrowBuild(expectation))
      .toBe(`the escrow transfer pays ${REV2}, not an Omniston protocol contract this app trusts`);
    // retarget() itself changes nothing else: pointed at rev2 it gives back the captured body.
    expect(retarget(PAYLOAD, REV2)).toBe(Cell.fromBoc(Buffer.from(PAYLOAD, "hex"))[0]!.toBoc().toString("hex"));
    expect(createOmnistonTonValidators().verifyTonEscrowBuild({...expectation, payloadBocHex: retarget(PAYLOAD, LOOKALIKE)}))
      .toBe(`the escrow transfer pays ${LOOKALIKE}, not an Omniston protocol contract this app trusts`);
    expect(createOmnistonTonValidators().verifyTonEscrowBuild({...expectation, minResolverSendsUnits: String(BigInt(expectation.minResolverSendsUnits) + 1n)}))
      .toMatch(/^the resolver is bound to deliver /);
    expect(createOmnistonTonValidators({escrowCodeHashes: ["00".repeat(32)]}).verifyTonEscrowBuild(expectation)).toMatch(/not the audited escrow/);
  });

  it("verifyTonEscrowBuild: a live rev1 escrow (2026-10-10, TON USD₮ → Base USDC) is refused by default, by name, and passes only when the app lists rev1 explicitly", () => {
    const c = rev1Escrows.baseUsdc;
    const old = {
      payloadBocHex: c.escrowResponse.messages[0].payload as string, ownerAddress: c.escrowRequest.ownerSrcAddress.chain.value as string,
      inputUnits: c.quoteUpdated.value.inputUnits as string, destinationChain: "eip155:8453", destinationAddress: c.escrowRequest.traderDstAddress.chain.value as string,
      outputTokenAddress: c.quoteUpdated.value.outputAsset.chain.value.kind.value as string, minResolverSendsUnits: c.quoteUpdated.value.settlementData.value.resolverSendsUnits as string,
    };
    expect(createOmnistonTonValidators().verifyTonEscrowBuild(old)).toBe(`the escrow transfer pays ${REV1}, not an Omniston protocol contract this app trusts`);
    expect(createOmnistonTonValidators(PROTOCOLS_WITH_REV1).verifyTonEscrowBuild(old)).toBeNull();
    // Trusting rev1 relaxes nothing else: the same body for another recipient is still refused.
    expect(createOmnistonTonValidators(PROTOCOLS_WITH_REV1).verifyTonEscrowBuild({...old, destinationAddress: `0x${"dd".repeat(20)}`})).toMatch(/not this swap's/);
  });
});

describe("SDK-306: EVM → TON quotes naming rev2 as the TON factory (live 2026-11-11)", () => {
  const cases = [["Base USDC → TON USD₮", live.evmToTonQuotes.baseUsdc], ["Ethereum USDT → TON USD₮", live.evmToTonQuotes.ethUsdt]] as const;
  const quoteFor = async (c: {params: Record<string, unknown>; quoteUpdated: Quote}, trusted = AUDITED_OMNISTON_SETTLEMENT_CONTRACTS, extra: Partial<OmnistonProviderOptions> = {}) => {
    // The resolver signed timestamps relative to the live quote: pin the clock 5 s after it.
    vi.useFakeTimers({toFake: ["Date"], now: (c.quoteUpdated.quoteTimestamp + 5) * 1000});
    const seen: string[] = [];
    const q = await omnistonProvider({
      client: clientFor(structuredClone(c.quoteUpdated)) as never, quoteSettleMs: 0, maxHtlcExecutions: 1,
      trustedSettlementContracts: trusted, trustedEvmOrderProtocols: AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS,
      validateEvmInputPosition: () => true, validateTonOutputPosition: () => true, ...extra,
    }).getQuote({...c.params, onRefusal: (r: string) => seen.push(r)} as never);
    return {q, seen};
  };

  for (const [label, c] of cases) {
    it(`${label}: quotes with the audited table; refused by name when only rev1 is trusted`, async () => {
      const ok = await quoteFor(c);
      expect(ok.seen).toEqual([]);
      expect(ok.q?.destAmount).toBe(c.quoteUpdated.outputUnits);
      const old = await quoteFor(c, {...AUDITED_OMNISTON_SETTLEMENT_CONTRACTS, "ton:-239": [REV1]});
      expect(old.q).toBeNull();
      expect(old.seen).toEqual([`omniston: untrusted ton:-239 settlement contract ${REV2}`]);
    });
  }

  it("a live rev1 order (Base USDT → TON USD₮, 2026-10-16) is refused by default, by name; quoted only when the app lists rev1 in its settlement table", async () => {
    const fx = rev1Orders.base;
    const c = {
      params: {sourceChain: "eip155:8453", sourceToken: "USDT", destChain: "ton:-239", destToken: USDT, amountIn: fx.quoteUpdated.inputUnits,
        destAddress: fx.buildRequest.traderDstAddress, refundAddress: fx.buildRequest.ownerSrcAddress, slippageBps: 100, dry: false},
      quoteUpdated: fx.quoteUpdated as Quote,
    };
    expect(c.quoteUpdated.settlementData.value.dstProtocolContractAddress.chain.value).toBe(REV1);
    const byDefault = await quoteFor(c);
    expect(byDefault.q).toBeNull();
    expect(byDefault.seen).toEqual([`omniston: untrusted ton:-239 settlement contract ${REV1}`]);
    const explicit = await quoteFor(c, SETTLEMENT_WITH_REV1);
    expect(explicit.seen).toEqual([]);
    expect(explicit.q?.destAmount).toBe(fx.quoteUpdated.outputUnits);
    // Pinning the rev1 position code (for an EVM → TON order already in flight) does not let a new rev1 quote through.
    const pinned = await quoteFor(c, AUDITED_OMNISTON_SETTLEMENT_CONTRACTS, {validateTonOutputPosition: createOmnistonTonValidators(POSITIONS_WITH_REV1).validateTonOutputPosition});
    expect(pinned.q).toBeNull();
    expect(pinned.seen).toEqual([`omniston: untrusted ton:-239 settlement contract ${REV1}`]);
  });

  it("a rev1 quote cached by a provider that still trusted rev1 is not built by the provider with the new default table (a shared quote store)", async () => {
    const fx = rev1Orders.base;
    const params = {sourceChain: "eip155:8453", sourceToken: "USDT", destChain: "ton:-239", destToken: USDT, amountIn: fx.quoteUpdated.inputUnits,
      destAddress: fx.buildRequest.traderDstAddress, refundAddress: fx.buildRequest.ownerSrcAddress, slippageBps: 100, dry: false};
    const quoteStore = inMemoryQuoteStore();
    const secretStore = inMemorySecretStore();
    const quote = (await quoteFor({params, quoteUpdated: fx.quoteUpdated as Quote}, SETTLEMENT_WITH_REV1, {quoteStore, secretStore})).q;
    expect(quote).not.toBeNull();
    const after = omnistonProvider({
      client: clientFor(null) as never, quoteSettleMs: 0, maxHtlcExecutions: 1, quoteStore, secretStore,
      trustedSettlementContracts: AUDITED_OMNISTON_SETTLEMENT_CONTRACTS, trustedEvmOrderProtocols: AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS,
      validateEvmInputPosition: () => true, validateTonOutputPosition: () => true,
    });
    await expect(after.buildDeposit(quote!)).rejects.toThrow(`omniston: untrusted ton:-239 settlement contract ${REV1}`);
    expect(await secretStore.load(fx.quoteUpdated.quoteId as string)).toBeUndefined();
  });
});

describe("SDK-306: EVM → TON output position of the rev2 minter (EQDy9LIC…, deployed 2026-11-11 21:21:00Z)", () => {
  const POS = live.evmToTonPosition;
  // Decoded from the position's own state (every field is checked in its slot by the validator).
  const WITHDRAWAL_AT = 1_794_432_061;
  const HASHLOCK = Buffer.from("fcc0f697f6b579f59f924a2e0905cb008b301c8880f567b877724cf1f5cba84a", "hex");
  const input = {
    positionAddress: POS.position as string, protocolAddress: REV2, outputJettonMasterAddress: USDT,
    recipientAddress: "EQC_XOwoiCFhDrC1fwNLdhWyilIU3OkszlJzvSq5rDVrfN_k",
    quoteId: "791698f81b044d7e0aaa6a117496c03192affc9ff7ea3328ca718766ffe24f0d",
    // The order's quote is not in the capture: any quote time from 900 s before to 120 s after the deploy fits.
    quoteTimestamp: WITHDRAWAL_AT - 20,
    inputUnits: "2086286", outputUnits: "2086286", resolverSendsUnits: "2086286", dstSecurityDepositUnits: "500000000",
    secretHash: new Uint8Array(HASHLOCK),
  };

  function tonapi(over: {state?: "live" | "settled"; deployer?: string} = {}) {
    const state = POS[over.state ?? "live"];
    const wallets: Record<string, string> = {[raw(REV2)]: POS.factoryJettonWallet.wallet_address.address, [raw(REV1)]: raw(REV1_USDT_WALLET)};
    return vi.fn(async (url: string) => {
      const json = (body: unknown, ok = true) => ({ok, status: ok ? 200 : 404, json: async () => body}) as unknown as Response;
      if (url.endsWith(`/v2/blockchain/accounts/${encodeURIComponent(POS.position)}`)) {
        return json({address: raw(POS.position), status: "active", code: state.code, data: state.data});
      }
      if (url.endsWith(`/v2/blockchain/accounts/${encodeURIComponent(POS.position)}/transactions?limit=25`)) {
        const transactions = structuredClone(POS.transactions.transactions) as {in_msg: {op_code: string; source: {address: string}}}[];
        if (over.deployer) for (const tx of transactions) if (tx.in_msg.op_code === "0xf240cd30") tx.in_msg.source.address = raw(over.deployer);
        return json({transactions});
      }
      const jettons = /\/v2\/accounts\/([^/]+)\/jettons\/([^/?]+)$/.exec(url);
      if (jettons) {
        const wallet = wallets[raw(decodeURIComponent(jettons[1]!))];
        return wallet && raw(decodeURIComponent(jettons[2]!)) === raw(USDT) ? json({wallet_address: {address: wallet}, jetton: POS.factoryJettonWallet.jetton}) : json({error: "not found"}, false);
      }
      return json({}, false);
    });
  }
  const check = async (fetchImpl: ReturnType<typeof tonapi>, over: Partial<typeof input> = {}, pins: {positionCodeHashes?: string[]} = {}) => {
    const reasons: {reason: string; details?: Record<string, unknown>}[] = [];
    const ok = await createOmnistonTonValidators({
      fetch: fetchImpl as unknown as typeof fetch, now: () => (WITHDRAWAL_AT + 5) * 1000,
      onRefusal: (reason, details) => reasons.push({reason, ...(details ? {details} : {})}), ...pins,
    }).validateTonOutputPosition!({...input, ...over});
    return {ok, reasons};
  };

  it("the fixture is the real position: rev2 position code, deployed by the rev2 minter, custody at its USD₮ wallet", () => {
    expect(Cell.fromBoc(Buffer.from(POS.live.code, "hex"))[0]!.hash().toString("hex")).toBe(POSITION_REV2);
    expect(Cell.fromBoc(Buffer.from(POS.settled.code, "hex"))[0]!.hash().toString("hex")).toBe(POSITION_REV2);
    const deploy = POS.transactions.transactions.find((tx: {in_msg: {op_code: string}}) => tx.in_msg.op_code === "0xf240cd30");
    expect(raw(deploy.in_msg.source.address)).toBe(raw(REV2));
    expect(deploy.utime).toBe(WITHDRAWAL_AT - 1);
  });

  it("passes with the default pins in its live state (tag 1, 29-bit tail) and in its settled state", async () => {
    expect(await check(tonapi({state: "live"}))).toEqual({ok: true, reasons: []});
    expect(await check(tonapi({state: "settled"}))).toEqual({ok: true, reasons: []});
  });

  it("is refused with only the rev1 position code pinned (what every EVM → TON order on rev2 would hit if the address shipped alone)", async () => {
    expect(await check(tonapi(), {}, {positionCodeHashes: [POSITION_REV1]})).toEqual({ok: false, reasons: [{reason: "position-code-hash", details: {hash: POSITION_REV2}}]});
  });

  it("refuses a copy with the rev2 position code that the trusted factory did not deploy", async () => {
    for (const deployer of [LOOKALIKE, REV1]) {
      const {ok, reasons} = await check(tonapi({deployer}));
      expect(ok, deployer).toBe(false);
      expect(reasons.map((r) => r.reason), deployer).toEqual(["deploy-transaction"]);
    }
  });

  it("refuses the rev2 position for an order on rev1 (the factory in its state is not the order's), and for a native GRAM output", async () => {
    const rev1Order = await check(tonapi(), {protocolAddress: REV1});
    expect(rev1Order.ok).toBe(false);
    expect(rev1Order.reasons).toEqual([{reason: "state", details: {check: expect.stringMatching(/^state#5:/)}}]);
    expect(await check(tonapi(), {outputJettonMasterAddress: GRAM})).toEqual({ok: false, reasons: [{reason: "jetton-wallet"}]});
  });
});

describe("SDK-306: EVM → TON output position of the rev1 minter (EQAb9CzW…, deployed 2026-11-10 18:21:16Z, settled)", () => {
  const POS = rev1Position;
  // Decoded from the position's own state (every field is checked in its slot by the validator).
  const WITHDRAWAL_AT = 1_794_334_877;
  const input = {
    positionAddress: POS.position as string, protocolAddress: REV1, outputJettonMasterAddress: USDT,
    recipientAddress: "EQBUStfqDNXubCSXU8hS8GeIT9ZVbxflgjS_rzsNw4V_ErjH",
    quoteId: "4bc2f5b757fb6c29f019ae68a18e27a101e6f2bb2ba79ca6c94def4fc3d82d61",
    quoteTimestamp: WITHDRAWAL_AT - 20,
    inputUnits: "4970266", outputUnits: "4970266", resolverSendsUnits: "4970266", dstSecurityDepositUnits: "500000000",
    secretHash: new Uint8Array(Buffer.from("abd8abc3ec7085cfdc72a3a508d8888570404ea9a64f1db7af702c869885da02", "hex")),
  };
  const tonapi = () => {
    const wallets: Record<string, string> = {[raw(REV1)]: POS.factoryJettonWallet.wallet_address.address, [raw(REV2)]: live.evmToTonPosition.factoryJettonWallet.wallet_address.address};
    return vi.fn(async (url: string) => {
      const json = (body: unknown, ok = true) => ({ok, status: ok ? 200 : 404, json: async () => body}) as unknown as Response;
      if (url.endsWith(`/v2/blockchain/accounts/${encodeURIComponent(POS.position)}`)) return json({address: POS.account.address, status: POS.account.status, code: POS.account.code, data: POS.account.data});
      if (url.endsWith(`/v2/blockchain/accounts/${encodeURIComponent(POS.position)}/transactions?limit=25`)) return json({transactions: structuredClone(POS.transactions)});
      const jettons = /\/v2\/accounts\/([^/]+)\/jettons\/([^/?]+)$/.exec(url);
      if (jettons) {
        const wallet = wallets[raw(decodeURIComponent(jettons[1]!))];
        return wallet && raw(decodeURIComponent(jettons[2]!)) === raw(USDT) ? json({wallet_address: {address: wallet}, jetton: POS.factoryJettonWallet.jetton}) : json({error: "not found"}, false);
      }
      return json({}, false);
    });
  };
  const check = async (pins: {positionCodeHashes?: string[]} = {}, over: Partial<typeof input> = {}, nowSeconds = WITHDRAWAL_AT + 5) => {
    const reasons: {reason: string; details?: Record<string, unknown>}[] = [];
    const ok = await createOmnistonTonValidators({
      fetch: tonapi() as unknown as typeof fetch, now: () => nowSeconds * 1000,
      onRefusal: (reason, details) => reasons.push({reason, ...(details ? {details} : {})}), ...pins,
    }).validateTonOutputPosition!({...input, ...over});
    return {ok, reasons};
  };

  it("the fixture is the real position: rev1 position code, deployed by the rev1 minter, custody at its USD₮ wallet", () => {
    expect(Cell.fromBoc(Buffer.from(POS.account.code, "hex"))[0]!.hash().toString("hex")).toBe(POSITION_REV1);
    const deploy = POS.transactions.find((tx: {in_msg: {op_code: string}}) => tx.in_msg.op_code === "0xf240cd30");
    expect(raw(deploy.in_msg.source.address)).toBe(raw(REV1));
    expect(deploy.utime).toBe(WITHDRAWAL_AT - 1);
    expect(raw(POS.factoryJettonWallet.wallet_address.address)).toBe(raw(REV1_USDT_WALLET));
  });

  it("is refused by default: the rev1 position code left the pins with rev1", async () => {
    expect(await check()).toEqual({ok: false, reasons: [{reason: "position-code-hash", details: {hash: POSITION_REV1}}]});
  });

  it("inside its 6 h window (an EVM → TON order quoted on rev1 just before an upgrade) it passes with the rev1 position code pinned; every other check still runs", async () => {
    expect(await check(POSITIONS_WITH_REV1)).toEqual({ok: true, reasons: []});
    expect((await check(POSITIONS_WITH_REV1, {recipientAddress: REV2})).reasons.map((r) => r.reason)).toEqual(["state"]);
    expect((await check(POSITIONS_WITH_REV1, {secretHash: new Uint8Array(32).fill(8)})).reasons.map((r) => r.reason)).toEqual(["state"]);
  });

  it("more than 6 h after its quote it is refused with quote-age before its code is read, pinned or not: no version closes a rev1 order quoted before the switch", async () => {
    const late = input.quoteTimestamp + 6 * 60 * 60 + 1;
    expect(await check({}, {}, late)).toEqual({ok: false, reasons: [{reason: "quote-age"}]});
    expect(await check(POSITIONS_WITH_REV1, {}, late)).toEqual({ok: false, reasons: [{reason: "quote-age"}]});
    // The day rev1 left the default (2026-11-12 12:00Z) against Omniston's last rev1 quotes (2026-11-10 ~19:00Z): 41 h.
    expect(await check(POSITIONS_WITH_REV1, {quoteTimestamp: Date.UTC(2026, 10, 10, 19) / 1000}, Date.UTC(2026, 10, 12, 12) / 1000))
      .toEqual({ok: false, reasons: [{reason: "quote-age"}]});
  });

  it("cannot stand in for an order on rev2 even with both codes pinned: the factory in its state is rev1", async () => {
    const {ok, reasons} = await check(POSITIONS_WITH_REV1, {protocolAddress: REV2});
    expect(ok).toBe(false);
    expect(reasons).toEqual([{reason: "state", details: {check: expect.stringMatching(/^state#5:/)}}]);
  });
});

describe("SDK-306: a TON → EVM order on rev1 in flight when the app upgrades", () => {
  // A provider on the old default (rev1 trusted, as 0.5.4) quoted and built the order on rev1 (the live 2026-10-10
  // capture); the provider is then rebuilt with the new default table on the same stores. trackIntent reads no trust
  // table, and a TON → EVM disclosure checks only the EVM output position: the order still completes.
  const SECRET = Buffer.from("11".repeat(32), "hex");
  const SECRET_HASH = new Uint8Array(Buffer.from(keccak256(SECRET).slice(2), "hex"));
  const BASE_FACTORY = "0xACa3E2F9b61a44892926bC6c3e104192E7D1c3cd";
  const POSITION = "0x1111111111111111111111111111111111111111";
  const TRADER = "UQCbXJ1-Hd_CyyAt3TNgircduNIn5QH5dj1_LBNz__y4fQaq";
  const RECIPIENT = "0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA";

  it("is tracked and its secret disclosed by the provider with the new default table", async () => {
    const c = rev1Escrows.baseUsdc;
    const q = structuredClone(c.quoteUpdated.value);
    expect(q.settlementData.value.srcProtocolContractAddress.chain.value).toBe(REV1);
    const nowSeconds = Math.floor(Date.now() / 1000);
    q.quoteTimestamp = nowSeconds;
    q.settlementData.value.tradeStartDeadline = nowSeconds + 300;
    vi.useFakeTimers({toFake: ["Date"], now: nowSeconds * 1000});
    vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => { array.set(SECRET.subarray(0, array.length)); return array; }) as never);
    const s = q.settlementData.value;
    const calls: Record<string, unknown[]> = {};
    const client = {
      requestForQuote() { return observable([{$case: "ack", value: {rfqId: q.rfqId}}, {$case: "quoteUpdated", rfqId: q.rfqId, value: q}]); },
      async tonBuildEscrowTransfer(request: unknown) { (calls.build ??= []).push(request); return structuredClone(c.escrowResponse); },
      orderTrack() {
        return observable([{$case: "order", value: {status: "ORDER_STATUS_ACTIVE", executions: [{
          index: 0, inputUnits: q.inputUnits, outputUnits: q.outputUnits, resolverSendsUnits: s.resolverSendsUnits, secretHash: SECRET_HASH,
          outputPositionAddress: {chain: {$case: "base", value: POSITION}}, outputPositionPhase: "EXECUTION_PHASE_READY_FOR_PRIVATE_COMPLETION",
        }]}}]);
      },
      async orderDiscloseHtlcSecret(request: unknown) { (calls.disclose ??= []).push(request); },
    };
    const shared: OmnistonProviderOptions = {
      client: client as never, quoteSettleMs: 0, maxHtlcExecutions: 1, secretStore: inMemorySecretStore(), quoteStore: inMemoryQuoteStore(),
      validateTonJettonWallet: ({walletAddress}) => walletAddress === c.escrowResponse.messages[0].targetAddress,
      validateTonEscrowPayload: () => true,
    };
    const before = omnistonProvider({...shared, trustedSettlementContracts: {...AUDITED_OMNISTON_SETTLEMENT_CONTRACTS, "ton:-239": [REV1]}, validateEvmOutputPosition: async () => true});
    const quote = await before.getQuote({sourceChain: "ton:-239", sourceToken: "USDT", destChain: "eip155:8453", destToken: BASE_USDC,
      amountIn: "5000000", destAddress: RECIPIENT, refundAddress: TRADER, slippageBps: 100, dry: true});
    expect(quote).not.toBeNull();
    await before.buildDeposit(quote!);
    expect(calls.build).toHaveLength(1);
    const output = vi.fn(async () => true);
    const after = omnistonProvider({...shared, trustedSettlementContracts: AUDITED_OMNISTON_SETTLEMENT_CONTRACTS, validateEvmOutputPosition: output});
    await after.trackIntent({intentId: quote!.intentId});
    expect(output).toHaveBeenCalledWith(expect.objectContaining({factoryAddress: BASE_FACTORY, recipientAddress: RECIPIENT, positionAddress: POSITION}));
    expect(calls.disclose).toEqual([{quoteId: q.quoteId, executionIndex: 0, secret: new Uint8Array(SECRET)}]);
  });

  it("is not built by the provider with the new default table when it was only quoted before the upgrade (a shared quote store)", async () => {
    const c = rev1Escrows.baseUsdc;
    const q = structuredClone(c.quoteUpdated.value);
    const nowSeconds = Math.floor(Date.now() / 1000);
    q.quoteTimestamp = nowSeconds;
    q.settlementData.value.tradeStartDeadline = nowSeconds + 300;
    const calls: Record<string, unknown[]> = {};
    const client = {
      requestForQuote() { return observable([{$case: "ack", value: {rfqId: q.rfqId}}, {$case: "quoteUpdated", rfqId: q.rfqId, value: q}]); },
      async tonBuildEscrowTransfer(request: unknown) { (calls.build ??= []).push(request); return structuredClone(c.escrowResponse); },
    };
    const secretStore = inMemorySecretStore();
    const shared: OmnistonProviderOptions = {
      client: client as never, quoteSettleMs: 0, maxHtlcExecutions: 1, secretStore, quoteStore: inMemoryQuoteStore(),
      validateTonJettonWallet: ({walletAddress}) => walletAddress === c.escrowResponse.messages[0].targetAddress,
      validateTonEscrowPayload: () => true,
      validateEvmOutputPosition: async () => true,
    };
    const before = omnistonProvider({...shared, trustedSettlementContracts: {...AUDITED_OMNISTON_SETTLEMENT_CONTRACTS, "ton:-239": [REV1]}});
    const quote = await before.getQuote({sourceChain: "ton:-239", sourceToken: "USDT", destChain: "eip155:8453", destToken: BASE_USDC,
      amountIn: "5000000", destAddress: RECIPIENT, refundAddress: TRADER, slippageBps: 100, dry: true});
    expect(quote).not.toBeNull();
    const after = omnistonProvider({...shared, trustedSettlementContracts: AUDITED_OMNISTON_SETTLEMENT_CONTRACTS});
    await expect(after.buildDeposit(quote!)).rejects.toThrow(`omniston: untrusted TON settlement contract ${REV1}`);
    expect(calls.build).toBeUndefined();
    expect(await secretStore.load(q.quoteId)).toBeUndefined();
  });
});

describe("SDK-306: activity on the rev2 minter", () => {
  // The rev1 escrow order fixture (fixtures/activity/ton-escrow-order-usdt.json, a real tonapi event) with the
  // minter address moved to rev2: recognition is by counterparty address only, so this is exactly the change.
  const rev1 = JSON.parse(readFileSync(new URL("../fixtures/activity/ton-escrow-order-usdt.json", import.meta.url), "utf8")) as ActivityFixtureJson;
  const moved = (to: string) => JSON.parse(JSON.stringify(rev1).split(REV1).join(to)) as ActivityFixtureJson;

  it("tags a TON → EVM order paid to rev2 as bridge, in friendly and raw form", () => {
    for (const to of [REV2, raw(REV2)]) {
      const {tx, own} = parseActivityFixture(moved(to));
      expect(describeOmnistonActivity(tx, {own}), to).toMatchObject({kind: "bridge", title: "Bridged USD₮", counterparty: to});
    }
  });

  it("still tags the rev1 order, and leaves a lookalike minter unrecognized", () => {
    const old = parseActivityFixture(rev1);
    expect(describeOmnistonActivity(old.tx, {own: old.own})).toMatchObject({kind: "bridge", counterparty: REV1});
    const fake = parseActivityFixture(moved(LOOKALIKE));
    expect(describeOmnistonActivity(fake.tx, {own: fake.own})).toBeNull();
  });
});
