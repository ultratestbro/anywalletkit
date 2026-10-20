import "../../src/buffer-global.js";
import {Buffer} from "buffer";
import {describe, expect, it, vi} from "vitest";
import {readFileSync} from "node:fs";
import {Address, beginCell, Cell} from "@ton/core";
import {createOmnistonTonValidators} from "../../src/validators/ton.js";

const OWNER = new Address(0, Buffer.alloc(32, 1)).toString();
const PROTOCOL = new Address(0, Buffer.alloc(32, 2)).toString();
const RESOLVER = new Address(0, Buffer.alloc(32, 3)).toString();
const JETTON_MASTER = new Address(0, Buffer.alloc(32, 4)).toString();
const JETTON_WALLET = new Address(0, Buffer.alloc(32, 5)).toString();
const QUOTE_ID = "11".repeat(32);
const SECRET_HASH = Buffer.alloc(32, 7);
const TOKEN = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const DESTINATION = "0x00000000000000000000000000000000000000cc";

const AUTHORITY = "aa".repeat(32);

function fixture(config: {authority?: string | null; exclusivity?: bigint; postExclusivity?: bigint; parts?: number} = {}) {
  const escrowCode = beginCell().storeUint(0x1234, 16).endCell();
  const executionCode = beginCell().storeUint(0x5678, 16).endCell();
  const ownerData = beginCell()
    .storeAddress(Address.parse(OWNER))
    .storeBit(false)
    .storeCoins(500_000_000n)
    .endCell();
  const execution = beginCell()
    .storeUint(0xc8d4b428, 32)
    .storeBuffer(SECRET_HASH)
    .storeAddress(Address.parse(RESOLVER))
    .storeUint(1, 64)
    .storeUint(120, 64)
    .storeUint(240, 64)
    .storeUint(300, 64)
    .storeRef(ownerData)
    .endCell();
  const state = beginCell().storeRef(executionCode).storeRef(execution).endCell();
  const destination = beginCell()
    .storeUint(1, 64)
    .storeBuffer(Buffer.from(TOKEN.slice(2), "hex"))
    .storeBuffer(Buffer.from(DESTINATION.slice(2), "hex"))
    .storeCoins(990_000n)
    .endCell();
  const authority = config.authority === undefined ? AUTHORITY : config.authority;
  const configBuilder = beginCell()
    .storeUint(0xf2c6fa63, 32)
    .storeAddress(Address.parse(RESOLVER))
    .storeBit(authority !== null);
  if (authority !== null) configBuilder.storeBuffer(Buffer.from(authority, "hex"));
  const configCell = configBuilder
    .storeUint(config.exclusivity ?? 300n, 64)
    .storeUint(config.postExclusivity ?? 0n, 64)
    .storeRef(state)
    .storeMaybeRef(destination)
    .storeUint(config.parts ?? 0, 16)
    .endCell();
  const auxiliary = beginCell().storeBuffer(Buffer.alloc(67)).storeBit(false).storeRef(beginCell().endCell()).endCell();
  const flags = beginCell().storeUint(0, 98).endCell();
  const forward = beginCell()
    .storeUint(0xc0a5f0d9, 32)
    .storeBuffer(Buffer.from(QUOTE_ID, "hex"))
    .storeBit(false)
    .storeAddress(Address.parse(OWNER))
    .storeCoins(120_000_000n)
    .storeBit(false)
    .storeRef(configCell)
    .storeRef(escrowCode)
    .storeRef(auxiliary)
    .storeRef(flags)
    .endCell();
  const payload = beginCell()
    .storeUint(0x0f8a7ea5, 32)
    .storeUint(1, 64)
    .storeCoins(1_000_000n)
    .storeAddress(Address.parse(PROTOCOL))
    .storeAddress(Address.parse(OWNER))
    .storeMaybeRef(null)
    .storeCoins(300_000_000n)
    .storeBit(true)
    .storeRef(forward)
    .endCell();
  return {
    payloadBocHex: payload.toBoc().toString("hex"),
    forwardPayloadBocHex: forward.toBoc().toString("hex"),
    escrowCodeHash: escrowCode.hash().toString("hex"),
    executionCodeHash: executionCode.hash().toString("hex"),
  };
}

