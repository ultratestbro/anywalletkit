/**
 * CS-9 (2026-11-12): the inbound vault rotates among THORChain's active asgard vaults every few minutes, and the
 * public nodes a browser can reach ran ~25–28 blocks behind the quoting node, so an exact match between the quote's
 * vault and the confirming node's current inbound refused most quotes ("Couldn't double-check its vault"). A
 * confirming node now also accepts the chain's address of a vault it lists as ActiveVault and its mimir does not flag
 * compromised or insolvent; it is skipped for the next one when it trails the quoting node by more than
 * `confirmMaxLagBlocks`, fails, redirects, answers another shape or takes longer than `confirmTimeoutMs`. Every other
 * check (router, halts, memo, minimums, the quote node's own binding) stays as strict as before.
 *
 * Vault data is the live answer recorded on 2026-11-12 (six ActiveVaults; the quote node's inbound is vault B, the
 * confirming node's is vault A, both of them recorded vaults). Fake nodes, no network.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeFunctionData, getAddress} from "viem";
import {THORNODE_CONFIRM_PATHS, thorchainPins, thorchainProvider} from "../src/provider.js";
import type {Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import inboundLive from "../fixtures/thornode/2026-11-12/liquify/inbound_addresses.json";
import {LIVE_ASGARD, LIVE_HEIGHT, LIVE_MIMIR, lastblockAt} from "./thornode-stub.js";

const QUOTE = "https://quote.invalid";
const CONFIRM = "https://confirm.invalid";
const CONFIRM2 = "https://confirm2.invalid";
const LIQUIFY = "https://gateway.liquify.com/chain/thorchain_api";
const IBS = "https://thorchain.ibs.team/api";

const liveVault = (tail: string) => LIVE_ASGARD.find((v) => v.pub_key.endsWith(tail))!;
const addressOf = (tail: string, chain: string) => liveVault(tail).addresses.find((a) => a.chain === chain)!.address;
/** Vault A: the confirming node's current inbound in the recording. Vault B: another ActiveVault of the recording. */
const A_TAIL = "udx7767";
const B_TAIL = "4wxjp8az";
const VAULT_A = addressOf(A_TAIL, "ETH");
const VAULT_B = addressOf(B_TAIL, "ETH");
const TRON_A = addressOf(A_TAIL, "TRON");
const TRON_B = addressOf(B_TAIL, "TRON");
const NOT_A_VAULT = "0x9999999999999999999999999999999999999999";
const ETH_ROUTER = "0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146";
const ATTACKER_ROUTER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BTC_DEST = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const ETH_DEST = "0x4444444444444444444444444444444444444444";
const NATIVE = "0x0000000000000000000000000000000000000000";

const ROUTER_ABI = [{type: "function", name: "depositWithExpiry", stateMutability: "payable", inputs: [{name: "vault", type: "address"}, {name: "asset", type: "address"}, {name: "amount", type: "uint256"}, {name: "memo", type: "string"}, {name: "expiry", type: "uint256"}], outputs: []}] as const;

type Path = keyof typeof THORNODE_CONFIRM_PATHS | "quote";
interface FakeNode {
  height: number;
  inbound: unknown;
  asgard: unknown;
  mimir: unknown;
  quote?: unknown;
  /** No answer at all (network error). */
  down?: boolean;
  /** Never answers until the request is aborted. */
  hang?: boolean;
  /** Answer one read only after this many ms (rejected if the request is aborted first). */
  delay?: Partial<Record<Path, number>>;
  /** Replace one read's answer. */
  answer?: Partial<Record<Path, () => Response>>;
}
interface Read {host: string; path: string; search: string; method: string | undefined; init: RequestInit | undefined}

let nodes: Record<string, FakeNode>;
let reads: Read[];

/** The live inbound snapshot with the EVM chains' (or Tron's) address replaced, and optional entry overrides. */
function inboundWith(evm: string, tron = TRON_A, overrides: Record<string, Record<string, unknown>> = {}): unknown[] {
  return (inboundLive as Record<string, unknown>[]).map((e) => {
    const chain = String(e.chain);
    const address = ["ETH", "BASE", "BSC", "AVAX"].includes(chain) ? evm : chain === "TRON" ? tron : e.address;
    return {...e, address, ...(overrides[chain] ?? {})};
  });
}
/** The live asgard answer with one recorded vault's status (or addresses) changed. */
function asgardWith(tail: string, change: Record<string, unknown>): unknown[] {
  return LIVE_ASGARD.map((v) => (v.pub_key.endsWith(tail) ? {...v, ...change} : v));
}
const quoteNaming = (vault: string, router: string | undefined = ETH_ROUTER, memo = `=:b:${BTC_DEST}:95000`) => ({
  expected_amount_out: "100000", inbound_address: vault, ...(router ? {router} : {}), memo, expiry: Math.floor(Date.now() / 1000) + 3600,
});
const node = (o: Partial<FakeNode> = {}): FakeNode => ({height: LIVE_HEIGHT, inbound: inboundWith(VAULT_A), asgard: LIVE_ASGARD, mimir: LIVE_MIMIR, ...o});

const pathOf = (pathname: string): Path | null => {
  if (pathname.endsWith("/thorchain/quote/swap")) return "quote";
  for (const [k, p] of Object.entries(THORNODE_CONFIRM_PATHS)) if (pathname.endsWith(p)) return k as Path;
  return null;
};

beforeEach(() => {
  nodes = {
    // The quoting node sees the inbound rotated to vault B; the confirming node still names vault A.
    [QUOTE]: node({inbound: inboundWith(VAULT_B), quote: quoteNaming(VAULT_B)}),
    [CONFIRM]: node(),
  };
  reads = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const host = Object.keys(nodes).find((h) => String(input).startsWith(`${h}/`));
    if (!host) return new Response("nope", {status: 404});
    const path = pathOf(url.pathname);
    reads.push({host, path: url.pathname.slice(new URL(host).pathname.replace(/\/$/, "").length), search: url.search, method: init?.method, init});
    const n = nodes[host]!;
    if (n.down) throw new TypeError("fetch failed");
    if (n.hang) {
      return new Promise<Response>((_, reject) => {
        const s = init?.signal;
        if (s?.aborted) reject(new DOMException("aborted", "AbortError"));
        s?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (!path) return new Response("nope", {status: 404});
    const wait = n.delay?.[path];
    if (wait !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const s = init?.signal;
        const t = setTimeout(resolve, wait);
        s?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    const custom = n.answer?.[path];
    if (custom) return custom();
    const body = path === "quote" ? n.quote : path === "lastblock" ? lastblockAt(n.height) : path === "inboundAddresses" ? n.inbound : path === "asgardVaults" ? n.asgard : n.mimir;
    if (body === undefined) return new Response("nope", {status: 404});
    return new Response(JSON.stringify(body), {status: 200});
  });
});
const nativeTimeout = AbortSignal.timeout;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  (AbortSignal as unknown as {timeout: unknown}).timeout = nativeTimeout;
});
/**
 * Fake setTimeout / clearTimeout / Date, and no native AbortSignal.timeout (Node's runs on its own timer), so every
 * deadline — the 8 s read bounds included — runs on the fake clock, as it would on Hermes (which has no
 * AbortSignal.timeout).
 */
