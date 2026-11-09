import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import type {RelayDepositTx, RelayProtocolData, RelayRequest} from "../src/verify.js";

const dir = fileURLToPath(new URL("../fixtures/quotes/", import.meta.url));

export interface RawOrder {
  version: string; solverChainId: string; solver: string; salt: string;
  inputs: {payment: {chainId: string; currency: string; amount: string; weight: string}; refunds: {chainId: string; recipient: string; currency: string; minimumAmount: string; deadline: number; extraData: string}[]}[];
  output: {chainId: string; payments: {recipient: string; currency: string; minimumAmount: string; expectedAmount: string}[]; deadline: number; calls: string[]; extraData: string};
  fees: unknown[];
}
export interface RawProtocol extends RelayProtocolData {
  orderId: string; hubType: string; orderData: RawOrder; orderSignature: string;
  paymentDetails: {chainId: string; depository: string; currency: string; amount: string};
}
export interface RawTx {from?: string; to: string; data: string; value: string; chainId: number; gas?: string}
export interface QuoteFixture {
  name: string;
  request: {sourceChain: string; destChain: string; sourceToken: string; destToken: string; amount: string; depositor: string; recipient: string; nowMs: number};
  response: {
    steps: {id: string; requestId: string; items: {data: RawTx}[]}[];
    fees: unknown; details: {timeEstimate: number; slippageTolerance: string | null};
    protocol: {v2: RawProtocol};
  };
}

export function loadQuote(name: string): QuoteFixture {
  return {name, ...(JSON.parse(readFileSync(`${dir}${name}.json`, "utf8")) as Omit<QuoteFixture, "name">)};
}
export const ALL = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => f.slice(0, -5));
/** Routes whose source leg is a swap on the source chain: the "deposit" calls a router, not the depository. */
export const ORIGIN_SWAP = ["arb-arb_base-eth", "ely-hype_arb-usdc", "mantle-mnt_base-eth", "pol-pol_base-eth"];
export const DIRECT = ALL.filter((n) => !ORIGIN_SWAP.includes(n));

export const requestOf = (f: QuoteFixture, over: Partial<RelayRequest> = {}): RelayRequest => ({...f.request, amount: BigInt(f.request.amount), ...over});
export const protoOf = (f: QuoteFixture): RawProtocol => f.response.protocol.v2;
export const depositOf = (f: QuoteFixture): RawTx & RelayDepositTx => f.response.steps.find((s) => s.id === "deposit")!.items[0]!.data;

/** A fetch that answers `/quote/v2` with a fixture's response (after `edit`) and records what was asked. */
export function quoteFetch(f: QuoteFixture, seen: {url: string; init?: RequestInit}[] = []): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({url: String(url), ...(init ? {init} : {})});
    return new Response(JSON.stringify(f.response), {status: 200, headers: {"content-type": "application/json"}});
  }) as typeof fetch;
}