function payloadInput(f = fixture()) {
  return {
    payloadBocHex: f.payloadBocHex,
    forwardPayloadBocHex: f.forwardPayloadBocHex,
    quoteId: QUOTE_ID,
    inputUnits: "1000000",
    resolverSendsUnits: "990000",
    srcHtlcSecurityDepositUnits: "500000000",
    protocolAddress: PROTOCOL,
    ownerAddress: OWNER,
    destinationChain: "ethereum",
    destinationAddress: DESTINATION,
    outputTokenAddress: TOKEN,
    initialResolverAddress: RESOLVER,
    secretHashes: [SECRET_HASH],
    hashingFunction: "HASHING_FUNCTION_KECCAK256",
    exclusivityTimeout: 300,
  } as const;
}

function validatorsFor(f: ReturnType<typeof fixture>) {
  return createOmnistonTonValidators({
    escrowCodeHashes: [f.escrowCodeHash],
    executionCodeHashes: [f.executionCodeHash],
    authorityKeys: [AUTHORITY],
  });
}

describe("Omniston TON validation", () => {
  it("accepts the reviewed escrow schema with every fund-critical field bound", async () => {
    const f = fixture();
    const validators = validatorsFor(f);
    expect(validators.validateTonEscrowPayload!(payloadInput(f))).toBe(true);
  });

  it("rejects destination, amount, hashlock, and code substitutions", async () => {
    const f = fixture();
    const validators = validatorsFor(f);
    const valid = payloadInput(f);
    expect(validators.validateTonEscrowPayload!({...valid, destinationAddress: `0x${"dd".repeat(20)}`})).toBe(false);
    expect(validators.validateTonEscrowPayload!({...valid, resolverSendsUnits: "989999"})).toBe(false);
    expect(validators.validateTonEscrowPayload!({...valid, secretHashes: [Buffer.alloc(32, 8)]})).toBe(false);
    const wrongCode = createOmnistonTonValidators({
      escrowCodeHashes: ["00".repeat(32)],
      executionCodeHashes: [f.executionCodeHash],
      authorityKeys: [AUTHORITY],
    });
    expect(wrongCode.validateTonEscrowPayload!(valid)).toBe(false);
  });

  it("binds the escrow config timing to the quote and refuses unreviewed profiles", () => {
    const valid = (f: ReturnType<typeof fixture>, input: Record<string, unknown> = {}) =>
      validatorsFor(f).validateTonEscrowPayload!({...payloadInput(f), ...input});
    expect(valid(fixture())).toBe(true);
    // exclusivityTimeout must equal what the quote said, and be present at all
    expect(valid(fixture(), {exclusivityTimeout: 299})).toBe(false);
    expect(valid(fixture(), {exclusivityTimeout: undefined})).toBe(false);
    expect(valid(fixture({exclusivity: 900n}))).toBe(false);
    // a long lock is refused even if the quote agrees with it
    expect(valid(fixture({exclusivity: 7_200n}), {exclusivityTimeout: 7_200})).toBe(false);
    // the August profile (30 s exclusivity + 30 s post-exclusivity window) has a Dutch-auction phase
    expect(valid(fixture({exclusivity: 30n, postExclusivity: 30n}), {exclusivityTimeout: 30})).toBe(false);
    // partial fills, a missing or unknown authority key
    expect(valid(fixture({parts: 2}))).toBe(false);
    expect(valid(fixture({authority: null}))).toBe(false);
    expect(valid(fixture({authority: "bb".repeat(32)}))).toBe(false);
  });

  describe("live escrow payload (2026-10-10, resolver Arbiter, TON USDT → Base USDC)", () => {
    const live = JSON.parse(readFileSync(new URL("../fixtures/live-2026-10-10.json", import.meta.url), "utf8"));
    const base = live.baseUsdc;
    const quote = base.quoteUpdated.value;
    const order = quote.settlementData.value;
    const payloadBocHex = base.escrowResponse.messages[0].payload as string;
    const forward = Cell.fromBoc(Buffer.from(payloadBocHex, "hex"))[0]!.refs[0]!;
    const input = {
      payloadBocHex,
      forwardPayloadBocHex: forward.toBoc().toString("hex"),
      quoteId: quote.quoteId,
      inputUnits: quote.inputUnits,
      resolverSendsUnits: order.resolverSendsUnits,
      srcHtlcSecurityDepositUnits: order.srcHtlcSecurityDepositUnits,
      protocolAddress: order.srcProtocolContractAddress.chain.value,
      ownerAddress: base.escrowRequest.ownerSrcAddress.chain.value,
      destinationChain: "base",
      destinationAddress: base.escrowRequest.traderDstAddress.chain.value,
      outputTokenAddress: quote.outputAsset.chain.value.kind.value,
      initialResolverAddress: order.srcInitialResolverAddress.chain.value,
      secretHashes: [Buffer.from((base.escrowSecretHash[0] as string).slice(2), "hex")],
      hashingFunction: order.htlcHashingFunction,
      exclusivityTimeout: order.exclusivityTimeout,
    };

    it("passes with the default audited code hashes and authority key", () => {
      expect(order.exclusivityTimeout).toBe(300);
      expect(createOmnistonTonValidators().validateTonEscrowPayload!(input)).toBe(true);
    });

    it("refuses the same bytes for any other recipient, amount, hashlock or exclusivity", () => {
      const v = createOmnistonTonValidators().validateTonEscrowPayload!;
      expect(v({...input, destinationAddress: `0x${"dd".repeat(20)}`})).toBe(false);
      expect(v({...input, resolverSendsUnits: String(BigInt(input.resolverSendsUnits) + 1n)})).toBe(false);
      expect(v({...input, inputUnits: "5000001"})).toBe(false);
      expect(v({...input, secretHashes: [Buffer.alloc(32, 8)]})).toBe(false);
      const otherExclusivity = {...input, exclusivityTimeout: 30};
      expect(v(otherExclusivity)).toBe(false);
      expect(v({...input, ownerAddress: OWNER})).toBe(false);
    });
  });

  it("derives the sender jetton wallet independently through TonAPI", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      wallet_address: {address: JETTON_WALLET},
      jetton: {address: JETTON_MASTER},
    }), {status: 200, headers: {"content-type": "application/json"}}));
    const validators = createOmnistonTonValidators({fetch: request as typeof fetch, tonApiUrl: "https://ton.example", tonApiKey: "key"});
    await expect(validators.validateTonJettonWallet!({
      ownerAddress: OWNER,
      jettonMasterAddress: JETTON_MASTER,
      walletAddress: JETTON_WALLET,
    })).resolves.toBe(true);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toContain(encodeURIComponent(OWNER));
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({Authorization: "Bearer key"});
  });

  describe("swap target (same-chain swaps)", () => {
    const ROUTER = "0:92e1411ae546892f33b2c8a89ea90390d8ff4cfbb917a643b91e73f706fdb9d1";
    const PTON_WALLET = "EQCSIMGBps_qzRG3uPYhON8bucyCtu0mYdL1-u4gSz77IBa3";
    const PTON_V2 = "0:671963027f7f85659ab55b821671688601cdcf1ee674fc7fbbb1a776a18d34a3";
    const USDT_MASTER = "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe";
    const respond = (body: unknown) => new Response(JSON.stringify(body), {status: 200, headers: {"content-type": "application/json"}});
    /** tonapi stub keyed by path suffix: account reads and get_wallet_data. */
    const tonapi = (accounts: Record<string, {interfaces: string[]; is_wallet?: boolean}>, walletData?: {owner: string; jetton: string}) =>
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/methods/get_wallet_data")) return respond({success: true, decoded: walletData});
        const id = decodeURIComponent(url.split("/v2/accounts/")[1] ?? "");
        const account = accounts[id];
        return account ? respond({address: id, ...account}) : new Response("{}", {status: 404});
      });

    it("accepts a contract carrying a DEX code interface", async () => {
      const request = tonapi({[ROUTER]: {interfaces: ["stonfi_router_v2"]}});
      const validators = createOmnistonTonValidators({fetch: request as typeof fetch});
      await expect(validators.validateTonSwapTarget!({address: ROUTER, protocols: ["StonFiV2"]})).resolves.toBe(true);
      expect(request).toHaveBeenCalledOnce();
    });

    it("accepts the router's proxy-TON wallet — pTON master AND a DEX-router owner, both read on-chain", async () => {
      const request = tonapi(
        {[PTON_WALLET]: {interfaces: ["jetton_wallet"]}, [ROUTER]: {interfaces: ["stonfi_router_v2"]}},
        {owner: ROUTER, jetton: PTON_V2},
      );
      const validators = createOmnistonTonValidators({fetch: request as typeof fetch});
      await expect(validators.validateTonSwapTarget!({address: PTON_WALLET, protocols: ["StonFiV2"]})).resolves.toBe(true);
      expect(request).toHaveBeenCalledTimes(3);
    });

    it("refuses a jetton wallet whose master is not pTON, even when a router owns it", async () => {
      const request = tonapi(
        {[PTON_WALLET]: {interfaces: ["jetton_wallet"]}, [ROUTER]: {interfaces: ["stonfi_router_v2"]}},
        {owner: ROUTER, jetton: USDT_MASTER},
      );
      const validators = createOmnistonTonValidators({fetch: request as typeof fetch});
      await expect(validators.validateTonSwapTarget!({address: PTON_WALLET, protocols: ["StonFiV2"]})).resolves.toBe(false);
    });

    it("refuses a pTON wallet owned by an EOA", async () => {
      const request = tonapi(
        {[PTON_WALLET]: {interfaces: ["jetton_wallet"]}, [OWNER]: {interfaces: ["wallet_v4r2"], is_wallet: true}},
        {owner: OWNER, jetton: PTON_V2},
      );
      const validators = createOmnistonTonValidators({fetch: request as typeof fetch});
      await expect(validators.validateTonSwapTarget!({address: PTON_WALLET, protocols: ["StonFiV2"]})).resolves.toBe(false);
    });

    it("refuses wallets, unknown code and unreachable accounts", async () => {
      const request = tonapi({[OWNER]: {interfaces: ["wallet_v4r2"], is_wallet: true}, [ROUTER]: {interfaces: ["nft_sale"]}});
      const validators = createOmnistonTonValidators({fetch: request as typeof fetch});
      await expect(validators.validateTonSwapTarget!({address: OWNER, protocols: ["StonFiV2"]})).resolves.toBe(false);
      await expect(validators.validateTonSwapTarget!({address: ROUTER, protocols: ["StonFiV2"]})).resolves.toBe(false);
      await expect(validators.validateTonSwapTarget!({address: PTON_WALLET, protocols: ["StonFiV2"]})).resolves.toBe(false);
    });
  });
});

