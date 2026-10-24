/**
 * Fund-safety regression tests. Each of these pins an invariant whose loss
 * strands or donates user funds: memo canonicalization (a gateway-spelled
 * memo is never executed verbatim), the memo shape gate (destination, LIM,
 * affiliate, no streaming / aggregator tails), the vault/router anti-rotation
 * binding, and the pre-broadcast calldata re-verification. Deleting any of
 * those code paths in provider.ts must fail at least one test here.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeFunctionData} from "viem";
import {thorchainProvider} from "../src/provider.js";
import type {Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";

const VAULT = "0x1111111111111111111111111111111111111111";
const VAULT_ROTATED = "0x2222222222222222222222222222222222222222";
const ROUTER = "0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146";
const ROUTER_ROTATED = "0x3333333333333333333333333333333333333333";
const NATIVE = "0x0000000000000000000000000000000000000000";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const BTC_DEST = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const ETH_REFUND = "0x9999999999999999999999999999999999999999";
const NODE = "https://thor.invalid";

const ROUTER_ABI = [
  {
    type: "function",
    name: "depositWithExpiry",
    stateMutability: "payable",
    inputs: [
      {name: "vault", type: "address"},
      {name: "asset", type: "address"},
      {name: "amount", type: "uint256"},
      {name: "memo", type: "string"},
      {name: "expiration", type: "uint256"},
    ],
    outputs: [],
  },
] as const;

/** 0.05 ETH — exactly representable in THORChain's 1e8 units. */
const AMOUNT_ETH = "50000000000000000";
const LIMIT_SATS = "95000";

interface Gateway {
  quote: Record<string, unknown> | null;
  quoteStatus: number;
  inbounds: Record<string, unknown>[] | null;
  /** Every quote URL the provider requested, in order. */
  quoteUrls: string[];
}

let gw: Gateway;

function inbound(overrides: Partial<Record<string, unknown>> = {}) {
  return [
    {chain: "ETH", address: VAULT, router: ROUTER, halted: false, global_trading_paused: false, chain_trading_paused: false, ...overrides},
    {chain: "BTC", address: BTC_DEST, halted: false, global_trading_paused: false, chain_trading_paused: false},
  ];
}

function quoteBody(memo: string, overrides: Record<string, unknown> = {}) {
  return {
    expected_amount_out: "100000",
    inbound_address: VAULT,
    router: ROUTER,
    memo,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    total_swap_seconds: 600,
    ...overrides,
  };
}

function params(overrides: Partial<QuoteParams> = {}): QuoteParams {
  return {
    sourceChain: "eip155:1",
    sourceToken: "ETH",
    destChain: "bitcoin:mainnet",
    destToken: NATIVE,
    amountIn: AMOUNT_ETH,
    destAddress: BTC_DEST,
    ...overrides,
  };
}

function decodeDeposit(data: string) {
  const d = decodeFunctionData({abi: ROUTER_ABI, data: data as `0x${string}`});
  const [vault, asset, amount, memo, expiry] = d.args as readonly [string, string, bigint, string, bigint];
  return {fn: d.functionName, vault, asset, amount, memo, expiry};
}

async function toTx(quote: Quote): Promise<UnsignedTx> {
  return thorchainProvider({nodeUrl: NODE}).buildDeposit(quote);
}

