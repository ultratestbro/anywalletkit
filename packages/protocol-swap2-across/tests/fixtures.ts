import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {expect} from "vitest";
import {refusalOf, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import {decodeFunctionData, parseAbi, type Hex} from "viem";
import {ACROSS_DEPOSIT, acrossChain} from "../src/config.js";
import {encodeAcrossDeposit, type AcrossDepositArgs} from "../src/deposit.js";
import {AcrossRefusal, type AcrossRefusalCode} from "../src/refusal.js";
import {acrossIntentId, type AcrossDepositTx, type AcrossRequest} from "../src/verify.js";
import type {NormalizedAcrossQuote} from "../src/build.js";

/** Partial, where a key may also be given as undefined to drop it from the defaults. */
export type Loose<T> = {[K in keyof T]?: T[K] | undefined};
/** `base` with `over` applied; a key given as undefined is removed. */
export function merged<T extends object>(base: T, over: Loose<T>): T {
  const out = {...base, ...over} as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as T;
}

const dir = (sub: string) => fileURLToPath(new URL(`../fixtures/${sub}/`, import.meta.url));
export const readJson = <T>(sub: string, name: string): T => JSON.parse(readFileSync(dir(sub) + name, "utf8")) as T;

export const NOW_S = 1_794_700_000;
export const NOW_MS = NOW_S * 1000;
export const USER = "0x00000000000000000000000000000000000a11ce";
export const FRIEND = "0x00000000000000000000000000000000000b0b00";
export const OTHER = "0x1111111111111111111111111111111111111111";
export const RELAYER = "0xfd03abcadaf3f930fa4e37eb2f6ea3a44a41b7f0";
export const ZERO = "0x0000000000000000000000000000000000000000";

export const BASE = acrossChain("eip155:8453")!;
export const ARB = acrossChain("eip155:42161")!;
export const ETHEREUM = acrossChain("eip155:1")!;
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const ARB_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
export const ARB_USDT0 = "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9";
export const ETH_USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
export const WETH_OP = "0x4200000000000000000000000000000000000006";
export const ARB_WETH = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";

/** 25 USDC Base → Arbitrum for the user, judged at {@link NOW_MS}. */
export function usdcRequest(over: Loose<AcrossRequest> = {}): AcrossRequest {
  return merged<AcrossRequest>({
    sourceChain: "eip155:8453", destChain: "eip155:42161", sourceToken: BASE_USDC, destToken: ARB_USDC,
    amount: 25_000_000n, depositor: USER, recipient: USER, minAmountOut: 24_900_000n, nowMs: NOW_MS,
  }, over);
}

/** 0.01 ETH (native) Base → Arbitrum (native). */
export function ethRequest(over: Loose<AcrossRequest> = {}): AcrossRequest {
  return merged<AcrossRequest>({
    sourceChain: "eip155:8453", destChain: "eip155:42161", sourceToken: ZERO, destToken: ZERO,
    amount: 10_000_000_000_000_000n, depositor: USER, recipient: USER, nowMs: NOW_MS,
  }, over);
}

/** The numbers an Across quote would supply for {@link usdcRequest}: 9 033 of fees, two hours to fill, no exclusivity. */
export function usdcQuote(over: Loose<NormalizedAcrossQuote> = {}): NormalizedAcrossQuote {
  return merged<NormalizedAcrossQuote>({
    sourceChainId: 8453, destinationChainId: 42161, inputToken: BASE_USDC, outputToken: ARB_USDC,
    inputAmount: "25000000", outputAmount: "24990967", quoteTimestamp: NOW_S - 60, fillDeadline: NOW_S - 60 + 7200,
    exclusiveRelayer: ZERO, exclusivityParameter: 0, expectedFillTimeSec: 2,
    fees: {total: "9033", relayerCapital: "2500", destinationGas: "6533", lp: "0"},
  }, over);
}

/** The deposit arguments {@link usdcRequest} signs, with any field replaced. */
export function usdcArgs(over: Partial<AcrossDepositArgs> = {}): AcrossDepositArgs {
  return {
    depositor: USER, recipient: USER, inputToken: BASE_USDC, outputToken: ARB_USDC, inputAmount: 25_000_000n, outputAmount: 24_990_967n,
    destinationChainId: 42161n, exclusiveRelayer: ZERO, quoteTimestamp: NOW_S - 60, fillDeadline: NOW_S - 60 + 7200,
    exclusivityParameter: 0, message: "0x", ...over,
  };
}

/** The transaction for deposit arguments on the Base SpokePool, ERC-20 shaped unless overridden. */
export function txOf(args: AcrossDepositArgs, over: Partial<AcrossDepositTx> = {}): AcrossDepositTx {
  return {to: BASE.spokePool, data: encodeAcrossDeposit(args), value: "0", chainId: 8453, approvalAddress: BASE.spokePool, ...over};
}

/** The native-coin deposit for {@link ethRequest}. */
export function ethArgs(over: Partial<AcrossDepositArgs> = {}): AcrossDepositArgs {
  return usdcArgs({inputToken: WETH_OP, outputToken: ARB_WETH, inputAmount: 10_000_000_000_000_000n, outputAmount: 9_994_000_000_000_000n, ...over});
}
export function ethTxOf(args: AcrossDepositArgs, over: Partial<AcrossDepositTx> = {}): AcrossDepositTx {
  return {to: BASE.spokePool, data: encodeAcrossDeposit(args), value: args.inputAmount.toString(10), chainId: 8453, ...over};
}

/** `fn` throws an {@link AcrossRefusal} with this code (and this reason, or none). Returns its message. */
export function refused(fn: () => unknown, code: AcrossRefusalCode, reason?: Swap2RefusalReason): string {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err, `expected ${code}`).toBeInstanceOf(AcrossRefusal);
  expect((err as AcrossRefusal).code).toBe(code);
  expect((err as AcrossRefusal).message).toMatch(new RegExp(`^across: .+ \\[${code}\\]$`));
  expect(refusalOf(err)?.reason).toBe(reason);
  return (err as AcrossRefusal).message;
}