describe("Omniston TON output position (EVM→TON) validator", () => {
  const FACTORY = "EQAbWJ3Y1HgIIvcMq1prG1anlDC0T3cZlAU7luPT6LmTpmrZ";
  const JETTON_WALLET_OF_FACTORY = "EQA76qndaGh9F43jfgTVAuvJvuGzA8uLNQ7iC1XZ-X5X6CDa";
  const USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
  const RECIPIENT = "UQCbXJ1-Hd_CyyAt3TNgircduNIn5QH5dj1_LBNz__y4fQaq";
  const RESOLVER_TON = "EQCOPHYSaiB-c3bH4js_jIIwVhLxikq4edDNbtJcjY0Rsg88";
  const POSITION = "EQAbT3jirqSDgQG-_AyNuaGO0YTWHw2sZK8wPApw8x40VV2C";
  const QUOTE = "4d2404efcb47fec1be02eeae5b4cda068b395db7bf6aa47604f63dd4483eadb4";
  const HASHLOCK = Buffer.from("2eb571944f8c7160e23f75b2a72863ea6598466d80c1912c915af81888459ece", "hex");
  const DEPLOYED_AT = 1_792_096_690;
  const positionCode = beginCell().storeUint(0xe4d5, 16).endCell();
  const escrowCode = beginCell().storeUint(0xd304, 16).endCell();
  const raw = (friendly: string) => Address.parse(friendly).toRawString();

  /** The live layout of a resolver-created position (decoded 2026-10-16). */
  function stateCell(over: {
    quoteId?: string; factory?: string; jettonWallet?: string; master?: string; hashlock?: Buffer; amount?: bigint;
    withdrawalAt?: bigint; publicWithdrawalAt?: bigint; cancellationAt?: bigint; recipient?: string; deposit?: bigint; authority?: string; escrow?: Cell;
  } = {}): Cell {
    const withdrawalAt = over.withdrawalAt ?? BigInt(DEPLOYED_AT + 1);
    const fees = beginCell().storeAddress(new Address(0, Buffer.alloc(32, 9))).storeUint(200, 64).storeUint(0, 32).endCell();
    const gas = beginCell().storeAddress(Address.parse(JETTON_WALLET_OF_FACTORY)).storeUint(620_000_000n, 64).storeAddress(Address.parse(RESOLVER_TON)).endCell();
    const parties = beginCell().storeAddress(Address.parse(RESOLVER_TON)).storeAddress(Address.parse(over.master ?? USDT)).storeUint(0, 6).storeRef(fees).storeRef(gas).endCell();
    const terms = beginCell().storeAddress(Address.parse(over.recipient ?? RECIPIENT)).storeAddress(Address.parse(RESOLVER_TON)).storeCoins(over.deposit ?? 500_000_000n).endCell();
    const authority = beginCell().storeBit(true).storeBuffer(Buffer.from(over.authority ?? AUTHORITY, "hex")).storeAddress(Address.parse(over.recipient ?? RECIPIENT)).endCell();
    const lock = beginCell()
      .storeBuffer(over.hashlock ?? HASHLOCK).storeCoins(over.amount ?? 10_490_741n)
      .storeUint(withdrawalAt, 64).storeUint(over.publicWithdrawalAt ?? withdrawalAt + 119n, 64).storeUint(over.cancellationAt ?? withdrawalAt + 179n, 64)
      .storeRef(terms).storeRef(authority).endCell();
    return beginCell()
      .storeUint(3, 8).storeBuffer(Buffer.from(over.quoteId ?? QUOTE, "hex"))
      .storeAddress(Address.parse(over.factory ?? FACTORY)).storeAddress(Address.parse(over.jettonWallet ?? JETTON_WALLET_OF_FACTORY)).storeUint(0, 5)
      .storeRef(parties).storeRef(lock).storeRef(over.escrow ?? escrowCode).endCell();
  }

  function api(over: {data?: Cell; code?: Cell; status?: string; deployer?: string; op?: string; success?: boolean; utime?: number; wallet?: string} = {}) {
    return vi.fn(async (url: string) => {
      const json = (body: unknown, ok = true) => ({ok, json: async () => body}) as unknown as Response;
      if (url.endsWith(`/v2/blockchain/accounts/${encodeURIComponent(POSITION)}`)) {
        return json({address: raw(POSITION), status: over.status ?? "active", code: (over.code ?? positionCode).toBoc().toString("base64"), data: (over.data ?? stateCell()).toBoc().toString("base64")});
      }
      if (url.includes(`/v2/accounts/${encodeURIComponent(FACTORY)}/jettons/`)) {
        return json({wallet_address: {address: raw(over.wallet ?? JETTON_WALLET_OF_FACTORY)}, jetton: {address: raw(USDT)}});
      }
      if (url.endsWith(`/v2/blockchain/accounts/${encodeURIComponent(POSITION)}/transactions?limit=25`)) {
        return json({transactions: [
          {success: true, aborted: false, utime: DEPLOYED_AT + 13, in_msg: {source: {address: raw(RESOLVER_TON)}, op_code: "0x57eff897"}},
          {success: over.success ?? true, aborted: false, utime: over.utime ?? DEPLOYED_AT, in_msg: {source: {address: raw(over.deployer ?? FACTORY)}, op_code: over.op ?? "0xf240cd30"}},
        ]});
      }
      return json({}, false);
    });
  }

  const input = {
    positionAddress: POSITION, protocolAddress: FACTORY, outputJettonMasterAddress: USDT, recipientAddress: RECIPIENT,
    quoteId: QUOTE, quoteTimestamp: DEPLOYED_AT - 20, inputUnits: "10500000", outputUnits: "10489691", resolverSendsUnits: "10490741",
    dstSecurityDepositUnits: "500000000", secretHash: new Uint8Array(HASHLOCK),
  };
  const validators = (fetchImpl: ReturnType<typeof api>, nowSeconds = DEPLOYED_AT + 30) => createOmnistonTonValidators({
    fetch: fetchImpl as unknown as typeof fetch, now: () => nowSeconds * 1000,
    authorityKeys: [AUTHORITY], positionCodeHashes: [positionCode.hash().toString("hex")], outputEscrowCodeHashes: [escrowCode.hash().toString("hex")],
  });

  it("accepts a factory-deployed position with the pinned code and state bound to the quote", async () => {
    await expect(validators(api()).validateTonOutputPosition!(input)).resolves.toBe(true);
  });

  it("refuses every state field that drifts from the quote", async () => {
    const cases: [string, Cell][] = [
      ["another quote", stateCell({quoteId: "ff".repeat(32)})],
      ["another factory", stateCell({factory: RESOLVER_TON})],
      ["custody at a foreign wallet", stateCell({jettonWallet: RESOLVER_TON})],
      ["another jetton", stateCell({master: FACTORY})],
      ["another hashlock", stateCell({hashlock: Buffer.alloc(32, 1)})],
      ["less than the resolver must send", stateCell({amount: 10_490_740n})],
      ["another recipient", stateCell({recipient: RESOLVER_TON})],
      ["smaller security deposit", stateCell({deposit: 1n})],
      ["unknown authority key", stateCell({authority: "bb".repeat(32)})],
      ["unknown escrow code", stateCell({escrow: beginCell().storeUint(1, 8).endCell()})],
      ["foreign timelock profile", stateCell({cancellationAt: BigInt(DEPLOYED_AT + 1 + 60)})],
      ["deployed long before the quote", stateCell({withdrawalAt: BigInt(DEPLOYED_AT - 200), publicWithdrawalAt: BigInt(DEPLOYED_AT - 81), cancellationAt: BigInt(DEPLOYED_AT - 21)})],
    ];
    for (const [label, data] of cases) {
      await expect(validators(api({data})).validateTonOutputPosition!(input), label).resolves.toBe(false);
    }
  });

  it("refuses a position the factory did not deploy, or that is not active / not the pinned code", async () => {
    await expect(validators(api({deployer: RESOLVER_TON})).validateTonOutputPosition!(input)).resolves.toBe(false);
    await expect(validators(api({op: "0x57eff897"})).validateTonOutputPosition!(input)).resolves.toBe(false);
    await expect(validators(api({success: false})).validateTonOutputPosition!(input)).resolves.toBe(false);
    await expect(validators(api({utime: DEPLOYED_AT - 30})).validateTonOutputPosition!(input)).resolves.toBe(false);
    await expect(validators(api({status: "frozen"})).validateTonOutputPosition!(input)).resolves.toBe(false);
    await expect(validators(api({code: beginCell().storeUint(7, 8).endCell()})).validateTonOutputPosition!(input)).resolves.toBe(false);
    await expect(validators(api({wallet: RESOLVER_TON})).validateTonOutputPosition!(input)).resolves.toBe(false);
  });

  it("refuses to disclose within 45 s of the position's cancellation boundary", async () => {
    await expect(validators(api(), DEPLOYED_AT + 1 + 179 - 46).validateTonOutputPosition!(input)).resolves.toBe(true);
    await expect(validators(api(), DEPLOYED_AT + 1 + 179 - 45).validateTonOutputPosition!(input)).resolves.toBe(false);
    await expect(validators(api(), DEPLOYED_AT + 400).validateTonOutputPosition!(input)).resolves.toBe(false);
  });

  it("never throws: an indexer failure is a refusal", async () => {
    const down = vi.fn(async () => { throw new Error("tonapi down"); });
    await expect(validators(down as never).validateTonOutputPosition!(input)).resolves.toBe(false);
  });
});