beforeEach(() => {
  gw = {quote: quoteBody(`=:b:${BTC_DEST}:${LIMIT_SATS}`), quoteStatus: 200, inbounds: inbound(), quoteUrls: []};
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/thorchain/quote/swap")) {
      gw.quoteUrls.push(url);
      return new Response(JSON.stringify(gw.quote ?? {error: "no quote"}), {status: gw.quoteStatus});
    }
    if (url.includes("/thorchain/inbound_addresses")) {
      if (!gw.inbounds) return new Response("upstream down", {status: 503});
      return new Response(JSON.stringify(gw.inbounds), {status: 200});
    }
    return new Response("not found", {status: 404});
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("memo canonicalization (a gateway-spelled memo is never executed)", () => {
  it("rebuilds the memo from local route facts and binds the calldata to it", async () => {
    const q = await thorchainProvider({nodeUrl: NODE}).getQuote(params());
    expect(q).not.toBeNull();
    const canonical = `=:BTC.BTC:${BTC_DEST}:${LIMIT_SATS}`;
    expect(q!.providerData?.memo).toBe(canonical);
    const call = decodeDeposit(q!.txRequest!.data!);
    expect(call.fn).toBe("depositWithExpiry");
    expect(call.memo).toBe(canonical); // NOT the gateway's "=:b:..." spelling
    expect(call.vault.toLowerCase()).toBe(VAULT);
    expect(call.asset).toBe(NATIVE);
    expect(call.amount).toBe(BigInt(AMOUNT_ETH));
    expect(call.expiry).toBe(BigInt(q!.providerData!.expiry!));
    expect(q!.txRequest!.to).toBe(ROUTER);
    expect(q!.txRequest!.value).toBe(AMOUNT_ETH);
    expect(q!.txRequest!.chainId).toBe(1);
    expect(q!.txRequest!.approvalAddress).toBeUndefined();
    // Floor in dest base units == memo LIM (sats).
    expect(q!.minDestAmount).toBe(LIMIT_SATS);
    expect(q!.destAmount).toBe("100000");
  });

  it("keeps the refund address in the destination field and canonicalizes around it", async () => {
    gw.quote = quoteBody(`=:b:${BTC_DEST}/${ETH_REFUND}:${LIMIT_SATS}`);
    const q = await thorchainProvider({nodeUrl: NODE}).getQuote(params({refundAddress: ETH_REFUND}));
    expect(q?.providerData?.memo).toBe(`=:BTC.BTC:${BTC_DEST}/${ETH_REFUND}:${LIMIT_SATS}`);
  });

  it("refuses a memo whose destination is not ours", async () => {
    gw.quote = quoteBody(`=:b:bc1qattacker0000000000000000000000000000000:${LIMIT_SATS}`);
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(params())).resolves.toBeNull();
  });

  it("refuses a memo that drops the refund address we asked for", async () => {
    gw.quote = quoteBody(`=:b:${BTC_DEST}:${LIMIT_SATS}`);
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(params({refundAddress: ETH_REFUND}))).resolves.toBeNull();
  });

  it("refuses a streaming-swap LIM/INTERVAL/QTY (per-sub-swap floor is not an atomic floor)", async () => {
    gw.quote = quoteBody(`=:b:${BTC_DEST}:${LIMIT_SATS}/1/0`);
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(params())).resolves.toBeNull();
  });

  it("refuses a DEX-aggregator tail", async () => {
    gw.quote = quoteBody(`=:b:${BTC_DEST}:${LIMIT_SATS}|0xdeadbeef`);
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(params())).resolves.toBeNull();
  });

  it("refuses a memo with no LIM (an unbounded swap) or a non-numeric LIM", async () => {
    gw.quote = quoteBody(`=:b:${BTC_DEST}:0`);
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(params())).resolves.toBeNull();
    gw.quote = quoteBody(`=:b:${BTC_DEST}:`);
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(params())).resolves.toBeNull();
    gw.quote = quoteBody(`=:b:${BTC_DEST}`);
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(params())).resolves.toBeNull();
    gw.quote = quoteBody(`=:b:${BTC_DEST}:9e4`);
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(params())).resolves.toBeNull();
  });

  it("refuses a non-swap memo op", async () => {
    gw.quote = quoteBody(`+:b:${BTC_DEST}:${LIMIT_SATS}`);
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(params())).resolves.toBeNull();
  });

  it("refuses an affiliate tail we did not configure, and a mismatched one when we did", async () => {
    gw.quote = quoteBody(`=:b:${BTC_DEST}:${LIMIT_SATS}:thor1attacker:100`);
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(params())).resolves.toBeNull();

    const affiliated = thorchainProvider({nodeUrl: NODE, affiliate: "vv", affiliateBps: "10"});
    gw.quote = quoteBody(`=:b:${BTC_DEST}:${LIMIT_SATS}:vv:100`); // wrong bps
    await expect(affiliated.getQuote(params())).resolves.toBeNull();
    gw.quote = quoteBody(`=:b:${BTC_DEST}:${LIMIT_SATS}:other:10`); // wrong name
    await expect(affiliated.getQuote(params())).resolves.toBeNull();
    gw.quote = quoteBody(`=:b:${BTC_DEST}:${LIMIT_SATS}`); // affiliate silently dropped
    await expect(affiliated.getQuote(params())).resolves.toBeNull();
    gw.quote = quoteBody(`=:b:${BTC_DEST}:${LIMIT_SATS}:vv:10`);
    const q = await affiliated.getQuote(params());
    expect(q?.providerData?.memo).toBe(`=:BTC.BTC:${BTC_DEST}:${LIMIT_SATS}:vv:10`);
    expect(decodeDeposit(q!.txRequest!.data!).memo).toBe(`=:BTC.BTC:${BTC_DEST}:${LIMIT_SATS}:vv:10`);
  });

  it("always asks the node for a single non-streaming simulation", async () => {
    await thorchainProvider({nodeUrl: NODE}).getQuote(params());
    expect(gw.quoteUrls).toHaveLength(1);
    expect(new URL(gw.quoteUrls[0]!).searchParams.get("streaming_quantity")).toBe("1");
    expect(new URL(gw.quoteUrls[0]!).searchParams.get("tolerance_bps")).toBe("300");
  });

  it("widens the tolerance once on a price-limit rejection, on the same host, never past the cap", async () => {
    const provider = thorchainProvider({nodeUrl: NODE});
    const bodies: {status: number; body: unknown}[] = [
      {status: 400, body: {code: 3, message: "failed to simulate swap: emit asset 61302 less than price limit 61597"}},
      {status: 200, body: quoteBody(`=:b:${BTC_DEST}:60981`)},
    ];
    const inb = gw.inbounds;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/quote/swap")) {
        gw.quoteUrls.push(url);
        const next = bodies.shift()!;
        return new Response(JSON.stringify(next.body), {status: next.status});
      }
      return new Response(JSON.stringify(inb), {status: 200});
    });
    const q = await provider.getQuote(params());
    expect(q?.minDestAmount).toBe("60981");
    expect(gw.quoteUrls.map((u) => new URL(u).searchParams.get("tolerance_bps"))).toEqual(["300", "397"]);
    // An explicit caller slippage is a hard ceiling: no adaptive widening.
    gw.quoteUrls = [];
    bodies.push({status: 400, body: {code: 3, message: "emit asset 61302 less than price limit 61597"}});
    await expect(provider.getQuote(params({slippageBps: 300}))).resolves.toBeNull();
    expect(gw.quoteUrls).toHaveLength(1);
  });

  it("honours the caller's output floor against the memo LIM", async () => {
    const provider = thorchainProvider({nodeUrl: NODE});
    await expect(provider.getQuote(params({minAmountOut: "95001"}))).resolves.toBeNull();
    await expect(provider.getQuote(params({minAmountOut: "95000"}))).resolves.not.toBeNull();
  });

  it("refuses a source amount THORChain cannot price exactly (1e8 dust would be donated)", async () => {
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(params({amountIn: "50000000000000001"}))).resolves.toBeNull();
  });

  it("binds ERC-20 sources to the token contract, zero value and a router approval", async () => {
    gw.quote = quoteBody(`=:b:${BTC_DEST}:${LIMIT_SATS}`);
    const q = await thorchainProvider({nodeUrl: NODE}).getQuote(params({sourceToken: "USDC", amountIn: "100000000"}));
    expect(q).not.toBeNull();
    const call = decodeDeposit(q!.txRequest!.data!);
    expect(call.asset.toLowerCase()).toBe(USDC);
    expect(call.amount).toBe(100000000n);
    expect(q!.txRequest!.value).toBe("0");
    expect(q!.txRequest!.approvalAddress).toBe(ROUTER);
  });
});

