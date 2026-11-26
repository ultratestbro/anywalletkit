// U1/U2 review round 3 (the SwapProxy check's unanswered reads are in v4-swapproxy-fixtures-u2.test.ts, the native
// preflight's balance answer in v4-monad-fixture-u1.test.ts, the watch's positive control in
// scripts/watch/watch-2026-11-26-evm-initialize.test.mjs):
// - R3-2: LIVE-1 on Arbitrum Nitro and Robinhood Chain reads a quoter call again at their 32M execution cap, so a route
//   no transaction there could carry is ranked out instead of refusing the whole quote, v3 included;
// - LIVE3-2: a recipient the chain's v4 pins name as a sink is refused for every venue once v4 is on (never quoted on v3
//   instead), and the 0.5.0 pins refuse a v3 quote paying it;
// - SEC-U4-R3-2: the pinned tables are frozen through their rows, the pool lists all the way down;
// - R3-3 / LIVE3-1: what the node says when the sender holds less than a call sends reads as that, not as an outage;
// - LIVE3-3: verify:live never prints "v4 linkage + codehashes ok" beside a Reason that says otherwise.
import {spawnSync} from "node:child_process";
import {existsSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it, vi} from "vitest";
import {getAddress} from "viem";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {UNISWAP_V3, uniswapPins, uniswapV3VerifyQuote, uniswapVerifyQuote} from "../src/addresses.js";
import {uniswapProvider, type UniswapProviderConfig} from "../src/provider.js";
import {shortOfFunds, type RpcSlot} from "../src/rpc.js";
import {UNISWAP_V4} from "../src/v4/addresses.js";
import {UNISWAP_V4_POOL_KEYS} from "../src/v4/listed.js";
import {v4StrandedRecipient} from "../src/v4/verify.js";
import {UNISWAP_V4_POOLS} from "../src/v4pools/index.js";
import {AUSD, CHAIN, D3, D4, ME, RPC, V4, fakeNode, v4PinsFor} from "./v4-fake-node.js";
import {MON_AUSD_500_1} from "./v4-helpers.js";
import {poolIdOf} from "../src/v4/pool.js";

afterEach(() => vi.unstubAllGlobals());

type Heard = Array<[string, Swap2RefusalInfo | undefined]>;
async function quote(p: QuoteParams, c: Partial<UniswapProviderConfig> & {rpcUrls?: UniswapProviderConfig["rpcUrls"]}) {
  const heard: Heard = [];
  const warned: Array<[string, unknown]> = [];
  const q = await uniswapProvider({rpcUrls: RPC, v4Deployments: V4, ...c, onV4Warning: (t, i) => { warned.push([t, i]); }}).getQuote({...p, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }});
  return {q, heard, warned};
}
const NATIVE = "0x0000000000000000000000000000000000000000";
/** `poolManager()`: the deployment check's linkage read, which also goes to the V4Quoter. */
const POOL_MANAGER_SEL = "0xdc4c90d3";