function fakeClock(): void {
  vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
  (AbortSignal as unknown as {timeout: unknown}).timeout = undefined;
}

const params = (o: Partial<QuoteParams> = {}): QuoteParams => ({
  sourceChain: "eip155:1", sourceToken: "ETH", destChain: "bitcoin:mainnet", destToken: NATIVE,
  amountIn: "50000000000000000", destAddress: BTC_DEST, ...o,
});
const provider = (o: Parameters<typeof thorchainProvider>[0] = {}) => thorchainProvider({nodeUrl: QUOTE, confirmNodeUrl: [CONFIRM, CONFIRM2], ...o});
async function quote(o: Parameters<typeof thorchainProvider>[0] = {}, p: Partial<QuoteParams> = {}) {
  const reasons: string[] = [];
  const q = await provider(o).getQuote(params({...p, onRefusal: (r) => reasons.push(r)}));
  return {q, reasons};
}
const readsOn = (host: string) => reads.filter((r) => r.host === host).map((r) => r.path);

describe("vault rotation: any ActiveVault of the confirming node confirms", () => {
  it("quote node names vault B, the confirming node's inbound is vault A, its asgard lists both as ActiveVault → accepted", async () => {
    const {q, reasons} = await quote();
    expect(reasons).toEqual([]);
    expect(q).not.toBeNull();
    const call = decodeFunctionData({abi: ROUTER_ABI, data: q!.txRequest!.data as `0x${string}`});
    expect(String(call.args[0]).toLowerCase()).toBe(VAULT_B); // the quoted vault, never the confirming node's
    expect(q!.providerData?.inboundAddress).toBe(VAULT_B);
    // The confirming node got exactly the four fixed reads (lastblock + inbound first, asgard + mimir on a mismatch).
    expect(readsOn(CONFIRM).sort()).toEqual(Object.values(THORNODE_CONFIRM_PATHS).slice().sort());
  });

  it("every confirming read is a GET on a fixed path: no query string, no cache option (React Native would add ?_=), no redirect followed", async () => {
    await quote();
    const confirming = reads.filter((r) => r.host === CONFIRM || (r.host === QUOTE && r.path === THORNODE_CONFIRM_PATHS.lastblock));
    expect(confirming.length).toBe(5);
    for (const r of confirming) {
      expect(Object.values(THORNODE_CONFIRM_PATHS)).toContain(r.path);
      expect(r.search).toBe("");
      expect(r.method).toBe("GET");
      expect(r.init && "cache" in r.init).toBe(false);
      expect(r.init?.redirect).toBe("error");
      expect(r.init?.body).toBeUndefined();
    }
  });

  it("an exact match with the confirming node's inbound needs only lastblock + inbound_addresses", async () => {
    nodes[CONFIRM]!.inbound = inboundWith(VAULT_B);
    const {q} = await quote();
    expect(q).not.toBeNull();
    expect(readsOn(CONFIRM).sort()).toEqual([THORNODE_CONFIRM_PATHS.inboundAddresses, THORNODE_CONFIRM_PATHS.lastblock].sort());
  });

  it("EVM addresses compare case-insensitively (a checksummed quote vs the lowercase asgard entry)", async () => {
    const checksummed = getAddress(VAULT_B);
    nodes[QUOTE] = node({inbound: inboundWith(checksummed), quote: quoteNaming(checksummed)});
    const {q, reasons} = await quote();
    expect(reasons).toEqual([]);
    expect(q).not.toBeNull();
  });

  it("re-confirms the same way right before broadcast, and still refuses calldata paying another (even active) vault", async () => {
    const p = provider();
    const q = (await p.getQuote(params()))!;
    const tx = await p.buildDeposit(q);
    await expect(p.preflightDeposit!(q, tx)).resolves.toBeUndefined();
    // Swapped vault: vault A is an ActiveVault too, but the transaction must pay exactly the quoted vault.
    const swapped = encodeFunctionData({abi: ROUTER_ABI, functionName: "depositWithExpiry", args: [VAULT_A as `0x${string}`, NATIVE, 50_000_000_000_000_000n, q.providerData!.memo!, BigInt(q.providerData!.expiry!)]});
    await expect(p.preflightDeposit!(q, {...tx, data: swapped})).rejects.toThrow(/calldata does not match the validated quote/);
    // The vault turns RetiringVault on the confirming node before broadcast → refused.
    nodes[CONFIRM]!.asgard = asgardWith(B_TAIL, {status: "RetiringVault"});
    await expect(p.preflightDeposit!(q, tx)).rejects.toThrow("thorchain: a second node lists the inbound vault as RetiringVault, not ActiveVault — refused");
  });

  it("Tron source: the vault rotates too; Tron addresses compare exactly (a case-changed address is another address)", async () => {
    const tronQuote = {expected_amount_out: "2061155", inbound_address: TRON_B, memo: `=:e:${ETH_DEST}:2014026`, expiry: Math.floor(Date.now() / 1000) + 3600};
    nodes[QUOTE] = node({inbound: inboundWith(VAULT_B, TRON_B), quote: tronQuote});
    const tron = {sourceChain: "tron:728126428", sourceToken: "USDT", destChain: "eip155:1", destToken: NATIVE, amountIn: "50000000", destAddress: ETH_DEST};
    let r = await quote({tronSource: true}, tron);
    expect(r.reasons).toEqual([]);
    expect(r.q?.depositAddress).toBe(TRON_B);
    const lowered = TRON_B.toLowerCase();
    nodes[QUOTE] = node({inbound: inboundWith(VAULT_B, lowered), quote: {...tronQuote, inbound_address: lowered}});
    r = await quote({tronSource: true}, tron);
    expect(r.q).toBeNull();
    expect(r.reasons).toEqual(["thorchain: a second node reports another inbound vault — refused until they agree"]);
  });
});

