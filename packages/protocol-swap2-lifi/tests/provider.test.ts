import {afterEach, describe, expect, it, vi} from "vitest";
import {lifiProvider} from "../src/provider.js";
import {lifi} from "../src/config.js";

import {DIAMOND, FROM_TOKEN, PARAMS, RECIPIENT, SENDER, TO_TOKEN, response} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

describe("LI.FI provider security contract", () => {
  it("is explicitly configurable and excludes unsupported Tron execution", () => {
    expect(lifiProvider({enabled: false}).enabled()).toBe(false);
    expect(lifiProvider().supportsRoute({chain: "tron:728126428", token: "USDT"}, {chain: "eip155:1", token: "USDT"})).toBe(false);
  });

  it("binds action, chain, sender, recipient, tokens, target and spender", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(response())));
    const before = Date.now();
    const quote = await lifiProvider().getQuote(PARAMS);
    expect(quote).toMatchObject({
      sourceAmount: "1000000",
      destAmount: "990000",
      minDestAmount: "985050",
      txRequest: {to: DIAMOND, approvalAddress: DIAMOND, chainId: 1},
    });
    expect(quote!.validUntilMs).toBeGreaterThan(before);
    expect(quote!.validUntilMs).toBeLessThanOrEqual(before + 60_000);
  });

  it("accepts a native source whose quote carries the diamond as approvalAddress, without propagating it", async () => {
    // Seen live 2026-09: every ETH-source quote ships estimate.approvalAddress
    // (the feeCollection step) — an approval is meaningless for the native
    // asset, so it must not veto the route, and must not reach the tx.
    const ZERO = "0x0000000000000000000000000000000000000000";
    const native = response({
      action: {...response().action, fromToken: {address: ZERO, chainId: 1}, fromAmount: "2000000000000000"},
      estimate: {...response().estimate, fromAmount: "2000000000000000", approvalAddress: DIAMOND},
      transactionRequest: {...response().transactionRequest, value: "0x71afd498d0000"},
    });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(native)));
    const quote = await lifiProvider().getQuote({...PARAMS, sourceToken: "ETH", amountIn: "2000000000000000"});
    expect(quote).not.toBeNull();
    expect(quote!.txRequest!.approvalAddress).toBeUndefined();

    // …but an untrusted spender on a native quote is still refused.
    const evil = "0x9999999999999999999999999999999999999999";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(response({
      ...native, estimate: {...native.estimate, approvalAddress: evil},
    }))));
    expect(await lifiProvider().getQuote({...PARAMS, sourceToken: "ETH", amountIn: "2000000000000000"})).toBeNull();
  });

  it("trusts the chain's own Diamond on Robinhood / HyperEVM and not the canonical one there", async () => {
    // lifinance/contracts deployments: Robinhood 0xB477…, HyperEVM 0x0a07… (2026-10-09).
    const ROBINHOOD_DIAMOND = "0xB477751B76CF82d00a686A1232f5fCD772414Af3";
    const robinhood = (to: string) => response({
      action: {...response().action, fromToken: {address: "0x0000000000000000000000000000000000000000", chainId: 4663}, toToken: {address: "0x0000000000000000000000000000000000000000", chainId: 8453}, fromChainId: 4663, toChainId: 8453, fromAmount: "1000000000000000"},
      estimate: {...response().estimate, fromAmount: "1000000000000000", approvalAddress: to},
      transactionRequest: {...response().transactionRequest, to, value: "0x38d7ea4c68000", chainId: 4663},
    });
    const params = {...PARAMS, sourceChain: "eip155:4663", sourceToken: "ETH", destChain: "eip155:8453", destToken: "0x0000000000000000000000000000000000000000", amountIn: "1000000000000000"};
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(robinhood(ROBINHOOD_DIAMOND))));
    await expect(lifiProvider().getQuote(params)).resolves.toMatchObject({txRequest: {to: ROBINHOOD_DIAMOND, chainId: 4663}});
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(robinhood(DIAMOND))));
    await expect(lifiProvider().getQuote(params)).resolves.toBeNull();
  });

  it.each([
    [143, "MON", "0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37"], // Monad
    [130, "ETH", "0x864b314D4C5a0399368609581d3E8933a63b9232"], // Unichain
    [80094, "BERA", "0xf909c4Ae16622898b885B89d7F839E0244851c66"], // Berachain
    [747474, "ETH", "0xC59fe32C9549e3E8B5dCcdAbC45BD287Bd5bA2bc"], // Katana (li.quest/v1/chains, 2026-10-14)
    [2818, "ETH", "0xF7aB42D00D2399f8A4Fba2F15466Be40709fe307"], // Morph (li.quest/v1/chains, 2026-10-14)
  ])("trusts chain %i's own Diamond (lifinance/contracts deployments, 2026-10-11)", async (chainId, native, own) => {
    const ZERO = "0x0000000000000000000000000000000000000000";
    const body = (to: string) => response({
      action: {...response().action, fromToken: {address: ZERO, chainId}, toToken: {address: ZERO, chainId: 8453}, fromChainId: chainId, toChainId: 8453, fromAmount: "1000000000000000"},
      estimate: {...response().estimate, fromAmount: "1000000000000000", approvalAddress: to},
      transactionRequest: {...response().transactionRequest, to, value: "0x38d7ea4c68000", chainId},
    });
    const params = {...PARAMS, sourceChain: `eip155:${chainId}`, sourceToken: native, destChain: "eip155:8453", destToken: ZERO, amountIn: "1000000000000000"};
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body(own))));
    await expect(lifiProvider().getQuote(params)).resolves.toMatchObject({txRequest: {to: own, chainId}});
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body(DIAMOND))));
    await expect(lifiProvider().getQuote(params)).resolves.toBeNull();
  });

  it("declares a bridge's native messaging fee instead of hiding it in value", async () => {
    // Token source: the whole value is the fee (DAI Optimism → Base, 2026-10-10).
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(response({transactionRequest: {...response().transactionRequest, value: "0x2386f26fc10000"}}))));
    const token = await lifiProvider().getQuote(PARAMS);
    expect(token!.txRequest).toMatchObject({value: "10000000000000000", nativeFee: "10000000000000000"});
    // Native source: value = input + fee (POL Polygon → Optimism).
    const ZERO = "0x0000000000000000000000000000000000000000";
    const native = response({
      action: {...response().action, fromToken: {address: ZERO, chainId: 1}, fromAmount: "2000000000000000"},
      estimate: {...response().estimate, fromAmount: "2000000000000000", approvalAddress: DIAMOND},
      transactionRequest: {...response().transactionRequest, value: "0x" + (2_200_000_000_000_000n).toString(16)}, // 0.0022 ETH
    });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(native)));
    const q = await lifiProvider().getQuote({...PARAMS, sourceToken: "ETH", amountIn: "2000000000000000"});
    expect(q!.txRequest).toMatchObject({value: "2200000000000000", nativeFee: "200000000000000"});
    // A native source whose value is BELOW the input is not a quote we can execute.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({...native, transactionRequest: {...native.transactionRequest, value: "0x1"}})));
    expect(await lifiProvider().getQuote({...PARAMS, sourceToken: "ETH", amountIn: "2000000000000000"})).toBeNull();
  });

  it("rejects resolver payloads without a coherent action or required chain", async () => {
    const crafted = response();
    delete (crafted as {action?: unknown}).action;
    delete (crafted.transactionRequest as {chainId?: number}).chainId;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(crafted)));
    await expect(lifiProvider().getQuote(PARAMS)).resolves.toBeNull();
  });

  it("rejects untrusted execution targets and approval spenders", async () => {
    const evil = "0x2222222222222222222222222222222222222222";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(response({
      estimate: {...response().estimate, approvalAddress: evil},
      transactionRequest: {...response().transactionRequest, to: evil},
    }))));
    await expect(lifiProvider().getQuote(PARAMS)).resolves.toBeNull();
  });

  it("uses the configured API base and preserves LI.FI refund lifecycle substatuses", async () => {
    const seen: string[] = [];
    const substatuses = ["REFUNDED", "EXPIRED", "NOT_PROCESSABLE_REFUND_NEEDED", "REFUND_IN_PROGRESS", "PARTIAL"];
    vi.stubGlobal("fetch", async (input: URL | RequestInfo) => {
      seen.push(String(input));
      return new Response(JSON.stringify({status: substatuses.at(-1) === "PARTIAL" ? "DONE" : "FAILED", substatus: substatuses.shift()}));
    });
    const provider = lifiProvider({apiUrl: "https://proxy.invalid/lifi/"});
    const ref = {intentId: "lifi:1:42161", sourceTxHash: "0xsource"};
    await expect(provider.trackIntent(ref)).resolves.toMatchObject({state: "refunded"});
    await expect(provider.trackIntent(ref)).resolves.toMatchObject({state: "expired"});
    await expect(provider.trackIntent(ref)).resolves.toMatchObject({state: "action-required"});
    await expect(provider.trackIntent(ref)).resolves.toMatchObject({state: "refund-pending"});
    await expect(provider.trackIntent(ref)).resolves.toMatchObject({state: "partial"});
    expect(seen.every((url) => url.startsWith("https://proxy.invalid/lifi/status?"))).toBe(true);
  });

  it("rejects non-HTTP API endpoints", () => {
    expect(() => lifiProvider({apiUrl: "file:///tmp/lifi"})).toThrow(/http or https/);
    expect(() => lifiProvider({trustedTransactionTargets: {"eip155:1": ["invalid"]}})).toThrow(/invalid transaction target/);
  });

  it("snapshots nested execution allowlists at construction", async () => {
    const extra: string[] = [];
    const evil = "0x2222222222222222222222222222222222222222";
    const provider = lifiProvider({trustedTransactionTargets: {"eip155:1": extra}, trustedApprovalAddresses: {"eip155:1": extra}});
    extra.push(evil);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(response({
      estimate: {...response().estimate, approvalAddress: evil},
      transactionRequest: {...response().transactionRequest, to: evil},
    }))));
    await expect(provider.getQuote(PARAMS)).resolves.toBeNull();
  });

  it("quotes Solana sources as a guarded serialized transaction and names the chain on build", async () => {
    const SOL_CHAIN = 1151111081099710;
    const SOL_NATIVE = "11111111111111111111111111111111";
    const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const SOL_SENDER = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
    const WIRE = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const solana = (overrides: Record<string, unknown> = {}) => ({
      type: "lifi", id: "q-sol",
      action: {
        fromToken: {address: SOL_NATIVE, chainId: SOL_CHAIN}, toToken: {address: SOL_USDC, chainId: SOL_CHAIN},
        fromAmount: "50000000", fromChainId: SOL_CHAIN, toChainId: SOL_CHAIN, slippage: 0.005,
        fromAddress: SOL_SENDER, toAddress: SOL_SENDER,
      },
      estimate: {fromAmount: "50000000", toAmount: "990000", toAmountMin: "985050", executionDuration: 5},
      transactionRequest: {data: WIRE},
      ...overrides,
    });
    const params = {
      sourceChain: "solana:mainnet", sourceToken: "SOL", destChain: "solana:mainnet", destToken: SOL_USDC,
      amountIn: "50000000", destAddress: SOL_SENDER, refundAddress: SOL_SENDER, slippageBps: 50,
    };
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: URL) => { requests.push(String(url)); return new Response(JSON.stringify(solana())); });
    const provider = lifiProvider();
    expect(provider.supportsRoute({chain: "solana:mainnet", token: "SOL"}, {chain: "eip155:1", token: "USDT"})).toBe(true);
    expect(provider.supportsChain!("solana:mainnet")).toBe(true);
    const quote = await provider.getQuote(params);
    expect(quote).toMatchObject({sourceAmount: "50000000", minDestAmount: "985050", txRequest: {serializedTx: WIRE, value: "50000000"}});
    expect(quote!.txRequest!.to).toBeUndefined();
    expect(requests[0]).toContain(`fromChain=${SOL_CHAIN}`);
    expect(requests[0]).toContain(`fromToken=${SOL_NATIVE}`);
    await expect(provider.buildDeposit(quote!)).resolves.toEqual({chain: "solana:mainnet", to: "", value: "50000000", serializedTx: WIRE});

    // A token source lets no native value through; a native DEST maps to the Solana sentinel.
    const usdcSource = solana({
      action: {...solana().action, fromToken: {address: SOL_USDC, chainId: SOL_CHAIN}, toToken: {address: SOL_NATIVE, chainId: SOL_CHAIN}, fromAmount: "1000000"},
      estimate: {fromAmount: "1000000", toAmount: "50000000", toAmountMin: "49750000"},
    });
    vi.stubGlobal("fetch", async (url: URL) => { requests.push(String(url)); return new Response(JSON.stringify(usdcSource)); });
    const q2 = await provider.getQuote({...params, sourceToken: "USDC", destToken: "0x0000000000000000000000000000000000000000", amountIn: "1000000"});
    expect(q2).toMatchObject({txRequest: {serializedTx: WIRE, value: "0"}});
    expect(requests.at(-1)).toContain(`toToken=${SOL_NATIVE}`);

    // Refusals: EVM-shaped payload on a Solana source, non-base64 data.
    for (const bad of [
      solana({transactionRequest: {to: DIAMOND, data: "0xdeadbeef", value: "0x0", chainId: 1, gasLimit: "0x5208"}}),
      solana({transactionRequest: {data: "not base64!!"}}),
    ]) {
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify(bad)));
      expect(await provider.getQuote(params)).toBeNull();
    }
    // LI.FI reports its EVM diamond as `approvalAddress` on Solana Mayan routes
    // (live 2026-10-09). Solana has no allowances: the quote stands, and the
    // address never reaches the txRequest.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(solana({estimate: {...solana().estimate, approvalAddress: DIAMOND}}))));
    const withApproval = await provider.getQuote(params);
    expect(withApproval).toMatchObject({txRequest: {serializedTx: WIRE, value: "50000000"}});
    expect(withApproval!.txRequest!.approvalAddress).toBeUndefined();
    // EVM routes are untouched by the Solana path.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(response())));
    await expect(provider.getQuote(PARAMS)).resolves.toMatchObject({txRequest: {to: DIAMOND, chainId: 1}});
  });
});

