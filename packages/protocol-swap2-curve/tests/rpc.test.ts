// The JSON-RPC client and the ABI word readers: an element error that is not a revert fails the endpoint (never a
// silent null read as "not the pinned code"), and a return longer than one word is read by its first word.
import {afterEach, describe, expect, it, vi} from "vitest";
import {curveProvider} from "../src/provider.js";
import {curveOnChain} from "../src/verify.js";
import {RPC_RATE_LIMIT_PAUSE_MS, ethCall, isExecutionError, rpcClient, wordAddress, wordUint} from "../src/rpc.js";
import {LUSD, LUSD_COINS, LUSD_META, LUSD_POOL, ME, POOLS, TABLES, TRIPOOL, USDT, WITH_LUSD, rpcStub} from "./fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const A = "https://a.test";
const B = "https://b.test";
const CALLS = [ethCall(TRIPOOL, "0xc66106570000000000000000000000000000000000000000000000000000000000000000"), {method: "eth_getCode", params: [TRIPOOL, "latest"]}];
const WORD = `0x${"0".repeat(24)}${"ab".repeat(20)}`;
const LIMITED = {code: -32007, message: "50/second request limit reached - reduce calls per second or upgrade your account at quicknode.com"};

/** Per URL, the batch answer: a function of the request ids. */
function stub(answers: Record<string, (ids: number[]) => unknown>) {
  const urls: string[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const ids = (JSON.parse(String(init?.body)) as {id: number}[]).map((r) => r.id);
    return new Response(JSON.stringify(answers[url]!(ids)));
  });
  vi.stubGlobal("fetch", f);
  return urls;
}

describe("ABI words", () => {
  it("the Liquity metapool's 4096-byte coins(i) answers read as their first word (recorded live)", () => {
    expect(LUSD_COINS.calls.map((c) => (c.result.length - 2) / 2)).toEqual([4096, 4096]);
    expect(LUSD_COINS.calls.map((c) => wordAddress(c.result))).toEqual([LUSD.toLowerCase(), "0x6c3f90f043a72fa612cbac8115ee7e52bde6e490"]);
    expect(wordUint(LUSD_COINS.calls[0]!.result)).toBe(BigInt(LUSD));
  });

  it("one word as before; no whole word, dirty upper bytes or non-hex → null", () => {
    expect(wordAddress(WORD)).toBe(`0x${"ab".repeat(20)}`);
    expect(wordUint(`0x${"0".repeat(63)}7`)).toBe(7n);
    for (const raw of ["0x", `0x${"0".repeat(62)}`, `${WORD}00`, `0x${"0".repeat(63)}g`, 7, null]) {
      expect(wordAddress(raw), String(raw)).toBeNull();
      expect(wordUint(raw), String(raw)).toBeNull();
    }
    expect(wordAddress(`0x${"0".repeat(23)}1${"ab".repeat(20)}`)).toBeNull();
    expect(wordAddress(`0x${"0".repeat(23)}1${"ab".repeat(20)}${"0".repeat(64)}`)).toBeNull();
  });
});