// ── R3-2 ────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("R3-2: LIVE-1 on Arbitrum Nitro (32M of execution per transaction): a quoter call still empty at that bound is ranked out", () => {
  const ARB = 42161;
  const USDC = getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
  const ETH = 10n ** 18n;
  // Two listed hookless ETH/USDC pools: 0.05%/10 prices normally, 0.3%/60 crosses so many ticks that its quoter call runs
  // out of any gas it is given (no revert data, in its aggregate and alone).
  const PRICED = "0x864abca0a6202dba5b8868772308da953ff125b0f95015adbf89aaf579e903a8";
  const GAS_BOMB = "0x03df2300e83353309c1069ae3ea89c31b361a009f9c36a1de5c8f0afcc45bde8";
  const ethToUsdc = (): QuoteParams => ({sourceChain: `eip155:${ARB}`, destChain: `eip155:${ARB}`, sourceToken: "ETH", destToken: USDC, amountIn: ETH.toString(), destAddress: ME, refundAddress: ME});
  const arb = {rpcUrls: {[ARB]: ["https://arbitrum.fake"]}, v4Deployments: v4PinsFor(ARB), v4: "native-in" as const};
  const node = (v4Out: bigint) => fakeNode({chainId: ARB, amount: ETH, v3: {tokenOut: USDC, fee: 500, out: 3_000_000_000n}, v4: new Map([[PRICED, {out: v4Out, gas: 120_000n}]]), emptyQuotes: new Set([GAS_BOMB])});

  it("the pools are in the shipped Arbitrum list (so the outcome is LIVE-1's, not provenance)", () => {
    const ids = new Set(UNISWAP_V4_POOLS[ARB]!.pools.map((p) => p.id));
    expect(ids.has(PRICED) && ids.has(GAS_BOMB)).toBe(true);
  });

  it("v3 wins: the v3 quote stands with the gas bomb counted (before, the quote was refused upstream_unavailable — v3 lost)", async () => {
    const n = node(2_900_000_000n);
    vi.stubGlobal("fetch", n.fetch);
    const {q, heard} = await quote(ethToUsdc(), arb);
    expect(heard).toEqual([]);
    expect(q).toMatchObject({destAmount: "3000000000", txRequest: {to: UNISWAP_V3[ARB]!.router}, providerData: {v4Unexecutable: "1"}});
    // The re-read went straight to the V4Quoter with exactly the 32M execution bound named.
    const reread = n.seen.filter((s) => s.to === getAddress(UNISWAP_V4[ARB]!.quoter) && s.data?.slice(0, 10) !== POOL_MANAGER_SEL);
    expect(reread.length).toBeGreaterThan(0);
    expect(reread.every((s) => s.gas === `0x${(32_000_000n).toString(16)}`)).toBe(true);
    expect(uniswapVerifyQuote(ethToUsdc(), q!)).toBeNull();
  });

  it("the minable v4 route wins when it pays more; v4 alone with only the gas bomb, refused naming the 32M bound", async () => {
    vi.stubGlobal("fetch", node(3_100_000_000n).fetch);
    const {q} = await quote(ethToUsdc(), arb);
    expect(q).toMatchObject({destAmount: "3100000000", txRequest: {to: UNISWAP_V4[ARB]!.universalRouter}, providerData: {venue: "v4", route: "v4 direct 0.05%/10", v4Unexecutable: "1"}});
    expect(uniswapVerifyQuote(ethToUsdc(), q!)).toBeNull();
    vi.stubGlobal("fetch", fakeNode({chainId: ARB, amount: ETH, v4: new Map(), emptyQuotes: new Set([GAS_BOMB])}).fetch);
    const alone = await quote(ethToUsdc(), {...arb, deployments: {}});
    expect(alone.q).toBeNull();
    expect(alone.heard).toEqual([[expect.stringMatching(/the v4 ones need more gas than one transaction on chain 42161 may have \(32000000\)/), {reason: "insufficient_liquidity"}]]);
  });

  it("Robinhood Chain (also Nitro, 32M): the same bound", async () => {
    const RH = 4663;
    // Two listed hookless pools of one native pair (no `since`: in the chain's first list).
    const C1 = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
    const [ok, bomb] = UNISWAP_V4_POOLS[RH]!.pools.filter((p) => p.currency0 === NATIVE && getAddress(p.currency1) === C1 && p.since === undefined);
    expect(ok && bomb && ok.id !== bomb.id).toBe(true);
    const n = fakeNode({chainId: RH, amount: 10n ** 18n, v3: {tokenOut: C1, fee: 3000, out: 1_000_000n}, v4: new Map([[ok!.id, {out: 900_000n, gas: 100_000n}]]), emptyQuotes: new Set([bomb!.id])});
    vi.stubGlobal("fetch", n.fetch);
    const {q, heard} = await quote({sourceChain: `eip155:${RH}`, destChain: `eip155:${RH}`, sourceToken: "ETH", destToken: C1, amountIn: (10n ** 18n).toString(), destAddress: ME, refundAddress: ME},
      {rpcUrls: {[RH]: ["https://robinhood.fake"]}, v4Deployments: v4PinsFor(RH), v4: "native-in"});
    expect(heard).toEqual([]);
    expect(q).toMatchObject({destAmount: "1000000", txRequest: {to: UNISWAP_V3[RH]!.router}, providerData: {v4Unexecutable: "1"}});
    const reread = n.seen.filter((s) => s.to === getAddress(UNISWAP_V4[RH]!.quoter) && s.data?.slice(0, 10) !== POOL_MANAGER_SEL);
    expect(reread.length).toBeGreaterThan(0);
    expect(reread.every((s) => s.gas === `0x${(32_000_000n).toString(16)}`)).toBe(true);
  });
});

