// QuoteParams.blockNumber / Quote.blockNumber / CrossChainProvider.honorsBlockNumber (0.18.0): the block an app prices a
// comparison round at, the block a provider says it priced at, and which providers can. The field is a decimal string,
// checked strictly wherever it is read; a quote naming a block is one the request asked for; the server takes, seals
// and checks it; a remote stub forwards it and mirrors the flag only when told. Node error texts that mean "no such
// block here" (read live 2026-11-28) are recognised for the providers that pin.
import {describe, expect, it} from "vitest";
import {remoteProvider} from "../src/remote.js";
import {createSwap2Handler} from "../src/server.js";
import type {CrossChainProvider, Quote, QuoteParams} from "../src/types.js";
import {blockLackedInBody, nodeLacksBlock} from "../src/util.js";
import {blockTagOf, quoteRejection, validBlockNumber, validQuote} from "../src/validate.js";
import * as index from "../src/index.js";

const PARAMS: QuoteParams = {
  sourceChain: "eip155:1", sourceToken: "USDC", destChain: "eip155:1", destToken: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  amountIn: "100000000", destAddress: "0x1111111111111111111111111111111111111111", refundAddress: "0x1111111111111111111111111111111111111111",
};
const QUOTE: Quote = {
  provider: "mock", intentId: "intent-1", depositAddress: "", depositMemo: null,
  txRequest: {to: "0x3333333333333333333333333333333333333333", data: "0xdeadbeef", value: "0", chainId: 1, approvalAddress: "0x3333333333333333333333333333333333333333"},
  sourceAmount: "100000000", destAmount: "99900000", minDestAmount: "99800000", feeUsd: 0, etaSeconds: 15, reliability: 0.97, validUntilMs: Date.now() + 60_000,
};
const SECRET = "block-number-test-seal-secret-at-least-32-bytes";

describe("validBlockNumber / blockTagOf", () => {
  it("takes decimal digits without a leading zero, up to a uint64", () => {
    for (const ok of ["0", "1", "9", "10", "23456789", "125409523", "18446744073709551615"]) expect(validBlockNumber(ok)).toBe(true);
  });
  it("refuses hex, signs, spaces, fractions, exponents, leading zeros, tags, numbers and anything past a uint64", () => {
    for (const bad of ["", "00", "01", "0x10", "0X10", "-1", "+1", " 1", "1 ", "1\n", "1.0", "1e6", "１２", "latest", "pending", "18446744073709551616", "123456789012345678901", 1, 1n, null, undefined, {}, ["1"]]) {
      expect(validBlockNumber(bad)).toBe(false);
    }
  });
  it("blockTagOf is the hex JSON-RPC quantity (BigInt, no Number) and throws on anything else", () => {
    expect(blockTagOf("0")).toBe("0x0");
    expect(blockTagOf("23456789")).toBe("0x165ec15");
    expect(blockTagOf("18446744073709551615")).toBe("0xffffffffffffffff");
    for (const bad of ["01", "0x10", "-1", ""]) expect(() => blockTagOf(bad)).toThrow(/decimal block number/);
  });
  it("the package entry exports them", () => {
    expect(index.validBlockNumber).toBe(validBlockNumber);
    expect(index.blockTagOf).toBe(blockTagOf);
    expect(index.nodeLacksBlock).toBe(nodeLacksBlock);
    expect(index.blockLackedInBody).toBe(blockLackedInBody);
  });
});