describe("vault/router anti-rotation binding at quote time", () => {
  it("refuses a quote whose inbound vault differs from the inbound snapshot", async () => {
    gw.inbounds = inbound({address: VAULT_ROTATED});
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(params())).resolves.toBeNull();
  });

  it("refuses a quote whose router differs from the inbound snapshot", async () => {
    gw.inbounds = inbound({router: ROUTER_ROTATED});
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(params())).resolves.toBeNull();
  });

  it("refuses when the source or destination chain is halted/paused", async () => {
    const provider = thorchainProvider({nodeUrl: NODE});
    gw.inbounds = inbound({halted: true});
    await expect(provider.getQuote(params())).resolves.toBeNull();
    gw.inbounds = inbound({chain_trading_paused: true});
    await expect(provider.getQuote(params())).resolves.toBeNull();
    gw.inbounds = inbound({global_trading_paused: true});
    await expect(provider.getQuote(params())).resolves.toBeNull();
    gw.inbounds = [inbound()[0]!]; // BTC entry missing → paused
    await expect(provider.getQuote(params())).resolves.toBeNull();
  });

  it("fails closed when the inbound snapshot cannot be fetched", async () => {
    gw.inbounds = null;
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(params())).resolves.toBeNull();
  });

  it("refuses a quote without a router for an EVM source", async () => {
    gw.quote = quoteBody(`=:b:${BTC_DEST}:${LIMIT_SATS}`, {router: undefined});
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(params())).resolves.toBeNull();
  });
});