// ── LIVE3-2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("LIVE3-2: a recipient the v4 pins name as a sink is refused for every venue once v4 is on, and by the 0.5.0 pins", () => {
  const MON = 100n * 10n ** 18n;
  const P_ID = poolIdOf(MON_AUSD_500_1).toLowerCase();
  const to = (destAddress: string): QuoteParams => ({sourceChain: `eip155:${CHAIN}`, destChain: `eip155:${CHAIN}`, sourceToken: "MON", destToken: AUSD, amountIn: MON.toString(), destAddress, refundAddress: ME});
  const sinks: [string, string][] = [
    ["the Universal Router", D4.universalRouter], ["the SwapProxy", D4.swapProxy], ["the PoolManager", D4.poolManager], ["the PositionManager", D4.positionManager],
    ["the V4Quoter", D4.quoter], ["the StateView", D4.stateView], ["Permit2", D4.permit2], ["the zero address", NATIVE],
    ["MSG_SENDER (0x…01)", "0x0000000000000000000000000000000000000001"], ["ADDRESS_THIS (0x…02)", "0x0000000000000000000000000000000000000002"],
  ];
  for (const [name, sink] of sinks) {
    it(`${name}: refused recipient_mismatch before any read (v3 would have paid it: before, onV4Warning, then the v3 quote)`, async () => {
      const n = fakeNode({amount: MON, v3: {tokenOut: AUSD, fee: 3000, out: 1_000_000n}, v4: new Map([[P_ID, {out: 900_000n, gas: 60_000n}]])});
      vi.stubGlobal("fetch", n.fetch);
      for (const v4 of ["native-in", "all"] as const) {
        const {q, heard, warned} = await quote(to(sink.toLowerCase()), {v4});
        expect(q, v4).toBeNull();
        expect(heard, v4).toEqual([[`uniswap: the recipient ${getAddress(sink)} is a router sentinel or a pinned Uniswap contract — output paid there is stranded`, {reason: "recipient_mismatch"}]]);
        expect(warned, v4).toEqual([]);
      }
      expect(n.seen).toEqual([]); // refused before any read
      // v4 off: byte-for-byte 0.4.11 — the v3 quote, as before.
      const off = await quote(to(sink), {});
      expect(off.q?.txRequest?.to).toBe(D3.router);
      expect(uniswapV3VerifyQuote(to(sink), off.q!)).toBeNull();
      // The 0.5.0 pins refuse that v3 quote on a chain with v4 pins, with a reason; 0.4.11's v3 check is unchanged.
      const pins = uniswapPins.verifyQuote!(to(sink), off.q!);
      expect(pins).toBe(`the recipient ${getAddress(sink)} is a router sentinel or a pinned Uniswap contract — output paid there is stranded`);
      expect(uniswapPins.reasonOf!(pins!)).toEqual({reason: "recipient_mismatch"});
      expect(uniswapVerifyQuote(to(sink), off.q!)).toBe(pins);
    });
  }
  it("an ordinary recipient is untouched: the v4 quote, accepted by the pins; a chain without v4 pins keeps 0.4.11's check", async () => {
    vi.stubGlobal("fetch", fakeNode({amount: MON, v3: {tokenOut: AUSD, fee: 3000, out: 1_000_000n}, v4: new Map([[P_ID, {out: 1_200_000n, gas: 60_000n}]])}).fetch);
    const {q, heard} = await quote(to(ME), {v4: "native-in"});
    expect(heard).toEqual([]);
    expect(q).toMatchObject({destAmount: "1200000", providerData: {venue: "v4"}});
    expect(v4StrandedRecipient(D4, ME)).toBe(false);
    expect(v4StrandedRecipient(D4, "not an address")).toBe(false);
    // zkSync Era (324) has v3 pins only: a recipient equal to Monad's Universal Router address is no sink there.
    expect(Object.prototype.hasOwnProperty.call(UNISWAP_V4, 324)).toBe(false);
  });
});