describe("LI.FI per-step slippage", () => {
  it("re-quotes with a scaled slippage when the route's floor sits under the requested one", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (url: URL) => {
      const slippage = Number(url.searchParams.get("slippage"));
      sent.push(String(slippage));
      // Two steps, slippage on each: min ≈ dest × (1 − s)².
      const min = Math.floor(990000 * (1 - slippage) ** 2).toString();
      const body = response();
      return new Response(JSON.stringify({...body, action: {...body.action, slippage}, estimate: {...body.estimate, toAmountMin: min}}));
    });
    const quote = await lifiProvider().getQuote(PARAMS);
    expect(sent).toHaveLength(2);
    expect(Number(sent[1])).toBeLessThan(0.005);
    expect(BigInt(quote!.minDestAmount)).toBeGreaterThanOrEqual(985050n);
  });

  it("refuses with a named reason when the re-quote still undercuts the floor", async () => {
    vi.stubGlobal("fetch", async (url: URL) => {
      const body = response();
      return new Response(JSON.stringify({...body, action: {...body.action, slippage: Number(url.searchParams.get("slippage"))}, estimate: {...body.estimate, toAmountMin: "970000"}}));
    });
    let reason = "";
    expect(await lifiProvider().getQuote({...PARAMS, onRefusal: (r: string) => { reason = r; }})).toBeNull();
    expect(reason).toMatch(/^lifi: this route's minimum is 2\.02% under the quote/);
  });
});