describe("pre-broadcast calldata re-verification", () => {
  let provider: ReturnType<typeof thorchainProvider>;
  let quote: Quote;
  let tx: UnsignedTx;

  beforeEach(async () => {
    provider = thorchainProvider({nodeUrl: NODE});
    quote = (await provider.getQuote(params()))!;
    expect(quote).not.toBeNull();
    tx = await toTx(quote);
  });

  it("accepts the exact transaction it built", async () => {
    await expect(provider.preflightDeposit!(quote, tx)).resolves.toBeUndefined();
  });

  it("rejects calldata whose memo was altered after the quote", async () => {
    const data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: "depositWithExpiry",
      args: [VAULT, NATIVE, BigInt(AMOUNT_ETH), `=:BTC.BTC:bc1qattacker0000000000000000000000000000000:${LIMIT_SATS}`, BigInt(quote.providerData!.expiry!)],
    });
    await expect(provider.preflightDeposit!(quote, {...tx, data})).rejects.toThrow(/does not match/);
  });

  it("rejects calldata whose vault, amount or expiry was altered", async () => {
    const mk = (vault: string, amount: bigint, expiry: bigint) => encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: "depositWithExpiry",
      args: [vault as `0x${string}`, NATIVE, amount, quote.providerData!.memo!, expiry],
    });
    const exp = BigInt(quote.providerData!.expiry!);
    await expect(provider.preflightDeposit!(quote, {...tx, data: mk(VAULT_ROTATED, BigInt(AMOUNT_ETH), exp)})).rejects.toThrow(/does not match/);
    await expect(provider.preflightDeposit!(quote, {...tx, data: mk(VAULT, BigInt(AMOUNT_ETH) * 2n, exp)})).rejects.toThrow(/does not match/);
    await expect(provider.preflightDeposit!(quote, {...tx, data: mk(VAULT, BigInt(AMOUNT_ETH), exp + 1n)})).rejects.toThrow(/does not match/);
  });

  it("rejects a transaction aimed at a different contract, or with a different value", async () => {
    await expect(provider.preflightDeposit!(quote, {...tx, to: ROUTER_ROTATED})).rejects.toThrow(/router/);
    await expect(provider.preflightDeposit!(quote, {...tx, value: "0"})).rejects.toThrow(/value\/approval/);
    await expect(provider.preflightDeposit!(quote, {...tx, approvalAddress: ROUTER})).rejects.toThrow(/value\/approval/);
  });

  it("rejects missing or malformed calldata (a plain transfer would strand funds)", async () => {
    const {data: _drop, ...bare} = tx;
    await expect(provider.preflightDeposit!(quote, bare)).rejects.toThrow(/missing depositWithExpiry/);
    await expect(provider.preflightDeposit!(quote, {...tx, data: "0xdeadbeef"})).rejects.toThrow(/malformed/);
  });

  it("rejects when the vault rotated between quote and broadcast", async () => {
    gw.inbounds = inbound({address: VAULT_ROTATED});
    await expect(provider.preflightDeposit!(quote, tx)).rejects.toThrow(/vault rotated/);
  });

  it("rejects when the router rotated between quote and broadcast", async () => {
    gw.inbounds = inbound({router: ROUTER_ROTATED});
    await expect(provider.preflightDeposit!(quote, tx)).rejects.toThrow(/router rotated/);
  });

  it("rejects when a chain halts between quote and broadcast, or the snapshot is unavailable", async () => {
    gw.inbounds = inbound({halted: true});
    await expect(provider.preflightDeposit!(quote, tx)).rejects.toThrow(/paused/);
    gw.inbounds = null;
    await expect(provider.preflightDeposit!(quote, tx)).rejects.toThrow(/cannot refresh/);
  });

  it("rejects an expired quote and a quote stripped of its execution metadata", async () => {
    const expired = {...quote, providerData: {...quote.providerData!, expiry: String(Math.floor(Date.now() / 1000) - 1)}};
    await expect(provider.preflightDeposit!(expired, tx)).rejects.toThrow(/expired/);
    const {memo: _m, ...rest} = quote.providerData!;
    await expect(provider.preflightDeposit!({...quote, providerData: rest}, tx)).rejects.toThrow(/missing execution-bound/);
  });

  it("rejects ERC-20 execution without the router approval, or with a non-zero value", async () => {
    const tokenQuote = (await provider.getQuote(params({sourceToken: "USDC", amountIn: "100000000"})))!;
    const tokenTx = await toTx(tokenQuote);
    await expect(provider.preflightDeposit!(tokenQuote, tokenTx)).resolves.toBeUndefined();
    const {approvalAddress: _a, ...noApproval} = tokenTx;
    await expect(provider.preflightDeposit!(tokenQuote, noApproval)).rejects.toThrow(/value\/approval/);
    await expect(provider.preflightDeposit!(tokenQuote, {...tokenTx, value: "1"})).rejects.toThrow(/value\/approval/);
    await expect(provider.preflightDeposit!(tokenQuote, {...tokenTx, approvalAddress: VAULT})).rejects.toThrow(/value\/approval/);
  });
});

