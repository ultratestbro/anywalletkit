// Scan 2026-10-27 (modules), F15: the router (call target and spender) and the inbound vault came from one THORNode
// host, and the quote was "confirmed" against that same host's inbound snapshot. Now the router must be a pinned
// THORChain router, and a second node must report the same vault (and router) at quote time and before broadcast.
// A fake pair of nodes, no network.
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {encodeFunctionData} from "viem";
import {THORCHAIN_ROUTERS, thorchainPins, thorchainProvider} from "../src/provider.js";
import type {Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";

const PRIMARY = "https://primary.invalid";
const SECONDARY = "https://secondary.invalid";
const VAULT = "0x1111111111111111111111111111111111111111";
const ATTACKER_VAULT = "0x9999999999999999999999999999999999999999";
const ROUTER = "0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146"; // THORCHAIN_ROUTERS["eip155:1"], verified live 2026-10-28
const ATTACKER_ROUTER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BTC_DEST = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

type Node = {vault: string; router: string; up: boolean};
let nodes: Record<string, Node>;
let quoteRouter: string;
const inbound = (n: Node) => [{chain: "ETH", address: n.vault, router: n.router, halted: false}, {chain: "BTC", address: BTC_DEST, halted: false}];
beforeEach(() => {
  nodes = {[PRIMARY]: {vault: VAULT, router: ROUTER, up: true}, [SECONDARY]: {vault: VAULT, router: ROUTER, up: true}};
  quoteRouter = ROUTER;
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    const host = Object.keys(nodes).find((h) => url.startsWith(h));
    if (!host) return new Response("nope", {status: 404});
    const n = nodes[host]!;
    if (!n.up) throw new TypeError("fetch failed");
    if (url.includes("/inbound_addresses")) return new Response(JSON.stringify(inbound(n)), {status: 200});
    if (url.includes("/quote/swap")) {
      return new Response(JSON.stringify({expected_amount_out: "100000", inbound_address: n.vault, router: quoteRouter, memo: `=:b:${BTC_DEST}:95000`, expiry: Math.floor(Date.now() / 1000) + 3600}), {status: 200});
    }
    return new Response("nope", {status: 404});
  });
});
afterEach(() => vi.unstubAllGlobals());

const params = (onRefusal?: (r: string) => void): QuoteParams => ({
  sourceChain: "eip155:1", sourceToken: "ETH", destChain: "bitcoin:mainnet", destToken: "0x0000000000000000000000000000000000000000",
  amountIn: "50000000000000000", destAddress: BTC_DEST, ...(onRefusal ? {onRefusal} : {}),
});
const provider = () => thorchainProvider({nodeUrl: [PRIMARY, SECONDARY]});

describe("THORChain: router pinned, vault confirmed by a second node (scan 2026-10-27 modules, F15)", () => {
  it("a quote and matching inbound snapshots naming an attacker router are refused — even when both nodes agree", async () => {
    nodes[PRIMARY]!.router = nodes[SECONDARY]!.router = quoteRouter = ATTACKER_ROUTER;
    const reasons: string[] = [];
    await expect(provider().getQuote(params((r) => reasons.push(r)))).resolves.toBeNull();
    expect(reasons).toEqual([expect.stringMatching(/router 0xaaaa.* is not a THORChain router this module trusts/)]);
  });

  it("a vault the second node does not report is refused at quote time", async () => {
    nodes[PRIMARY]!.vault = ATTACKER_VAULT;
    const reasons: string[] = [];
    await expect(provider().getQuote(params((r) => reasons.push(r)))).resolves.toBeNull();
    expect(reasons).toEqual(["thorchain: a second node reports another inbound vault — refused until they agree"]);
  });

  it("…and before broadcast: the vault diverging after the quote is refused, as is a silent second node", async () => {
    const p = provider();
    const quote = (await p.getQuote(params()))!;
    expect(quote).not.toBeNull();
    const tx = await p.buildDeposit(quote);
    nodes[SECONDARY]!.vault = ATTACKER_VAULT;
    await expect(p.preflightDeposit!(quote, tx)).rejects.toThrow(/a second node reports another inbound vault/);
    nodes[SECONDARY]!.vault = VAULT;
    nodes[SECONDARY]!.up = false;
    await expect(p.preflightDeposit!(quote, tx)).rejects.toThrow(/no second node answered/);
    nodes[SECONDARY]!.up = true;
    await expect(p.preflightDeposit!(quote, tx)).resolves.toBeUndefined();
  });

  it("one configured node is one source: quotes are refused unless confirmNodeUrl names another", async () => {
    const reasons: string[] = [];
    await expect(thorchainProvider({nodeUrl: PRIMARY}).getQuote(params((r) => reasons.push(r)))).resolves.toBeNull();
    expect(reasons).toEqual([expect.stringMatching(/no second node answered/)]);
    await expect(thorchainProvider({nodeUrl: PRIMARY, confirmNodeUrl: SECONDARY}).getQuote(params())).resolves.not.toBeNull();
  });

  it("trustedRouters extends the pins (a migration before a release); http nodes are refused", async () => {
    nodes[PRIMARY]!.router = nodes[SECONDARY]!.router = quoteRouter = ATTACKER_ROUTER;
    await expect(thorchainProvider({nodeUrl: [PRIMARY, SECONDARY], trustedRouters: {"eip155:1": [ATTACKER_ROUTER]}}).getQuote(params())).resolves.not.toBeNull();
    expect(() => thorchainProvider({nodeUrl: "http://thor.invalid"})).toThrow(/must use https/);
    expect(() => thorchainProvider({nodeUrl: [PRIMARY], confirmNodeUrl: "http://other.invalid"})).toThrow(/must use https/);
  });
});