export interface CalldataFixture {
  name: string;
  note: string;
  request: string;
  serverTimeMs: number;
  tx: {chainId: number; to: string; data: string; value: string | null};
  inputAmount: string;
  expectedOutputAmount: string | null;
  minOutputAmount: string | null;
  quoteExpiryTimestamp: number | null;
}
export function apiQuote(name: string): CalldataFixture {
  const all = readJson<{quotes: CalldataFixture[]}>("calldata", "across-api-v4.json").quotes;
  const q = all.find((x) => x.name === name);
  if (!q) throw new Error(`no fixture ${name}`);
  return q;
}

export interface StatusFixture {
  note: string;
  source: {chainId: number; txHash: string; input: string; receipt: {transactionHash: string; blockNumber: string; status: string; from: string; to: string; logs: {address: string; topics: string[]; data: string; logIndex: string}[]}; block: {number: string; timestamp: string}};
  relayHash: string;
  acrossIndexerRelayHash?: string;
  dest: {chainId: number; spokePool: string; reads: {block: {number: string; timestamp: string}; fillStatus: string}[]};
}
export const statusFixture = (name: string): StatusFixture => readJson<StatusFixture>("status", `${name}.json`);

/**
 * A JSON-RPC `fetch` answering from a status fixture: the receipt and its block on the source chain (a block asked for
 * by number), the destination read `readIndex` (the latest block, and the fill status there).
 */
export function rpcFrom(f: StatusFixture, readIndex: number, calls: {url: string; method: string; params: unknown[]}[] = []): typeof fetch {
  const read = f.dest.reads[readIndex]!;
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const {id, method, params} = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]};
    calls.push({url: String(url), method, params});
    const result = method === "eth_getTransactionReceipt" ? f.source.receipt
      : method === "eth_getBlockByNumber" ? (params[0] === f.source.block.number ? f.source.block : read.block)
        : method === "eth_call" ? read.fillStatus
          : null;
    return new Response(JSON.stringify({jsonrpc: "2.0", id, result}));
  }) as typeof fetch;
}

/**
 * The intent id of a recorded deposit, from the calldata it was sent with (not from its event): `deposit` calldata with
 * Across's API marker taken off, or `depositV3`'s address-typed arguments as the `deposit` call this module builds.
 */
export function recordedIntentId(f: StatusFixture, destChainId = 42161): string {
  const input = f.source.input.toLowerCase() as Hex;
  let data: Hex;
  if (input.startsWith(ACROSS_DEPOSIT)) data = (input.endsWith("73c0de") ? input.slice(0, -6) : input) as Hex;
  else {
    const {args} = decodeFunctionData({abi: DEPOSIT_V3_ABI, data: input});
    const [depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, destinationChainId, exclusiveRelayer, quoteTimestamp, fillDeadline, exclusivityParameter, message] = args;
    data = encodeAcrossDeposit({
      depositor: depositor.toLowerCase(), recipient: recipient.toLowerCase(), inputToken: inputToken.toLowerCase(), outputToken: outputToken.toLowerCase(),
      inputAmount, outputAmount, destinationChainId, exclusiveRelayer: exclusiveRelayer.toLowerCase(), quoteTimestamp, fillDeadline, exclusivityParameter,
      message: message.toLowerCase() as Hex,
    });
  }
  return acrossIntentId(f.source.chainId, destChainId, data);
}
const DEPOSIT_V3_ABI = parseAbi([
  "function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) payable",
]);