describe("Avalanche source (added 2026-09-16)", () => {
  const AVAX_ROUTER = "0x00dc6100103bc402d490aee3f9a5560cbd91f1d4";
  const AVAX_USDC = "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e";
  beforeEach(() => {
    gw.inbounds = [
      {chain: "AVAX", address: VAULT, router: AVAX_ROUTER, halted: false},
      {chain: "ETH", address: VAULT, router: ROUTER, halted: false},
      {chain: "BTC", address: BTC_DEST, halted: false},
    ];
    gw.quote = quoteBody(`=:b:${BTC_DEST}:${LIMIT_SATS}`, {router: AVAX_ROUTER});
  });

  it("is advertised as a source and binds execution to the AVAX router on chain 43114", async () => {
    const provider = thorchainProvider({nodeUrl: NODE});
    expect(provider.supportsRoute({chain: "eip155:43114", token: "AVAX"}, {chain: "bitcoin:mainnet", token: "BTC"})).toBe(true);
    expect(provider.supportsRoute({chain: "eip155:43114", token: "AVAX"}, {chain: "eip155:1", token: "ETH"})).toBe(true);
    const q = await provider.getQuote(params({sourceChain: "eip155:43114", sourceToken: "AVAX", amountIn: "10000000000000000000"}));
    expect(q).not.toBeNull();
    expect(q!.txRequest).toMatchObject({to: AVAX_ROUTER, chainId: 43114, value: "10000000000000000000"});
    expect(q!.intentId).toBe("thorchain:43114");
    expect(gw.quoteUrls[0]).toContain("from_asset=AVAX.AVAX");
    const tx = await provider.buildDeposit(q!);
    await expect(provider.preflightDeposit!(q!, tx)).resolves.toBeUndefined();
  });

  it("quotes AVAX USDC/USDT with the THORChain token notation and a router approval", async () => {
    const provider = thorchainProvider({nodeUrl: NODE});
    const q = await provider.getQuote(params({sourceChain: "eip155:43114", sourceToken: "USDC", amountIn: "50000000"}));
    expect(q).not.toBeNull();
    expect(gw.quoteUrls[0]).toContain("from_asset=AVAX.USDC-0XB97EF9EF8734C71904D8002F8B6BC66DD9C48A6E");
    expect(q!.txRequest).toMatchObject({to: AVAX_ROUTER, chainId: 43114, value: "0", approvalAddress: AVAX_ROUTER});
    expect(decodeDeposit(q!.txRequest!.data!).asset.toLowerCase()).toBe(AVAX_USDC);
    gw.quoteUrls = [];
    await expect(provider.getQuote(params({sourceChain: "eip155:43114", sourceToken: "USDT", amountIn: "50000000"}))).resolves.not.toBeNull();
    expect(gw.quoteUrls[0]).toContain("from_asset=AVAX.USDT-0X9702230A8EA53601F5CD2DC00FDBC13D4DF4A8C7");
  });

  it("refuses an EVM quote whose router is not the AVAX router the inbound snapshot names", async () => {
    gw.quote = quoteBody(`=:b:${BTC_DEST}:${LIMIT_SATS}`, {router: ROUTER}); // Ethereum's router on an AVAX quote
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(params({sourceChain: "eip155:43114", sourceToken: "AVAX", amountIn: "10000000000000000000"}))).resolves.toBeNull();
  });

  it("keeps Polygon (no THORChain pool) off the source list", () => {
    expect(thorchainProvider().supportsRoute({chain: "eip155:137", token: "POL"}, {chain: "bitcoin:mainnet", token: "BTC"})).toBe(false);
  });
});
