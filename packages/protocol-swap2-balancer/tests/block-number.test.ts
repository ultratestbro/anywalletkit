// QuoteParams.blockNumber (0.4.0): the Vault's queryBatchSwap — the quote's price — goes to the request's block and
// the quote names it (Quote.blockNumber); the SOR's paths come from the API as before; the Vault's WETH() check and the
// preflight's re-pricing stay at "latest". Without it every request is 0.3.13's, byte for byte
// (fixtures/unpinned-0.3.13.json). A node that lacks the block fails its endpoint — the next is asked — then the quote
// is refused as stale_node naming the block, never priced at "latest".
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {balancerProvider} from "../src/provider.js";
import {ME, USDC, stub} from "./fixtures.js";
import {SCENARIOS, callOf, digested, run} from "./block-number-scenarios.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const golden = JSON.parse(readFileSync(new URL("../fixtures/unpinned-0.3.13.json", import.meta.url), "utf8")) as {module: string; scenarios: Record<string, ReturnType<typeof digested>>};
const BLOCK = "24000000";
const TAG = `0x${BigInt(BLOCK).toString(16)}`;
const QUERY_BATCH_SWAP = "0xf84d066e";

describe("without blockNumber: 0.3.13, byte for byte", () => {
  it("the fixture is 0.3.13's and covers every scenario", () => {
    expect(golden.module).toMatch(/protocol-swap2-balancer 0\.3\.13 \(source of origin\/main d77449a0\)/);
    expect(Object.keys(golden.scenarios)).toEqual(SCENARIOS.map((s) => s.name));
  });
  for (const s of SCENARIOS) {
    it(s.name, async () => {
      const got = digested(await run(balancerProvider as never, s));
      expect(got).toEqual(golden.scenarios[s.name]);
      expect(got.quote && "blockNumber" in got.quote).toBe(false);
    });
  }
});

describe("with blockNumber: the Vault prices the batch at that block", () => {
  for (const s of SCENARIOS) {
    it(s.name, async () => {
      const plain = await run(balancerProvider as never, s);
      const pinned = await run(balancerProvider as never, s, BLOCK);
      expect(pinned.quote).toEqual({...plain.quote, blockNumber: BLOCK});
      expect(pinned.refusals).toEqual(plain.refusals);
      expect(pinned.preflight).toEqual(plain.preflight);
      const calls = pinned.requests.map(([url, body]) => callOf(url, body));
      // In order: the Vault's WETH() at latest, the SOR, queryBatchSwap at the block (and the preflight's at latest).
      expect(calls).toEqual([
        {method: "eth_call", selector: "0xad5c4648", tag: "latest"},
        {method: "sor"},
        {method: "eth_call", selector: QUERY_BATCH_SWAP, tag: TAG},
        ...(s.preflight ? [{method: "eth_call", selector: QUERY_BATCH_SWAP, tag: "latest"}] : []),
      ]);
      // The same requests as without it, the quote's queryBatchSwap re-tagged.
      expect(pinned.requests.map(([u, b]) => `${u} ${b}`)).toEqual(plain.requests.map(([u, b], i) => `${u} ${i === 2 ? b.replace('"latest"]', `"${TAG}"]`) : b}`));
    });
  }
});

const params = (extra: Partial<QuoteParams> = {}): QuoteParams => ({sourceChain: "eip155:1", destChain: "eip155:1", sourceToken: "WETH", destToken: USDC, amountIn: "1000000000000000000", destAddress: ME, refundAddress: ME, blockNumber: BLOCK, ...extra});
/** The fixture stub, except that `lacking` endpoints answer a call at the block with `answer` (a body, or a whole HTTP reply). */
function lackingNode(lacking: string[], answer: () => object | {http: number; body: unknown}) {
  const inner = stub({vaultOut: 2_000_000n});
  const seen: {url: string; tag: unknown}[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as {method?: string; params?: unknown[]};
    if (body.method === "eth_call") seen.push({url, tag: body.params![1]});
    if (!lacking.includes(url) || body.params?.[1] !== TAG) return inner(input, init);
    const a = answer();
    if ("http" in a) return new Response(JSON.stringify((a as {body: unknown}).body), {status: (a as {http: number}).http});
    return new Response(JSON.stringify({jsonrpc: "2.0", id: 1, ...a}));
  }) as typeof fetch;
  return {fetch: f, seen};
}
async function quoteOn(node: ReturnType<typeof lackingNode>, urls: string[]) {
  vi.stubGlobal("fetch", node.fetch);
  const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
  const q = await balancerProvider({rpcUrls: {1: urls}}).getQuote(params({onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }}));
  return {q, heard};
}