describe("what never confirms", () => {
  it("an address in no vault of the confirming node → refused (the existing reason)", async () => {
    nodes[QUOTE] = node({inbound: inboundWith(NOT_A_VAULT), quote: quoteNaming(NOT_A_VAULT)});
    const {q, reasons} = await quote();
    expect(q).toBeNull();
    expect(reasons).toEqual(["thorchain: a second node reports another inbound vault — refused until they agree"]);
  });

  it("an address held only by a RetiringVault (or any status but ActiveVault) → refused", async () => {
    for (const status of ["RetiringVault", "InactiveVault", "InitVault"]) {
      nodes[CONFIRM]!.asgard = asgardWith(B_TAIL, {status});
      const {q, reasons} = await quote();
      expect(q).toBeNull();
      expect(reasons).toEqual([`thorchain: a second node lists the inbound vault as ${status}, not ActiveVault — refused`]);
    }
  });

  it("the address must be the vault's address for the source chain exactly (listed for BASE only → refused for ETH)", async () => {
    const baseOnly = liveVault(B_TAIL).addresses.filter((a) => a.chain !== "ETH");
    nodes[CONFIRM]!.asgard = asgardWith(B_TAIL, {addresses: baseOnly});
    const {q, reasons} = await quote();
    expect(q).toBeNull();
    expect(reasons).toEqual(["thorchain: a second node reports another inbound vault — refused until they agree"]);
  });

  it("a vault the confirming node's mimir flags compromised or insolvent → refused (THORNode leaves those out of inbound election)", async () => {
    const pub = liveVault(B_TAIL).pub_key.toUpperCase();
    nodes[CONFIRM]!.mimir = {...LIVE_MIMIR, [`COMPROMISEDVAULT-${pub}`]: 1};
    let r = await quote();
    expect(r.reasons).toEqual(["thorchain: a second node's mimir flags the inbound vault as compromised — refused"]);
    nodes[CONFIRM]!.mimir = {...LIVE_MIMIR, [`SOLVENCYHALTVAULT-${pub}-ETH`]: 1};
    r = await quote();
    expect(r.reasons).toEqual(["thorchain: a second node's mimir flags the inbound vault as insolvent — refused"]);
    // Present but 0 (as in the recording for vault A's ETH key) is not a flag.
    nodes[CONFIRM]!.mimir = {...LIVE_MIMIR, [`SOLVENCYHALTVAULT-${pub}-ETH`]: 0, [`COMPROMISEDVAULT-${pub}`]: 0};
    r = await quote();
    expect(r.reasons).toEqual([]);
    expect(r.q).not.toBeNull();
  });

  it("a router other than the quote's on the confirming node → refused, on a rotated vault and on an exact match", async () => {
    nodes[CONFIRM]!.inbound = inboundWith(VAULT_A, TRON_A, {ETH: {router: ATTACKER_ROUTER}});
    let r = await quote();
    expect(r.reasons).toEqual(["thorchain: a second node reports another router — refused until they agree"]);
    nodes[CONFIRM]!.inbound = inboundWith(VAULT_B, TRON_A, {ETH: {router: ATTACKER_ROUTER}});
    r = await quote();
    expect(r.reasons).toEqual(["thorchain: a second node reports another router — refused until they agree"]);
  });

  it("a swapped recipient is still refused before any node is asked to confirm", async () => {
    nodes[QUOTE]!.quote = quoteNaming(VAULT_B, ETH_ROUTER, "=:b:bc1qattacker0000000000000000000000000000000:95000");
    const {q, reasons} = await quote();
    expect(q).toBeNull();
    expect(reasons[0]).toMatch(/^thorchain: memo failed verification/);
    expect(readsOn(CONFIRM)).toEqual([]);
  });

  it("halts and pauses the confirming node reports refuse: source chain, destination chain, global", async () => {
    const cases: [Record<string, Record<string, unknown>>, string][] = [
      [{ETH: {halted: true}}, "thorchain: ETH is halted / paused on the confirming node"],
      [{ETH: {chain_trading_paused: true}}, "thorchain: ETH is halted / paused on the confirming node"],
      [{ETH: {global_trading_paused: true}}, "thorchain: ETH is halted / paused on the confirming node"],
      [{BTC: {halted: true}}, "thorchain: BTC is halted / paused on the confirming node"],
      [{BTC: {chain_trading_paused: true}}, "thorchain: BTC is halted / paused on the confirming node"],
    ];
    for (const [overrides, reason] of cases) {
      nodes[CONFIRM]!.inbound = inboundWith(VAULT_A, TRON_A, overrides);
      const {q, reasons} = await quote();
      expect(q).toBeNull();
      expect(reasons).toEqual([reason]);
    }
  });
});