describe("rpcClient", () => {
  it("a revert is an answer (null), on that endpoint, whatever code the node gives it", async () => {
    expect(isExecutionError({code: 3, message: "execution reverted", data: "0x"})).toBe(true);
    expect(isExecutionError({code: -32000, message: "execution reverted"})).toBe(true);
    expect(isExecutionError({code: -32000, message: "invalid opcode: INVALID"})).toBe(true);
    expect(isExecutionError(LIMITED)).toBe(false);
    expect(isExecutionError({code: -32603, message: "internal error"})).toBe(false);
    const urls = stub({[A]: () => [{id: 0, error: {code: -32000, message: "execution reverted"}}, {id: 1, result: "0x6000"}]});
    expect(await rpcClient({1: [A, B]})(1, CALLS)).toEqual([null, "0x6000"]);
    expect(urls).toEqual([A]);
  });

  it("a rate-limit element inside an HTTP-200 batch fails over to the next endpoint", async () => {
    const urls = stub({
      [A]: () => [{id: 0, result: WORD}, {id: 1, error: LIMITED}],
      [B]: () => [{id: 1, result: "0x6000"}, {id: 0, result: WORD}],
    });
    expect(await rpcClient({1: [A, B]})(1, CALLS)).toEqual([WORD, "0x6000"]);
    expect(urls).toEqual([A, B]);
  });

  it("a call left unanswered fails the endpoint too", async () => {
    stub({[A]: () => [{id: 0, result: WORD}], [B]: () => [{id: 0, result: WORD}, {id: 1, result: "0x6000"}]});
    expect(await rpcClient({1: [A, B]})(1, CALLS)).toEqual([WORD, "0x6000"]);
    stub({[A]: () => [{id: 0, result: WORD}]});
    await expect(rpcClient({1: [A]})(1, CALLS)).rejects.toThrow("curve: no RPC answered on chain 1 (answered 1 of 2 calls)");
  });

  it("every endpoint rate-limited: tried once more after a pause, then refused by name — never nulls", async () => {
    vi.useFakeTimers();
    let n = 0;
    const urls = stub({[A]: (ids) => (n++ === 0 ? ids.map((id) => ({id, error: LIMITED})) : ids.map((id) => ({id, result: WORD})))});
    const ok = rpcClient({1: [A]})(1, CALLS);
    await vi.advanceTimersByTimeAsync(RPC_RATE_LIMIT_PAUSE_MS);
    expect(await ok).toEqual([WORD, WORD]);
    expect(urls).toEqual([A, A]);
    const all = stub({[A]: (ids) => ids.map((id) => ({id, error: LIMITED})), [B]: (ids) => ids.map((id) => ({id, error: LIMITED}))});
    const refused = expect(rpcClient({1: [A, B]})(1, CALLS)).rejects.toThrow(/^curve: no RPC answered on chain 1 \(50\/second request limit reached/);
    await vi.advanceTimersByTimeAsync(RPC_RATE_LIMIT_PAUSE_MS);
    await refused;
    expect(all).toEqual([A, B, A, B]);
  });

  it("another node fault is not retried after a pause", async () => {
    const urls = stub({[A]: (ids) => ids.map((id) => ({id, error: {code: -32603, message: "internal error"}}))});
    await expect(rpcClient({1: [A]})(1, CALLS)).rejects.toThrow("curve: no RPC answered on chain 1 (internal error)");
    expect(urls).toEqual([A]);
  });
});

describe("preflight reads of pools", () => {
  const base = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME, amountIn: "1000000000", slippageBps: 10};
  const rpcUrls = {1: ["https://rpc.test"]};

  it("the Liquity metapool's pinned coins pass, from its real 4096-byte answers", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const p = curveProvider({rpcUrls, ...WITH_LUSD, onWarning: () => {}});
    const q = await p.getQuote({...base, sourceToken: "USDC", destToken: LUSD});
    expect(q!.providerData!.pools).toBe(LUSD_META);
    await expect(p.preflightDeposit!(q!, await p.buildDeposit(q!))).resolves.toBeUndefined();
  });

  it("a rate-limited read is refused as an RPC failure, not as a pool off its pin", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const p = curveProvider({rpcUrls, ...TABLES, onWarning: () => {}});
    const q = await p.getQuote({...base, sourceToken: "USDC", destToken: USDT});
    const tx = await p.buildDeposit(q!);
    vi.stubGlobal("fetch", rpcStub({limited: ["https://rpc.test"]}));
    vi.useFakeTimers();
    const refused = expect(p.preflightDeposit!(q!, tx)).rejects.toThrow(/^curve: no RPC answered on chain 1 \(50\/second request limit reached/);
    await vi.advanceTimersByTimeAsync(RPC_RATE_LIMIT_PAUSE_MS);
    await refused;
    vi.useRealTimers();
    // A failover endpoint answers: the same sealed quote passes.
    vi.stubGlobal("fetch", rpcStub({limited: ["https://rpc.test"]}));
    const two = curveProvider({rpcUrls: {1: ["https://rpc.test", "https://rpc2.test"]}, ...TABLES, onWarning: () => {}});
    await expect(two.preflightDeposit!(q!, tx)).resolves.toBeUndefined();
  });

  it("no code in the answer is a failed read, named as one", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const p = curveProvider({rpcUrls, ...TABLES, onWarning: () => {}});
    const q = await p.getQuote({...base, sourceToken: "USDC", destToken: USDT});
    vi.stubGlobal("fetch", rpcStub({noCode: [TRIPOOL]}));
    await expect(p.preflightDeposit!(q!, await p.buildDeposit(q!))).rejects.toThrow(/could not read pool 3pool \(0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7\) over RPC/);
  });

  it("checkPools: the preflight's pool check over a list, without a route", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const chain = curveOnChain({rpcUrls, ...WITH_LUSD, onWarning: () => {}});
    const all = [...POOLS[1]!.pools, LUSD_POOL];
    expect(await chain.checkPools(1, all)).toBeNull();
    expect(await chain.checkPools(1, [])).toBeNull();
    vi.stubGlobal("fetch", rpcStub({badPoolCode: [TRIPOOL]}));
    expect(await chain.checkPools(1, all)).toMatch(/pool 3pool .* is not the pinned code/);
    vi.stubGlobal("fetch", rpcStub({coinsRaw: {[LUSD_META.toLowerCase()]: {0: `0x${"0".repeat(64)}`}}}));
    expect(await chain.checkPools(1, [LUSD_POOL])).toMatch(/now reports coin 0 = 0x0{40}, not the pinned/);
  });
});