describe("a node without the block", () => {
  it("one endpoint lacks it: the next prices the batch, and the quote names the block", async () => {
    const node = lackingNode(["https://a.test"], () => ({error: {code: -32000, message: "header not found"}}));
    const {q, heard} = await quoteOn(node, ["https://a.test", "https://b.test"]);
    expect(heard).toEqual([]);
    expect(q).toMatchObject({blockNumber: BLOCK, destAmount: "2000000"});
    expect(node.seen.filter((c) => c.tag === TAG).map((c) => c.url)).toEqual(["https://a.test", "https://b.test"]);
  });

  const lacks: Array<[string, () => object | {http: number; body: unknown}]> = [
    ['"header not found"', () => ({error: {code: -32000, message: "header not found"}})],
    ['"block not found" (reth)', () => ({error: {code: -32001, message: "block not found: 0x16e3600"}})],
    ['"No state available for block" (Nethermind, pruned)', () => ({error: {code: -32002, message: "No state available for block 24000000 (0x9429a8)"}})],
    ["a null result", () => ({result: null})],
    ['an HTTP 403 for state past the pruning (publicnode)', () => ({http: 403, body: {jsonrpc: "2.0", id: 1, error: {code: -32602, message: "Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode"}}})],
  ];
  for (const [what, answer] of lacks) {
    it(`no endpoint has it — ${what}: stale_node naming the block, never priced at "latest"`, async () => {
      const node = lackingNode(["https://a.test", "https://b.test"], answer);
      const {q, heard} = await quoteOn(node, ["https://a.test", "https://b.test"]);
      expect(q).toBeNull();
      expect(heard).toEqual([[expect.stringMatching(new RegExp(`^balancer: no RPC answered on chain 1 \\(block ${BLOCK} is not served by the node \\(`)), {reason: "stale_node"}]]);
      expect(heard[0]![0]).not.toMatch(/allnodes/);
      // The Vault check (latest) once; the batch at the block on both endpoints; nothing priced at latest.
      expect(node.seen.map((c) => [c.url, c.tag])).toEqual([["https://a.test", "latest"], ["https://a.test", TAG], ["https://b.test", TAG]]);
    });
  }

  it("a revert of the batch is still the Vault's answer (simulation_failed), not a node fault", async () => {
    const node = lackingNode(["https://a.test", "https://b.test"], () => ({error: {code: 3, message: "execution reverted: BAL#304"}}));
    const {heard} = await quoteOn(node, ["https://a.test", "https://b.test"]);
    expect(heard[0]![1]).toEqual({reason: "simulation_failed"});
    expect(node.seen.filter((c) => c.tag === TAG).map((c) => c.url)).toEqual(["https://a.test"]);
  });

  // Review 2026-11-28 #6: a revert reason a pool's rate provider or oracle chose may read like a node without the block.
  // It is still the Vault's answer — one endpoint asked, simulation_failed, as without blockNumber — never stale_node.
  const reverts: Array<[string, object]> = [
    ["code 3, \"execution reverted: oracle timestamp in the future\"", {code: 3, message: "execution reverted: oracle timestamp in the future", data: "0x08c379a0"}],
    ["code 3, \"execution reverted: rate provider could not be found\"", {code: 3, message: "execution reverted: rate provider could not be found"}],
    ["code 3, \"execution reverted: price after the current round\"", {code: 3, message: "execution reverted: price after the current round"}],
    ["Nethermind's -32015, \"VM execution error: block number in the future\"", {code: -32015, message: "VM execution error: block number in the future"}],
    ["-32000, \"execution reverted: header not found\" (a revert's text)", {code: -32000, message: "execution reverted: header not found"}],
  ];
  for (const [what, error] of reverts) {
    it(`a revert whose reason reads like a missing block — ${what}: simulation_failed, one endpoint asked, as without blockNumber`, async () => {
      const node = lackingNode(["https://a.test", "https://b.test", "https://c.test"], () => ({error}));
      const {q, heard} = await quoteOn(node, ["https://a.test", "https://b.test", "https://c.test"]);
      expect(q).toBeNull();
      expect(heard).toHaveLength(1);
      expect(heard[0]![1]).toEqual({reason: "simulation_failed"});
      expect(heard[0]![0]).not.toMatch(/is not served by the node/);
      expect(node.seen.filter((c) => c.tag === TAG).map((c) => c.url)).toEqual(["https://a.test"]);
      // The same answer at "latest" is classified the same way.
      const inner = stub({vaultOut: 2_000_000n});
      vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {method?: string; params?: [{data?: string}, unknown]};
        if (body.method === "eth_call" && body.params?.[0]?.data?.startsWith(QUERY_BATCH_SWAP)) return new Response(JSON.stringify({jsonrpc: "2.0", id: 1, error}));
        return inner(input, init);
      }) as typeof fetch);
      const plain: Array<[string, Swap2RefusalInfo | undefined]> = [];
      const {blockNumber: _pinned, ...unpinned} = params({onRefusal: (t: string, i?: Swap2RefusalInfo) => { plain.push([t, i]); }});
      await balancerProvider({rpcUrls: {1: ["https://a.test"]}}).getQuote(unpinned);
      expect(plain).toEqual(heard);
    });
  }

  it("an HTTP error whose JSON-RPC body is a revert (code 3) is not read as a node without the block", async () => {
    const node = lackingNode(["https://a.test"], () => ({http: 400, body: {jsonrpc: "2.0", id: 1, error: {code: 3, message: "execution reverted: timestamp in the future"}}}));
    const {heard} = await quoteOn(node, ["https://a.test"]);
    expect(heard).toEqual([["balancer: no RPC answered on chain 1 (HTTP 400)", {reason: "upstream_unavailable"}]]);
  });
});

describe("the request's blockNumber", () => {
  for (const bad of ["0x16e3600", "024000000", "-1", "", "latest", 24_000_000 as never]) {
    it(`${JSON.stringify(bad)} is refused before anything is sent`, async () => {
      const f = vi.fn(stub());
      vi.stubGlobal("fetch", f);
      const heard: string[] = [];
      expect(await balancerProvider({rpcUrls: {1: ["https://rpc.test"]}}).getQuote(params({blockNumber: bad, onRefusal: (t) => { heard.push(t); }}))).toBeNull();
      expect(heard).toEqual(["balancer: blockNumber must be a decimal block number (digits only, no leading zero)"]);
      expect(f).not.toHaveBeenCalled();
    });
  }

  it("the provider declares honorsBlockNumber", () => {
    expect(balancerProvider({rpcUrls: {}}).honorsBlockNumber).toBe(true);
  });
});