// ── SEC-U4-R3-2 ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("SEC-U4-R3-2: the pinned tables cannot be repointed in process", () => {
  it("every v3 and v4 row is frozen; a write throws and the pins keep their spenders and their verdict", () => {
    for (const t of [UNISWAP_V3, UNISWAP_V4]) {
      expect(Object.isFrozen(t)).toBe(true);
      for (const row of Object.values(t)) expect(Object.isFrozen(row)).toBe(true);
    }
    const before = uniswapPins.spenders("eip155:143");
    expect(() => { (UNISWAP_V4[143] as {swapProxy: string}).swapProxy = "0x3333333333333333333333333333333333333333"; }).toThrow(TypeError);
    expect(() => { (UNISWAP_V4[143] as {universalRouter: string}).universalRouter = "0x3333333333333333333333333333333333333333"; }).toThrow(TypeError);
    expect(() => { (UNISWAP_V3[143] as {router: string}).router = "0x3333333333333333333333333333333333333333"; }).toThrow(TypeError);
    expect(() => { delete (UNISWAP_V4[143] as {routerCodehash?: string}).routerCodehash; }).toThrow(TypeError);
    expect(uniswapPins.spenders("eip155:143")).toEqual(before);
    expect(before).not.toContain("0x3333333333333333333333333333333333333333");
  });

  it("every shipped pool list is frozen all the way down: the list, its tokens, its pools and each pool", () => {
    for (const [id, list] of Object.entries(UNISWAP_V4_POOLS)) {
      expect([id, Object.isFrozen(list), Object.isFrozen(list.tokens), Object.isFrozen(list.pools), list.pools.every((p) => Object.isFrozen(p))]).toEqual([id, true, true, true, true]);
    }
    const monad = UNISWAP_V4_POOLS[143]!;
    const n = monad.pools.length;
    expect(() => { (monad.pools as unknown as unknown[]).push({...monad.pools[0], id: "0x" + "11".repeat(32)}); }).toThrow(TypeError);
    expect(() => { (monad.pools[0] as {id: string}).id = "0x" + "22".repeat(32); }).toThrow(TypeError);
    expect(() => { (monad.tokens as unknown as string[]).push("0x3333333333333333333333333333333333333333"); }).toThrow(TypeError);
    expect(() => { (monad as {block: number}).block = 1; }).toThrow(TypeError);
    expect(monad.pools.length).toBe(n);
    expect(UNISWAP_V4_POOL_KEYS[143]!.length).toBe(n);
  });
});