describe("nodeLacksBlock / blockLackedInBody", () => {
  // Read live on the chains of the Uniswap, Curve and Balancer modules (eth_call at latest + 100,000 and − 100,000).
  const lacking = [
    "header not found",
    "block not found: 0x98c8e2a",
    "block not found",
    "Block requested not found. Request might be querying historical state that is not available. If possible, reformulate query to point to more recent blocks",
    "Block with such an ID doesn't exist yet",
    "unsupported block number 528206457",
    "block not found: not accepted yet: block 101673500",
    "requested block is above the latest consensus block 0x6307b79",
    "block is out of range",
    "missing trie node 9a3db399db1a12719f47f70001caa30d0a1e3e31914f1e7ca63eaa1ba935ce27 (path ) state 0x9a3db399",
    "historical state 177d77af4d900c21d8c482161303bfdd8894dd81524f7deb4a55c247a16186f4 is not available",
    "No state available for block 49401469 (0x9429a8419a051bc7a3df934ea16a7ec27a33fe5555103cee1371e54f586905de)",
    "Unknown state. First available state is 1",
    "Archive requests require a personal token. Get one at: <url>",
    "unknown block",
    "state at block #123 is pruned",
  ];
  it("recognises every text nodes answered a block they lack with", () => {
    for (const text of lacking) {
      expect(nodeLacksBlock(text)).toBe(true);
      expect(nodeLacksBlock({code: -32000, message: text})).toBe(true);
    }
  });
  it("not a revert, a rate limit, a node fault or a malformed request", () => {
    for (const text of ["execution reverted", "execution reverted: STF", "50/second request limit reached", "rate limit exceeded", "internal error", "request timed out", "invalid argument 0: json: cannot unmarshal", "method not found", "gas required exceeds allowance (16777216)", "insufficient funds for transfer"]) {
      expect(nodeLacksBlock(text)).toBe(false);
    }
    for (const v of [undefined, null, 3, {code: -32000}, {message: 42}]) expect(nodeLacksBlock(v)).toBe(false);
  });
  it("blockLackedInBody reads an HTTP error's JSON-RPC body, alone or in a batch", () => {
    expect(blockLackedInBody(JSON.stringify({jsonrpc: "2.0", id: 1, error: {code: -32019, message: "block is out of range"}}))).toBe("block is out of range");
    expect(blockLackedInBody(JSON.stringify([{id: 0, result: "0x"}, {id: 1, error: {code: 27, message: "Unknown state. First available state is 1"}}]))).toBe("Unknown state. First available state is 1");
    expect(blockLackedInBody(JSON.stringify({error: {code: 429, message: "too many requests"}}))).toBeUndefined();
    expect(blockLackedInBody("<html>403 Forbidden</html>")).toBeUndefined();
    expect(blockLackedInBody("")).toBeUndefined();
    expect(blockLackedInBody(JSON.stringify({error: {message: "header not found"}}).padEnd(70_000, " "))).toBeUndefined();
  });
});

describe("quoteRejection with blockNumber", () => {
  it("a quote without a block, or naming the one asked for, passes", () => {
    expect(quoteRejection(QUOTE, PARAMS, "mock")).toBeNull();
    expect(quoteRejection(QUOTE, {...PARAMS, blockNumber: "23456789"}, "mock")).toBeNull();
    expect(quoteRejection({...QUOTE, blockNumber: "23456789"}, {...PARAMS, blockNumber: "23456789"}, "mock")).toBeNull();
  });
  it("a quote naming a block the request did not ask for is another request's (policy_refused)", () => {
    expect(quoteRejection({...QUOTE, blockNumber: "23456789"}, PARAMS, "mock")).toEqual({reason: "policy_refused"});
    expect(quoteRejection({...QUOTE, blockNumber: "23456788"}, {...PARAMS, blockNumber: "23456789"}, "mock")).toEqual({reason: "policy_refused"});
    expect(validQuote({...QUOTE, blockNumber: "23456788"}, {...PARAMS, blockNumber: "23456789"}, "mock")).toBe(false);
  });
  it("a quote naming a block that is not a decimal block number is malformed (upstream_unavailable)", () => {
    for (const bad of ["0x165ec15", "023456789", "", 23456789 as never]) {
      expect(quoteRejection({...QUOTE, blockNumber: bad}, {...PARAMS, blockNumber: "23456789"}, "mock")).toEqual({reason: "upstream_unavailable"});
    }
  });
  it("a request whose blockNumber is not a decimal block number is the caller's own error (no reason)", () => {
    for (const bad of ["0x10", "01", "-5", 5 as never]) expect(quoteRejection(QUOTE, {...PARAMS, blockNumber: bad}, "mock")).toEqual({});
  });
});

function mock(over: Partial<CrossChainProvider> = {}) {
  const seen: QuoteParams[] = [];
  const provider: CrossChainProvider = {
    name: "mock",
    enabled: () => true,
    supportsRoute: () => true,
    honorsBlockNumber: true,
    getQuote: async (p) => { seen.push(p); return {...QUOTE, ...(p.blockNumber !== undefined ? {blockNumber: p.blockNumber} : {})}; },
    buildDeposit: async () => ({chain: "eip155:1", to: QUOTE.txRequest!.to!, value: "0", data: "0xdeadbeef"}),
    trackIntent: async () => ({state: "pending"}),
    ...over,
  };
  return {provider, seen};
}