describe("node lag and failures: the next confirming node is asked", () => {
  it("a node more than 50 blocks behind the quoting node is skipped; the next one confirms", async () => {
    nodes[CONFIRM]!.height = LIVE_HEIGHT - 51;
    nodes[CONFIRM2] = node();
    const {q, reasons} = await quote();
    expect(reasons).toEqual([]);
    expect(q).not.toBeNull();
    expect(readsOn(CONFIRM).sort()).toEqual([THORNODE_CONFIRM_PATHS.inboundAddresses, THORNODE_CONFIRM_PATHS.lastblock].sort());
    expect(readsOn(CONFIRM2)).toContain(THORNODE_CONFIRM_PATHS.asgardVaults);
  });

  it("exactly 50 behind (the default limit) still confirms; a node ahead of the quoting node confirms; the limit is configurable", async () => {
    nodes[CONFIRM]!.height = LIVE_HEIGHT - 50;
    expect((await quote()).q).not.toBeNull();
    nodes[CONFIRM]!.height = LIVE_HEIGHT + 30;
    expect((await quote()).q).not.toBeNull();
    nodes[CONFIRM]!.height = LIVE_HEIGHT - 28; // the lag seen on 2026-11-12
    const r = await quote({confirmMaxLagBlocks: 10});
    expect(r.q).toBeNull();
    expect(r.reasons).toEqual(["thorchain: no confirming node is within 10 blocks of the quoting node's THORChain height (behind or unreachable) — refused until one catches up"]);
  });

  it("every confirming node behind → refused with the lag reason; every one unreachable → the existing reason", async () => {
    nodes[CONFIRM]!.height = LIVE_HEIGHT - 60;
    nodes[CONFIRM2] = node({height: LIVE_HEIGHT - 200});
    nodes[LIQUIFY] = node({down: true});
    nodes[IBS] = node({down: true});
    let r = await quote();
    expect(r.q).toBeNull();
    expect(r.reasons).toEqual(["thorchain: no confirming node is within 50 blocks of the quoting node's THORChain height (behind or unreachable) — refused until one catches up"]);
    nodes[CONFIRM]!.down = true;
    nodes[CONFIRM2]!.down = true;
    r = await quote();
    expect(r.reasons).toEqual(["thorchain: no second node answered to confirm the inbound vault (configure confirmNodeUrl)"]);
  });

  it("before broadcast too: a lagging node is skipped, all lagging refuses", async () => {
    const p = provider();
    const q = (await p.getQuote(params()))!;
    const tx = await p.buildDeposit(q);
    nodes[CONFIRM]!.height = LIVE_HEIGHT - 100;
    nodes[CONFIRM2] = node();
    await expect(p.preflightDeposit!(q, tx)).resolves.toBeUndefined();
    nodes[CONFIRM2]!.height = LIVE_HEIGHT - 100;
    nodes[LIQUIFY] = node({down: true});
    nodes[IBS] = node({down: true});
    await expect(p.preflightDeposit!(q, tx)).rejects.toThrow(/no confirming node is within 50 blocks/);
  });

  it("the quoting node's own lastblock failing re-runs the quote on the next nodeUrl host", async () => {
    nodes[QUOTE]!.answer = {lastblock: () => new Response("down", {status: 503})};
    nodes["https://quote2.invalid"] = node({inbound: inboundWith(VAULT_B), quote: quoteNaming(VAULT_B)});
    const {q, reasons} = await quote({nodeUrl: [QUOTE, "https://quote2.invalid"]});
    expect(reasons).toEqual([]);
    expect(q).not.toBeNull();
    expect(reads.filter((r) => r.path === "/thorchain/quote/swap").map((r) => r.host)).toEqual([QUOTE, "https://quote2.invalid"]);
  });

  it("a node that redirects (to a query string or anywhere) is not trusted: skipped, refused when it is the only one", async () => {
    const redirected = (url: string, flag: boolean) => () => {
      const res = new Response(JSON.stringify(lastblockAt(LIVE_HEIGHT)), {status: 200});
      Object.defineProperty(res, "url", {value: url});
      Object.defineProperty(res, "redirected", {value: flag});
      return res;
    };
    nodes[LIQUIFY] = node({down: true});
    nodes[IBS] = node({down: true});
    for (const answer of [
      redirected(`${CONFIRM}/thorchain/lastblock?height=1`, true),
      redirected(`${CONFIRM}/thorchain/lastblock?height=1`, false), // a runtime that does not set `redirected`
      redirected("https://elsewhere.invalid/thorchain/lastblock", false),
      () => new Response(null, {status: 302, headers: {location: "/thorchain/lastblock?height=1"}}),
    ]) {
      nodes[CONFIRM]!.answer = {lastblock: answer};
      let r = await quote({confirmNodeUrl: CONFIRM});
      expect(r.q).toBeNull();
      expect(r.reasons).toEqual(["thorchain: no second node answered to confirm the inbound vault (configure confirmNodeUrl)"]);
      nodes[CONFIRM2] = node();
      r = await quote();
      expect(r.q).not.toBeNull();
      delete nodes[CONFIRM2];
    }
  });

  it("an answer in another shape is not trusted: skipped, refused when it is the only one", async () => {
    nodes[LIQUIFY] = node({down: true});
    nodes[IBS] = node({down: true});
    const json = (body: unknown) => () => new Response(JSON.stringify(body), {status: 200});
    const shapes: Partial<Record<Path, () => Response>>[] = [
      {lastblock: json({})},
      {lastblock: json([])},
      {lastblock: json([{chain: "ETH", thorchain: "tip"}])},
      {lastblock: () => new Response("<html>", {status: 200})},
      {inboundAddresses: json({chain: "ETH"})},
      {asgardVaults: json({vaults: []})},
      {asgardVaults: json([{status: "ActiveVault", pub_key: liveVault(B_TAIL).pub_key}])}, // no addresses
      {asgardVaults: json(asgardWith(B_TAIL, {type: "YggdrasilVault"}))},
      {asgardVaults: json(asgardWith(B_TAIL, {pub_key: 42}))},
      {mimir: json([])},
      {mimir: json({})},
      {mimir: json({...LIVE_MIMIR, [`COMPROMISEDVAULT-${liveVault(B_TAIL).pub_key.toUpperCase()}`]: "yes"})},
    ];
    for (const answer of shapes) {
      nodes[CONFIRM]!.answer = answer;
      const r = await quote({confirmNodeUrl: CONFIRM});
      expect(r.q, JSON.stringify(Object.keys(answer))).toBeNull();
      expect(r.reasons).toEqual(["thorchain: no second node answered to confirm the inbound vault (configure confirmNodeUrl)"]);
    }
    // …and with a sound node after it, that node confirms.
    nodes[CONFIRM]!.answer = {asgardVaults: json({vaults: []})};
    nodes[CONFIRM2] = node();
    expect((await quote()).q).not.toBeNull();
  });

  it("a node that does not answer within confirmTimeoutMs is skipped for the next one", async () => {
    nodes[CONFIRM]!.hang = true;
    nodes[CONFIRM2] = node();
    const started = Date.now();
    const {q, reasons} = await quote({confirmTimeoutMs: 150});
    expect(reasons).toEqual([]);
    expect(q).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("when one read of a node fails, its sibling still running is aborted (nothing left in flight)", async () => {
    nodes[CONFIRM]!.answer = {lastblock: () => new Response("down", {status: 503})};
    nodes[CONFIRM2] = node();
    const stub = globalThis.fetch;
    const hanging: AbortSignal[] = [];
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
      if (String(input) === `${CONFIRM}${THORNODE_CONFIRM_PATHS.inboundAddresses}`) {
        hanging.push(init!.signal!);
        return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
      return stub(input, init);
    });
    const {q, reasons} = await quote();
    expect(reasons).toEqual([]);
    expect(q).not.toBeNull();
    expect(hanging).toHaveLength(1);
    expect(hanging[0]!.aborted).toBe(true);
  });

  it("confirming nodes share the vault check's 8 s budget: hanging nodes are cut off at the deadline, the timers are cleared", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
    for (const h of [CONFIRM, CONFIRM2, LIQUIFY, IBS, "https://confirm3.invalid"]) nodes[h] = node({hang: true});
    const reasons: string[] = [];
    const pending = thorchainProvider({nodeUrl: QUOTE, confirmNodeUrl: [CONFIRM, CONFIRM2, "https://confirm3.invalid"]}).getQuote(params({onRefusal: (r) => reasons.push(r)}));
    await vi.advanceTimersByTimeAsync(8_100);
    await expect(pending).resolves.toBeNull();
    expect(reasons).toEqual(["thorchain: no second node answered to confirm the inbound vault (configure confirmNodeUrl)"]);
    // 2.5 s + 2.5 s + 2.5 s + what is left of 8 s: the fifth node is never asked.
    const asked = new Set(reads.filter((r) => r.host !== QUOTE).map((r) => r.host));
    expect(asked.size).toBe(4);
    expect(asked.has(IBS)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the caller aborting while a node is confirming rejects the quote and leaves no timer behind", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
    nodes[CONFIRM]!.hang = true;
    const ctrl = new AbortController();
    const pending = provider().getQuote(params(), ctrl.signal);
    const settled = pending.then(() => "resolved", (e: unknown) => (e instanceof Error ? e.name : String(e)));
    await vi.advanceTimersByTimeAsync(100);
    ctrl.abort();
    await expect(settled).resolves.toBe("AbortError");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("options", () => {
  it("confirmMaxLagBlocks and confirmTimeoutMs are validated", () => {
    expect(() => thorchainProvider({confirmMaxLagBlocks: -1})).toThrow("thorchain: confirmMaxLagBlocks must be an integer between 0 and 100000");
    expect(() => thorchainProvider({confirmMaxLagBlocks: 1.5})).toThrow(/confirmMaxLagBlocks/);
    expect(() => thorchainProvider({confirmMaxLagBlocks: 100_001})).toThrow(/confirmMaxLagBlocks/);
    expect(() => thorchainProvider({confirmTimeoutMs: 99})).toThrow("thorchain: confirmTimeoutMs must be an integer between 100 and 8000");
    expect(() => thorchainProvider({confirmTimeoutMs: 8_001})).toThrow(/confirmTimeoutMs/);
    expect(() => thorchainProvider({confirmTimeoutMs: Number.NaN})).toThrow(/confirmTimeoutMs/);
    expect(() => thorchainProvider({confirmMaxLagBlocks: 0, confirmTimeoutMs: 100})).not.toThrow();
  });

  it("THORNODE_CONFIRM_PATHS is the fixed list a proxy may pass", () => {
    expect(Object.values(THORNODE_CONFIRM_PATHS)).toEqual(["/thorchain/lastblock", "/thorchain/inbound_addresses", "/thorchain/vaults/asgard", "/thorchain/mimir"]);
    expect(Object.isFrozen(THORNODE_CONFIRM_PATHS)).toBe(true);
  });
});

describe("readers on the answers recorded from three operators (2026-11-12)", () => {
  it("lastblock: THORChain's own height from each node; nothing else is a height", async () => {
    const {lastblockHeight} = await import("../src/confirm.js");
    const recorded = {
      liquify: (await import("../fixtures/thornode/2026-11-12/liquify/lastblock.json")).default,
      thorwallet: (await import("../fixtures/thornode/2026-11-12/thorwallet/lastblock.json")).default,
      ibs: (await import("../fixtures/thornode/2026-11-12/ibs/lastblock.json")).default,
    };
    expect(lastblockHeight(recorded.liquify)).toBe(28643286);
    expect(lastblockHeight(recorded.thorwallet)).toBe(28643287);
    expect(lastblockHeight(recorded.ibs)).toBe(28643287);
    expect(lastblockHeight(recorded.liquify.map((e) => ({...e, thorchain: String(e.thorchain)})))).toBe(28643286); // proto3 int64 as a string
    for (const bad of [null, {}, [], [{chain: "BTC"}], [{thorchain: -1}], [{thorchain: 1.5}], [{thorchain: "28643286?"}], [null]]) expect(lastblockHeight(bad)).toBeNull();
  });

  it("asgard: the six recorded ActiveVaults with their per-chain addresses; the inbound nodes name one of them", async () => {
    const {asgardVaults} = await import("../src/confirm.js");
    const vaults = asgardVaults(LIVE_ASGARD)!;
    expect(vaults).toHaveLength(6);
    expect(vaults.every((v) => v.status === "ActiveVault" && v.addresses.length === 14)).toBe(true);
    for (const n of ["liquify", "thorwallet", "ibs"]) {
      const inbound = (await import(`../fixtures/thornode/2026-11-12/${n}/inbound_addresses.json`)).default as {chain: string; address: string}[];
      for (const chain of ["ETH", "BASE", "BSC", "AVAX", "TRON", "BTC"]) {
        const address = inbound.find((e) => e.chain === chain)!.address;
        expect(vaults.filter((v) => v.addresses.some((a) => a.chain === chain && a.address === address)), `${n} ${chain}`).toHaveLength(1);
      }
    }
  });

  it("mimir: the recorded map flags none of the six active vaults, and flags the vault its CompromisedVault key names", async () => {
    const {mimirFlags} = await import("../src/confirm.js");
    const flags = mimirFlags(LIVE_MIMIR)!;
    for (const v of LIVE_ASGARD) expect(flags(v.pub_key)).toBeNull(); // SolvencyHaltVault keys present at 0 are not flags
    const compromised = Object.keys(LIVE_MIMIR).find((k) => k.startsWith("COMPROMISEDVAULT-") && LIVE_MIMIR[k]! > 0)!;
    expect(flags(compromised.slice("COMPROMISEDVAULT-".length).toLowerCase())).toBe("compromised");
  });
});

describe("the vault check's own budget: it starts when the quote is in hand", () => {
  const HANG = "https://hang.invalid";
  const BUDGET_GONE = "thorchain: the 8 s confirmation budget ran out before a second node could be asked to confirm the inbound vault — retry";

  it("a hanging first nodeUrl host and a sound second one: the quote is confirmed (0.3.5 quoted here too)", async () => {
    fakeClock();
    nodes[HANG] = node({hang: true});
    const reasons: string[] = [];
    const started = Date.now();
    const pending = provider({nodeUrl: [HANG, QUOTE]}).getQuote(params({onRefusal: (r) => reasons.push(r)}));
    await vi.advanceTimersByTimeAsync(8_500);
    const q = await pending;
    expect(reasons).toEqual([]);
    expect(q?.providerData?.inboundAddress).toBe(VAULT_B);
    // The first host used its whole 8 s; the check still had its own 8 s and asked the confirming node.
    expect(reads.filter((r) => r.path === "/thorchain/quote/swap").map((r) => r.host)).toEqual([HANG, QUOTE]);
    expect(readsOn(CONFIRM)).toContain(THORNODE_CONFIRM_PATHS.asgardVaults);
    expect(Date.now() - started).toBeGreaterThanOrEqual(8_000);
    // Nothing outlives the 8 s read bounds of the requests already answered.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("before broadcast too: a hanging first host's snapshot does not use up the re-check's budget", async () => {
    fakeClock();
    nodes[HANG] = node({hang: true});
    const p = provider({nodeUrl: [HANG, QUOTE]});
    const quoting = p.getQuote(params());
    await vi.advanceTimersByTimeAsync(8_500);
    const q = (await quoting)!;
    const tx = await p.buildDeposit(q);
    reads = [];
    const checking = p.preflightDeposit!(q, tx).then(() => "ok", (e: unknown) => String(e));
    await vi.advanceTimersByTimeAsync(8_500);
    await expect(checking).resolves.toBe("ok");
    expect(readsOn(HANG)).toEqual(expect.arrayContaining([THORNODE_CONFIRM_PATHS.inboundAddresses, THORNODE_CONFIRM_PATHS.lastblock]));
    expect(readsOn(CONFIRM)).toContain(THORNODE_CONFIRM_PATHS.asgardVaults);
  });

  it("the quoting node's own snapshot using the budget up: refused with a new text, no confirming node asked", async () => {
    fakeClock();
    nodes[QUOTE]!.delay = {inboundAddresses: 7_950};
    const reasons: string[] = [];
    const pending = provider().getQuote(params({onRefusal: (r) => reasons.push(r)}));
    await vi.advanceTimersByTimeAsync(8_100);
    await expect(pending).resolves.toBeNull();
    expect(reasons).toEqual([BUDGET_GONE]);
    for (const h of [CONFIRM, CONFIRM2, LIQUIFY, IBS]) expect(readsOn(h)).toEqual([]);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("150 ms left is enough to ask (and here hear) a confirming node; 50 ms is not", async () => {
    fakeClock();
    nodes[QUOTE]!.delay = {inboundAddresses: 7_850};
    const reasons: string[] = [];
    const pending = provider().getQuote(params({onRefusal: (r) => reasons.push(r)}));
    await vi.advanceTimersByTimeAsync(8_100);
    expect((await pending)?.providerData?.inboundAddress).toBe(VAULT_B);
    expect(reasons).toEqual([]);
    expect(readsOn(CONFIRM).length).toBeGreaterThan(0);
  });

  it("a node asked with the last of the budget that does not answer keeps the existing text (it was asked)", async () => {
    fakeClock();
    nodes[QUOTE]!.delay = {inboundAddresses: 7_000};
    for (const h of [CONFIRM, CONFIRM2, LIQUIFY, IBS]) nodes[h] = node({hang: true});
    const reasons: string[] = [];
    const pending = provider().getQuote(params({onRefusal: (r) => reasons.push(r)}));
    await vi.advanceTimersByTimeAsync(8_100);
    await expect(pending).resolves.toBeNull();
    expect(reasons).toEqual(["thorchain: no second node answered to confirm the inbound vault (configure confirmNodeUrl)"]);
    expect(readsOn(CONFIRM).length).toBeGreaterThan(0);
    expect(readsOn(CONFIRM2)).toEqual([]); // the 1 s left went to the first node
  });

  it("before broadcast: the refreshing node's snapshot using the budget up → the new text", async () => {
    const p = provider();
    const q = (await p.getQuote(params()))!;
    const tx = await p.buildDeposit(q);
    fakeClock();
    nodes[QUOTE]!.delay = {inboundAddresses: 7_950};
    reads = [];
    const checking = p.preflightDeposit!(q, tx).then(() => "ok", (e: unknown) => (e instanceof Error ? e.message : String(e)));
    await vi.advanceTimersByTimeAsync(8_100);
    await expect(checking).resolves.toBe(BUDGET_GONE);
    expect(readsOn(CONFIRM)).toEqual([]);
  });
});

describe("the quoting node's lastblock read has its own 8 s bound, apart from confirmTimeoutMs", () => {
  const HEIGHT_GONE = "thorchain: THORChain height (/thorchain/lastblock) unavailable from every node that answered the inbound addresses";
  const PREFLIGHT_HEIGHT_GONE = "thorchain: cannot read THORChain height (/thorchain/lastblock) before broadcast from any node that answered the inbound addresses";

  it("confirmTimeoutMs: 100 does not cut the quoting node's lastblock: an answer after 500 ms still quotes and re-checks", async () => {
    fakeClock();
    nodes[QUOTE]!.delay = {lastblock: 500};
    const p = provider({confirmTimeoutMs: 100});
    const reasons: string[] = [];
    const quoting = p.getQuote(params({onRefusal: (r) => reasons.push(r)}));
    await vi.advanceTimersByTimeAsync(600);
    const q = await quoting;
    expect(reasons).toEqual([]);
    expect(q).not.toBeNull();
    const tx = await p.buildDeposit(q!);
    const checking = p.preflightDeposit!(q!, tx).then(() => "ok", (e: unknown) => String(e));
    await vi.advanceTimersByTimeAsync(600);
    await expect(checking).resolves.toBe("ok");
  });

  it("…while a confirming node still gets only confirmTimeoutMs", async () => {
    fakeClock();
    nodes[CONFIRM]!.delay = {lastblock: 500};
    nodes[CONFIRM2] = node();
    const reasons: string[] = [];
    const pending = provider({confirmTimeoutMs: 100}).getQuote(params({onRefusal: (r) => reasons.push(r)}));
    await vi.advanceTimersByTimeAsync(600);
    expect(await pending).not.toBeNull();
    expect(readsOn(CONFIRM2)).toContain(THORNODE_CONFIRM_PATHS.lastblock); // CONFIRM was cut off at 100 ms
  });

  it("only the quoting node's lastblock failing names lastblock, not 'inbound addresses unavailable'", async () => {
    fakeClock();
    const failures: [string, Partial<FakeNode>][] = [
      ["503", {answer: {lastblock: () => new Response("down", {status: 503})}}],
      ["404 (a proxy that does not pass the path)", {answer: {lastblock: () => new Response("nope", {status: 404})}}],
      ["another shape", {answer: {lastblock: () => new Response(JSON.stringify({height: 1}), {status: 200})}}],
      ["no answer within its 8 s", {delay: {lastblock: 9_000}}],
    ];
    for (const [what, failure] of failures) {
      nodes[QUOTE] = node({inbound: inboundWith(VAULT_B), quote: quoteNaming(VAULT_B), ...failure});
      const reasons: string[] = [];
      const pending = provider().getQuote(params({onRefusal: (r) => reasons.push(r)}));
      await vi.advanceTimersByTimeAsync(8_100);
      expect(await pending, what).toBeNull();
      expect(reasons, what).toEqual([HEIGHT_GONE]);
    }
  });

  it("the inbound snapshot failing keeps the existing text; a mix names lastblock only when a node answered the snapshot", async () => {
    nodes[QUOTE]!.answer = {inboundAddresses: () => new Response("down", {status: 503})};
    let r = await quote();
    expect(r.reasons).toEqual(["thorchain: inbound addresses unavailable from every node"]);
    // Both fail on the snapshot read, one of them only on its height → the height is what no node could give.
    nodes["https://quote2.invalid"] = node({inbound: inboundWith(VAULT_B), quote: quoteNaming(VAULT_B), answer: {lastblock: () => new Response("down", {status: 503})}});
    r = await quote({nodeUrl: [QUOTE, "https://quote2.invalid"]});
    expect(r.reasons).toEqual([HEIGHT_GONE]);
    // A host down before its snapshot does not change that; a failing lastblock does not hide a sound host after it.
    nodes["https://quote3.invalid"] = node({down: true});
    r = await quote({nodeUrl: ["https://quote2.invalid", "https://quote3.invalid"]});
    expect(r.reasons).toEqual([HEIGHT_GONE]);
    nodes["https://quote3.invalid"] = node({inbound: inboundWith(VAULT_B), quote: quoteNaming(VAULT_B)});
    r = await quote({nodeUrl: ["https://quote2.invalid", "https://quote3.invalid"]});
    expect(r.reasons).toEqual([]);
    expect(r.q).not.toBeNull();
  });

  it("before broadcast: lastblock alone failing → its own text; the snapshot failing → the existing one", async () => {
    const p = provider();
    const q = (await p.getQuote(params()))!;
    const tx = await p.buildDeposit(q);
    nodes[QUOTE]!.answer = {lastblock: () => new Response("down", {status: 503})};
    await expect(p.preflightDeposit!(q, tx)).rejects.toThrow(PREFLIGHT_HEIGHT_GONE);
    nodes[QUOTE]!.answer = {inboundAddresses: () => new Response("down", {status: 503})};
    await expect(p.preflightDeposit!(q, tx)).rejects.toThrow("thorchain: cannot refresh inbound addresses before broadcast");
  });

  it("a failed snapshot read drops the height read still running; the caller aborting during the snapshot rejects at once", async () => {
    fakeClock();
    nodes[QUOTE]!.delay = {lastblock: 5_000};
    nodes[QUOTE]!.answer = {inboundAddresses: () => new Response("down", {status: 503})};
    const stub = globalThis.fetch;
    const heightReads: AbortSignal[] = [];
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
      if (String(input) === `${QUOTE}${THORNODE_CONFIRM_PATHS.lastblock}`) heightReads.push(init!.signal!);
      return stub(input, init);
    });
    const pending = provider().getQuote(params());
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toBeNull();
    expect(heightReads).toHaveLength(1);
    expect(heightReads[0]!.aborted).toBe(true);
    nodes[QUOTE] = node({inbound: inboundWith(VAULT_B), quote: quoteNaming(VAULT_B), delay: {lastblock: 5_000}});
    const ctrl = new AbortController();
    const settled = provider().getQuote(params(), ctrl.signal).then(() => "resolved", (e: unknown) => (e instanceof Error ? e.name : String(e)));
    await vi.advanceTimersByTimeAsync(100);
    ctrl.abort();
    await expect(settled).resolves.toBe("AbortError");
  });
});

describe("thorchainPins().verifyBuild: the provider's rule on the device", () => {
  const CONFIRM3 = "https://confirm3.invalid";
  /** A build of the provider's own quote (vault B, rotated away on the confirming nodes) and its request. */
  async function built(o: Partial<QuoteParams> = {}): Promise<{q: Quote; tx: UnsignedTx; p: QuoteParams}> {
    const p = params(o);
    const prov = provider({tronSource: true});
    const q = (await prov.getQuote(p))!;
    expect(q).not.toBeNull();
    return {q, tx: await prov.buildDeposit(q), p};
  }
  const pins = (o: Parameters<typeof thorchainPins>[0] = {}) => thorchainPins({nodeUrl: [CONFIRM, CONFIRM2], ...o});
  beforeEach(() => {
    nodes[CONFIRM2] = node();
  });

  it("a rotated vault that both nodes list as ActiveVault passes, on the fixed GET paths only", async () => {
    const {q, tx, p} = await built();
    reads = [];
    await expect(pins().verifyBuild(q, tx, p)).resolves.toBeNull();
    for (const h of [CONFIRM, CONFIRM2]) expect(readsOn(h).sort()).toEqual(Object.values(THORNODE_CONFIRM_PATHS).slice().sort());
    for (const r of reads) {
      expect(r.search).toBe("");
      expect(r.method).toBe("GET");
      expect(r.init && "cache" in r.init).toBe(false);
      expect(r.init?.redirect).toBe("error");
    }
  });

  it("an exact match needs only lastblock + inbound_addresses", async () => {
    const {q, tx, p} = await built();
    nodes[CONFIRM]!.inbound = nodes[CONFIRM2]!.inbound = inboundWith(VAULT_B);
    reads = [];
    await expect(pins().verifyBuild(q, tx, p)).resolves.toBeNull();
    expect(readsOn(CONFIRM).sort()).toEqual([THORNODE_CONFIRM_PATHS.inboundAddresses, THORNODE_CONFIRM_PATHS.lastblock].sort());
  });

  it("RetiringVault (or any status but ActiveVault) on either node → refused", async () => {
    const {q, tx, p} = await built();
    for (const status of ["RetiringVault", "InactiveVault"]) {
      for (const h of [CONFIRM, CONFIRM2]) {
        nodes[CONFIRM]!.asgard = nodes[CONFIRM2]!.asgard = LIVE_ASGARD;
        nodes[h]!.asgard = asgardWith(B_TAIL, {status});
        await expect(pins().verifyBuild(q, tx, p)).resolves.toBe(`a THORNode lists the inbound vault as ${status}, not ActiveVault`);
      }
    }
  });

  it("a vault the mimir flags compromised or insolvent → refused", async () => {
    const {q, tx, p} = await built();
    const pub = liveVault(B_TAIL).pub_key.toUpperCase();
    nodes[CONFIRM2]!.mimir = {...LIVE_MIMIR, [`COMPROMISEDVAULT-${pub}`]: 1};
    await expect(pins().verifyBuild(q, tx, p)).resolves.toBe("a THORNode's mimir flags the inbound vault as compromised");
    nodes[CONFIRM2]!.mimir = {...LIVE_MIMIR, [`SOLVENCYHALTVAULT-${pub}-ETH`]: 7};
    await expect(pins().verifyBuild(q, tx, p)).resolves.toBe("a THORNode's mimir flags the inbound vault as insolvent");
  });

  it("a node reporting another router → refused (existing text), on a rotated vault and on an exact match", async () => {
    const {q, tx, p} = await built();
    nodes[CONFIRM2]!.inbound = inboundWith(VAULT_A, TRON_A, {ETH: {router: ATTACKER_ROUTER}});
    await expect(pins().verifyBuild(q, tx, p)).resolves.toBe("a THORNode reports another router");
    nodes[CONFIRM2]!.inbound = inboundWith(VAULT_B, TRON_A, {ETH: {router: ATTACKER_ROUTER}});
    await expect(pins().verifyBuild(q, tx, p)).resolves.toBe("a THORNode reports another router");
    // A swapped router in the build itself is refused before any node is asked.
    reads = [];
    await expect(pins().verifyBuild(q, {...tx, to: ATTACKER_ROUTER}, p)).resolves.toBe(`router ${ATTACKER_ROUTER} is not pinned`);
    expect(reads).toEqual([]);
  });

  it("a vault no node lists, and halts on either chain → refused with the existing texts", async () => {
    const {q, tx, p} = await built();
    const swapped = encodeFunctionData({abi: ROUTER_ABI, functionName: "depositWithExpiry", args: [NOT_A_VAULT as `0x${string}`, NATIVE, 50_000_000_000_000_000n, q.providerData!.memo!, BigInt(q.providerData!.expiry!)]});
    await expect(pins().verifyBuild(q, {...tx, data: swapped}, p)).resolves.toBe(`a THORNode reports another inbound vault than ${NOT_A_VAULT}`);
    nodes[CONFIRM]!.inbound = inboundWith(VAULT_A, TRON_A, {ETH: {chain_trading_paused: true}});
    await expect(pins().verifyBuild(q, tx, p)).resolves.toBe("ETH is halted / paused");
    nodes[CONFIRM]!.inbound = inboundWith(VAULT_A, TRON_A, {BTC: {halted: true}});
    await expect(pins().verifyBuild(q, tx, p)).resolves.toBe("BTC is halted / paused");
  });

  it("node lag: a node more than 50 blocks behind the freshest is skipped; with too few left → refused by name", async () => {
    const {q, tx, p} = await built();
    const LAG = "two THORNodes within 50 blocks of the highest THORChain height they report could not confirm the inbound vault (behind or unreachable)";
    nodes[CONFIRM2]!.height = LIVE_HEIGHT - 51;
    await expect(pins().verifyBuild(q, tx, p)).resolves.toBe(LAG);
    // Every node but the freshest behind.
    nodes[CONFIRM3] = node({height: LIVE_HEIGHT + 60});
    nodes[CONFIRM2]!.height = LIVE_HEIGHT;
    await expect(pins({nodeUrl: [CONFIRM, CONFIRM2, CONFIRM3]}).verifyBuild(q, tx, p)).resolves.toBe(LAG);
    // A third fresh node makes two; 50 behind is still within; the limit is configurable.
    nodes[CONFIRM3]!.height = LIVE_HEIGHT;
    nodes[CONFIRM2]!.height = LIVE_HEIGHT - 51;
    await expect(pins({nodeUrl: [CONFIRM, CONFIRM2, CONFIRM3]}).verifyBuild(q, tx, p)).resolves.toBeNull();
    nodes[CONFIRM2]!.height = LIVE_HEIGHT - 50;
    await expect(pins().verifyBuild(q, tx, p)).resolves.toBeNull();
    nodes[CONFIRM2]!.height = LIVE_HEIGHT - 28;
    await expect(pins({confirmMaxLagBlocks: 10}).verifyBuild(q, tx, p)).resolves.toBe(LAG.replace("50 blocks", "10 blocks"));
    // A lagging node's stale view is not what decides: its RetiringVault is skipped with it.
    nodes[CONFIRM2] = node({height: LIVE_HEIGHT - 80, asgard: asgardWith(B_TAIL, {status: "RetiringVault"})});
    await expect(pins({nodeUrl: [CONFIRM, CONFIRM2, CONFIRM3]}).verifyBuild(q, tx, p)).resolves.toBeNull();
  });

  it("per-node timeout, redirects and other shapes skip the node; two must still confirm", async () => {
    const {q, tx, p} = await built();
    const redirected = () => {
      const res = new Response(JSON.stringify(lastblockAt(LIVE_HEIGHT)), {status: 200});
      Object.defineProperty(res, "url", {value: `${CONFIRM2}/thorchain/lastblock?height=1`}); // followed by the runtime
      return res;
    };
    const cases: [string, Partial<FakeNode>][] = [
      ["hangs", {hang: true}],
      ["redirects", {answer: {lastblock: redirected}}],
      ["answers another shape", {answer: {asgardVaults: () => new Response(JSON.stringify({vaults: []}), {status: 200})}}],
      ["is down", {down: true}],
    ];
    for (const [what, broken] of cases) {
      nodes[CONFIRM2] = node(broken);
      const started = Date.now();
      await expect(pins({confirmTimeoutMs: 150}).verifyBuild(q, tx, p), what).resolves.toBe("two THORNodes could not confirm the inbound vault");
      expect(Date.now() - started, what).toBeLessThan(2_000);
      nodes[CONFIRM3] = node();
      await expect(pins({nodeUrl: [CONFIRM, CONFIRM2, CONFIRM3], confirmTimeoutMs: 150}).verifyBuild(q, tx, p), what).resolves.toBeNull();
      delete nodes[CONFIRM3];
    }
  });

  it("in nodeUrl order: a refusing node refuses before two later ones confirm; two confirming nodes pass before a refusing third", async () => {
    const {q, tx, p} = await built();
    nodes[CONFIRM3] = node({asgard: asgardWith(B_TAIL, {status: "RetiringVault"})});
    await expect(pins({nodeUrl: [CONFIRM3, CONFIRM, CONFIRM2]}).verifyBuild(q, tx, p)).resolves.toBe("a THORNode lists the inbound vault as RetiringVault, not ActiveVault");
    await expect(pins({nodeUrl: [CONFIRM, CONFIRM2, CONFIRM3]}).verifyBuild(q, tx, p)).resolves.toBeNull();
  });

  it("Tron: a rotated vault passes; a case-changed address is another address", async () => {
    const tronQuote = {expected_amount_out: "2061155", inbound_address: TRON_B, memo: `=:e:${ETH_DEST}:2014026`, expiry: Math.floor(Date.now() / 1000) + 3600};
    nodes[QUOTE] = node({inbound: inboundWith(VAULT_B, TRON_B), quote: tronQuote});
    const {q, tx, p} = await built({sourceChain: "tron:728126428", sourceToken: "USDT", destChain: "eip155:1", destToken: NATIVE, amountIn: "50000000", destAddress: ETH_DEST});
    expect(tx.to).toBe(TRON_B);
    await expect(pins().verifyBuild(q, tx, p)).resolves.toBeNull();
    await expect(pins().verifyBuild(q, {...tx, to: TRON_B.toLowerCase()}, p)).resolves.toBe(`a THORNode reports another inbound vault than ${TRON_B.toLowerCase()}`);
  });

  it("confirmMaxLagBlocks and confirmTimeoutMs are validated as on the provider", () => {
    expect(() => thorchainPins({confirmMaxLagBlocks: -1})).toThrow("thorchain: confirmMaxLagBlocks must be an integer between 0 and 100000");
    expect(() => thorchainPins({confirmTimeoutMs: 99})).toThrow("thorchain: confirmTimeoutMs must be an integer between 100 and 8000");
    expect(() => thorchainPins({confirmTimeoutMs: 8_001})).toThrow(/confirmTimeoutMs/);
    expect(() => thorchainPins({confirmMaxLagBlocks: 0, confirmTimeoutMs: 100})).not.toThrow();
  });
});