// ── R3-3 / LIVE3-1 ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("R3-3 / LIVE3-1: the node's answer for a sender short of what a call sends", () => {
  const failed = (code: number, message: string): RpcSlot => ({ok: false, failed: new Error(`uniswap: no RPC answered on chain 1 (${code} ${message})`), error: {code, message}});
  it("reads the nodes' texts (Monad, revm/reth, geth, Erigon, Nethermind, Besu) as that answer", () => {
    for (const [code, message] of [
      [-32003, "Insufficient funds for gas * price + value"], [-32003, "EVM error: OutOfFunds"], [-32000, "insufficient funds for transfer"],
      [-32000, "insufficient funds for gas * price + value: address 0x1111111111111111111111111111111111111111 have 0 want 1"], [-32000, "insufficient sender balance"],
      [-32004, "Upfront cost exceeds account balance"], [-32000, "lack of funds (0) for max fee (1)"],
    ] as const) expect(shortOfFunds(failed(code, message)), message).toBe(`${code} ${message}`.slice(0, 200));
  });
  it("and nothing else: a rate limit, a node fault, a revert, an answer, no slot", () => {
    for (const [code, message] of [[-32007, "50/second request limit reached"], [-32603, "internal error"], [-32000, "header not found"], [-32602, "invalid params"]] as const) expect(shortOfFunds(failed(code, message)), message).toBeUndefined();
    expect(shortOfFunds({ok: false, revert: {code: 3, message: "execution reverted: ERC20: transfer amount exceeds balance"}})).toBeUndefined();
    expect(shortOfFunds({ok: true, result: "0x"})).toBeUndefined();
    expect(shortOfFunds({ok: false, failed: new Error("HTTP 429")})).toBeUndefined();
    expect(shortOfFunds(undefined)).toBeUndefined();
  });
});

// ── LIVE3-3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("LIVE3-3: verify:live's v4 note follows its own Reason lines", () => {
  const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const built = existsSync(resolve(pkg, "dist/index.js"));
  it.skipIf(!built)("Monad with every v4 code hash off: the FAIL line says drift, never \"v4 linkage + codehashes ok\"", () => {
    const d3 = UNISWAP_V3[143]!, d4 = UNISWAP_V4[143]!;
    const word = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
    // A node serving chain 143 with the v3 linkage right, every v4 contract's code another build (one byte), the v4
    // linkage right, the quoter canary reverting, and no latest block: offline, no endpoint read.
    const answers = {factory: word(d3.factory), weth: word(d3.weth), pm: word(d4.poolManager)};
    const stub = `async (_url, init) => {
      const a = ${JSON.stringify(answers)};
      const r = JSON.parse(String(init.body));
      const one = (q) => {
        if (q.method === "eth_chainId") return {result: "0x8f"};
        if (q.method === "eth_getCode") return {result: "0x60"};
        if (q.method === "eth_getBlockByNumber") return {result: null};
        if (q.method === "eth_call") {
          const sel = String(q.params[0].data).slice(0, 10);
          if (sel === "0xc45a0155") return {result: a.factory};
          if (sel === "0x4aa4a4fc") return {result: a.weth};
          if (sel === "0xdc4c90d3") return {result: a.pm};
        }
        return {error: {code: 3, message: "execution reverted", data: "0x"}};
      };
      const out = Array.isArray(r) ? r.map((q) => ({jsonrpc: "2.0", id: q.id, ...one(q)})) : {jsonrpc: "2.0", id: r.id, ...one(r)};
      return new Response(JSON.stringify(out), {status: 200, headers: {"content-type": "application/json"}});
    }`;
    const env: Record<string, string | undefined> = {...process.env, RPC_143: "https://monad.stub.invalid"};
    const r = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(`globalThis.fetch = ${stub};`)}`, "scripts/verify-live.mjs", "143"], {cwd: pkg, env, encoding: "utf8", timeout: 60_000});
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, out).toBe(1);
    const line = out.split("\n").find((l) => l.startsWith("FAIL chain 143"));
    expect(line, out).toBeDefined();
    expect(line).toMatch(/v3 router\/quoter linkage ok; v4 linkage\/codehash drift \(3 problems, see Reason\), 38 listed pools/);
    expect(line).not.toMatch(/v4 linkage \+ codehashes ok/);
    expect(out).toMatch(/Reason: v4: the Universal Router's code hashes to/);
    expect(out).toMatch(/Reason: v4: the SwapProxy's code hashes to/);
    expect(out).not.toMatch(/https?:\/\/monad\.stub/); // no endpoint printed
  }, 60_000);
});