describe("the swap2 server", () => {
  it("takes a decimal blockNumber, hands it to the provider, and seals the quote that names it", async () => {
    const {provider, seen} = mock();
    const handle = createSwap2Handler({providers: [provider], sealSecret: SECRET, guard: () => {}});
    const res = await handle("quote", {provider: "mock", params: {...PARAMS, blockNumber: "23456789"}}, "u");
    expect(res.status).toBe(200);
    expect(seen[0]!.blockNumber).toBe("23456789");
    expect((res.body as Quote).blockNumber).toBe("23456789");
    // The seal covers it: the same quote naming another block is not one this server sealed.
    const sealed = res.body as Quote;
    expect((await handle("build", {provider: "mock", quote: sealed}, "u")).status).toBe(200);
    expect((await handle("build", {provider: "mock", quote: {...sealed, blockNumber: "23456790"}}, "u")).status).toBe(400);
    const {blockNumber: _b, ...unnamed} = sealed;
    expect((await handle("build", {provider: "mock", quote: unnamed}, "u")).status).toBe(400);
  });

  it("without blockNumber the provider gets none and the quote names none, as before", async () => {
    const {provider, seen} = mock();
    const res = await createSwap2Handler({providers: [provider], sealSecret: SECRET, guard: () => {}})("quote", {provider: "mock", params: PARAMS}, "u");
    expect(res.status).toBe(200);
    expect("blockNumber" in seen[0]!).toBe(false);
    expect("blockNumber" in (res.body as Quote)).toBe(false);
  });

  it("refuses a blockNumber that is not a decimal block number before the provider is asked", async () => {
    const {provider, seen} = mock();
    const handle = createSwap2Handler({providers: [provider], sealSecret: SECRET, guard: () => {}});
    for (const bad of ["0x165ec15", "023456789", "-1", "1.5", "", "latest", "18446744073709551616", 23456789, null]) {
      const res = await handle("quote", {provider: "mock", params: {...PARAMS, blockNumber: bad}}, "u");
      expect(res.status).toBe(400);
      expect((res.body as {error: string}).error).toMatch(/^params\.blockNumber: /);
    }
    expect(seen).toEqual([]);
  });

  it("refuses to seal a quote naming another block than the request's (502, policy_refused)", async () => {
    const {provider} = mock({getQuote: async () => ({...QUOTE, blockNumber: "1"})});
    const handle = createSwap2Handler({providers: [provider], sealSecret: SECRET, guard: () => {}});
    const res = await handle("quote", {provider: "mock", params: {...PARAMS, blockNumber: "23456789"}}, "u");
    expect(res).toMatchObject({status: 502, body: {reason: "policy_refused"}});
    const junk = await createSwap2Handler({providers: [mock({getQuote: async () => ({...QUOTE, blockNumber: "0x1"})}).provider], sealSecret: SECRET, guard: () => {}})("quote", {provider: "mock", params: {...PARAMS, blockNumber: "1"}}, "u");
    expect(junk.status).toBe(502);
  });
});

describe("remoteProvider", () => {
  const wire = (handle: ReturnType<typeof createSwap2Handler<string>>, sent: unknown[], honors?: boolean) => remoteProvider({
    name: "mock",
    baseUrl: "https://api.example.test/swap2",
    ...(honors !== undefined ? {honorsBlockNumber: honors} : {}),
    fetchImpl: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push(body);
      const res = await handle(String(url).split("/").pop()!, body, "u");
      return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch,
  });

  it("forwards blockNumber in the request, and the backend's quote comes back naming it", async () => {
    const sent: {params?: QuoteParams}[] = [];
    const stub = wire(createSwap2Handler({providers: [mock().provider], sealSecret: SECRET, guard: () => {}}), sent);
    const p = {...PARAMS, blockNumber: "23456789"};
    const q = await stub.getQuote(p);
    expect(sent[0]!.params!.blockNumber).toBe("23456789");
    expect(q!.blockNumber).toBe("23456789");
    expect(validQuote(q!, p, "mock")).toBe(true);
  });

  it("mirrors honorsBlockNumber only when the app says so", () => {
    const handle = createSwap2Handler({providers: [mock().provider], sealSecret: SECRET, guard: () => {}});
    expect(wire(handle, [], true).honorsBlockNumber).toBe(true);
    expect(wire(handle, []).honorsBlockNumber).toBeUndefined();
    expect("honorsBlockNumber" in wire(handle, [], false)).toBe(false);
  });
});