describe("LI.FI default slippage", () => {
  it("pins the slippage when the caller names none, so the live floor matches the display quote", async () => {
    const sent: (string | null)[] = [];
    vi.stubGlobal("fetch", async (url: URL) => {
      sent.push(url.searchParams.get("slippage"));
      return new Response(JSON.stringify(response()));
    });
    const {slippageBps: _omit, ...noSlippage} = PARAMS;
    expect(await lifiProvider().getQuote(noSlippage)).not.toBeNull();
    expect(await lifiProvider({defaultSlippageBps: 100}).getQuote(noSlippage)).toBeNull(); // response echoes 0.005 ≠ the 0.01 sent
    expect(await lifiProvider({defaultSlippageBps: 100}).getQuote(PARAMS)).not.toBeNull(); // the caller's own value wins
    expect(sent).toEqual(["0.005", "0.01", "0.005"]);
    expect(() => lifiProvider({defaultSlippageBps: 0})).toThrow(/defaultSlippageBps/);
  });
});

describe("LI.FI refusals", () => {
  it("names a quoted minimum under the caller's floor instead of a silent null", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(response())));
    let reason = "";
    expect(await lifiProvider().getQuote({...PARAMS, minAmountOut: "985051", onRefusal: (r: string) => { reason = r; }})).toBeNull();
    expect(reason).toBe("lifi: floor breach (min=985050 < floor=985051)");
  });

  it("forwards the API's own message when it has no quote", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({message: "No available quotes for the requested transfer"}), {status: 404}));
    let reason = "";
    expect(await lifiProvider().getQuote({...PARAMS, onRefusal: (r: string) => { reason = r; }})).toBeNull();
    expect(reason).toBe("lifi: No available quotes for the requested transfer");
  });

  it("names the one reason every route was filtered out for (Sei address linking)", async () => {
    const why = "The source or destination wallet is not linked to the original SEI address, please go to https://app.sei.io/ to link you wallet.";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      message: "No available quotes for the requested transfer",
      errors: {filteredOut: [{overallPath: "1329:SEI~1329:USDC", reason: why}, {overallPath: "1329:SEI~1329:WETH", reason: why}]},
    }), {status: 404}));
    let reason = "";
    expect(await lifiProvider().getQuote({...PARAMS, onRefusal: (r: string) => { reason = r; }})).toBeNull();
    expect(reason).toBe(`lifi: No available quotes for the requested transfer (${why})`);
  });
});