describe("thorchainPins: a remote THORChain build is checked on the client", () => {
  const ROUTER_ABI = [{type: "function", name: "depositWithExpiry", stateMutability: "payable", inputs: [{name: "vault", type: "address"}, {name: "asset", type: "address"}, {name: "amount", type: "uint256"}, {name: "memo", type: "string"}, {name: "expiry", type: "uint256"}], outputs: []}] as const;
  const build = (o: {vault?: string; amount?: bigint; memo?: string; to?: string} = {}): UnsignedTx => ({
    chain: "eip155:1", to: o.to ?? ROUTER, value: "50000000000000000", chainId: 1,
    data: encodeFunctionData({abi: ROUTER_ABI, functionName: "depositWithExpiry", args: [(o.vault ?? VAULT) as `0x${string}`, "0x0000000000000000000000000000000000000000", o.amount ?? 50_000_000_000_000_000n, o.memo ?? `=:BTC.BTC:${BTC_DEST}:95000`, 9_999_999_999n]}),
  });
  const quote = {sourceAmount: "50000000000000000", minDestAmount: "95000"} as Quote;
  const pinsFor = () => thorchainPins({nodeUrl: [PRIMARY, SECONDARY]});

  it("pins the routers and passes an honest build both nodes confirm", async () => {
    const pins = pinsFor();
    expect(THORCHAIN_ROUTERS["eip155:1"]).toEqual([ROUTER]);
    expect(pins.callTargets("eip155:1")).toEqual([ROUTER]);
    expect(pins.spenders("eip155:8453")).toEqual(THORCHAIN_ROUTERS["eip155:8453"]);
    expect(pins.callTargets("eip155:10")).toEqual([]);
    await expect(pins.verifyBuild(quote, build(), params())).resolves.toBeNull();
  });

  it("refuses an attacker vault, another amount, a memo paying someone else, an unpinned router, or a single answering node", async () => {
    const pins = pinsFor();
    await expect(pins.verifyBuild(quote, build({vault: ATTACKER_VAULT}), params())).resolves.toMatch(/another inbound vault/);
    await expect(pins.verifyBuild(quote, build({amount: 1n}), params())).resolves.toMatch(/moves 1, not the/);
    await expect(pins.verifyBuild(quote, build({memo: "=:BTC.BTC:bc1qattacker0000000000000000000000000000000:95000"}), params())).resolves.toMatch(/memo does not pay/);
    await expect(pins.verifyBuild(quote, build({to: ATTACKER_ROUTER}), params())).resolves.toMatch(/is not pinned/);
    nodes[SECONDARY]!.up = false;
    await expect(pins.verifyBuild(quote, build(), params())).resolves.toMatch(/two THORNodes could not confirm/);
    await expect(pins.verifyBuild(quote, build(), undefined)).resolves.toMatch(/request this quote answered is unknown/);
  });
});