describe("LI.FI route policy hook", () => {
  const route = (tool: string, toAmount: string, eta: number, extra: Record<string, unknown> = {}) => ({
    toAmount, toAmountMin: toAmount, gasCostUSD: "0.01", tags: [],
    steps: [{type: "lifi", tool, estimate: {executionDuration: eta}, includedSteps: [{tool: "feeCollection", type: "protocol"}, {tool, type: "cross"}]}],
    ...extra,
  });
  const routes = {routes: [
    route("polymerStandard", "2992500", 1080),
    route("stargateV2", "2990656", 96),
    route("mayan", "2521085", 3),
    route("twoTx", "2999999", 5, {steps: [{tool: "a", estimate: {executionDuration: 1}}, {tool: "b", estimate: {executionDuration: 1}}]}),
    route("bad tool!", "2999999", 5),
  ]};

  function stub(onQuote: (url: URL) => Response = () => new Response(JSON.stringify(response()))) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      if (url.pathname.endsWith("/advanced/routes")) return new Response(JSON.stringify(routes));
      return onQuote(url);
    });
    return calls;
  }

  it("hands single-transaction candidates to the app and restricts /quote to its choice", async () => {
    const calls = stub();
    let seen: {tool: string; toAmount: bigint; etaSeconds: number}[] = [];
    const quote = await lifiProvider({chooseRoute: (r) => { seen = [...r]; return {allowBridges: ["stargateV2"], denyBridges: ["mayan", "bad tool!"]}; }}).getQuote(PARAMS);
    expect(quote).not.toBeNull();
    expect(seen.map((r) => r.tool)).toEqual(["polymerStandard", "stargateV2", "mayan"]);
    expect(seen[1]).toMatchObject({toAmount: 2990656n, etaSeconds: 96});
    expect(calls[0]).toMatch(/^POST \/v1\/advanced\/routes$/);
    const q = new URL(`https://x${calls[1]!.slice(4)}`).searchParams;
    expect(q.getAll("allowBridges")).toEqual(["stargateV2"]);
    expect(q.getAll("denyBridges")).toEqual(["mayan"]); // malformed tool keys never reach the URL
  });

  it("keeps LI.FI's default pick without a hook, for same-chain swaps, and when the hook passes", async () => {
    let calls = stub();
    await lifiProvider().getQuote(PARAMS);
    expect(calls).toHaveLength(1);
    calls = stub();
    await lifiProvider({chooseRoute: () => ({allowBridges: ["x"]})}).getQuote({...PARAMS, destChain: PARAMS.sourceChain});
    expect(calls.some((c) => c.includes("advanced"))).toBe(false);
    calls = stub();
    await lifiProvider({chooseRoute: () => null}).getQuote(PARAMS);
    expect(calls[1]).not.toMatch(/allowBridges|denyBridges|order=/);
  });

  it("falls back to the default pick when the routes call fails, the hook throws, or the chosen bridge is gone", async () => {
    vi.stubGlobal("fetch", async (input: URL | string) => String(input).includes("advanced") ? new Response("nope", {status: 500}) : new Response(JSON.stringify(response())));
    expect(await lifiProvider({chooseRoute: () => ({allowBridges: ["stargateV2"]})}).getQuote(PARAMS)).not.toBeNull();
    stub();
    expect(await lifiProvider({chooseRoute: () => { throw new Error("policy bug"); }}).getQuote(PARAMS)).not.toBeNull();
    const calls = stub((url) => url.searchParams.has("allowBridges") ? new Response(JSON.stringify({message: "No available quotes"}), {status: 404}) : new Response(JSON.stringify(response())));
    expect(await lifiProvider({chooseRoute: () => ({allowBridges: ["stargateV2"]})}).getQuote(PARAMS)).not.toBeNull();
    expect(calls).toHaveLength(3);
    expect(calls[2]).not.toMatch(/allowBridges/);

describe("LI.FI chain table (2026-10-14 batch)", () => {
  const ZERO = "0x0000000000000000000000000000000000000000";
  const ARC_USDC = "0x3600000000000000000000000000000000000000";
  it.each([
    // Arc: the source is USDC through its ERC-20 interface (LI.FI's own "native" id there), pulled with value 0.
    ["eip155:5042", 5042, "USDC", ARC_USDC, "0x0", "0xA4072583658Fae592A3506A42431cb6316a8d40b"], // own Diamond
    ["eip155:5000", 5000, "MNT", ZERO, "0x38d7ea4c68000", DIAMOND], // canonical Diamond
    ["eip155:747474", 747474, "ETH", ZERO, "0x38d7ea4c68000", "0xC59fe32C9549e3E8B5dCcdAbC45BD287Bd5bA2bc"], // own Diamond
    ["eip155:2818", 2818, "ETH", ZERO, "0x38d7ea4c68000", "0xF7aB42D00D2399f8A4Fba2F15466Be40709fe307"], // own Diamond
    ["eip155:14", 14, "FLR", ZERO, "0x38d7ea4c68000", DIAMOND], // canonical Diamond
  ])("%s is supported, numbered %i, sources %s and trusts Diamond %s", async (caip2, chainId, symbol, fromAddress, value, diamond) => {
    expect(lifi.supportsChain(caip2)).toBe(true);
    expect(lifi.supports(caip2, "eip155:8453")).toBe(true);
    const amount = fromAddress === ZERO ? "1000000000000000" : "5000000";
    const body = (to: string) => response({
      action: {...response().action, fromToken: {address: fromAddress, chainId}, toToken: {address: ZERO, chainId: 8453}, fromChainId: chainId, toChainId: 8453, fromAmount: amount},
      estimate: {...response().estimate, fromAmount: amount, approvalAddress: to},
      transactionRequest: {...response().transactionRequest, to, value, chainId},
    });
    let sent = "";
    const reasons: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => { sent = String(url); return new Response(JSON.stringify(body(diamond))); });
    const params = {...PARAMS, sourceChain: caip2, sourceToken: symbol, destChain: "eip155:8453", destToken: ZERO, amountIn: amount, onRefusal: (r: string) => { reasons.push(r); }};
    await expect(lifiProvider().getQuote(params)).resolves.toMatchObject({txRequest: {to: diamond, chainId, ...(fromAddress === ZERO ? {} : {approvalAddress: diamond})}});
    expect(reasons).toEqual([]);
    const q = new URL(sent).searchParams;
    expect([q.get("fromChain"), q.get("fromToken")]).toEqual([String(chainId), fromAddress]);
  });

  it("Arc: a quote whose Diamond is not Arc's own is refused", async () => {
    const body = response({
      action: {...response().action, fromToken: {address: "0x3600000000000000000000000000000000000000", chainId: 5042}, toToken: {address: ZERO, chainId: 8453}, fromChainId: 5042, toChainId: 8453, fromAmount: "5000000"},
      estimate: {...response().estimate, fromAmount: "5000000", approvalAddress: DIAMOND},
      transactionRequest: {...response().transactionRequest, to: DIAMOND, value: "0x0", chainId: 5042},
    });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body)));
    await expect(lifiProvider().getQuote({...PARAMS, sourceChain: "eip155:5042", sourceToken: "0x3600000000000000000000000000000000000000", destChain: "eip155:8453", destToken: ZERO, amountIn: "5000000"})).resolves.toBeNull();
  });
});
