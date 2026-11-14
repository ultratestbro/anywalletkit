/**
 * Where an Across deposit stands, read from the chains themselves — no Across API.
 *
 *  1. The source receipt: the deposit's `FundsDeposited` event, emitted by the pinned SpokePool of the source chain,
 *     carries every field of the relay (V3SpokePoolInterface.sol `FundsDeposited`; `exclusivityDeadline` there is the
 *     resolved timestamp, which is what the relay is keyed by). The event taken is the intent's own: the `deposit`
 *     calldata its fields make hashes to the intent id's digest ({@link acrossDepositIsIntent}) — another deposit in
 *     the same transaction, or another transaction's, is never reported as this one.
 *  2. The relay hash, exactly as the destination SpokePool computes it: `keccak256(abi.encode(relayData, chainId()))`
 *     with `relayData` the `V3RelayData` struct (depositor, recipient, exclusiveRelayer, inputToken, outputToken,
 *     inputAmount, outputAmount, originChainId, depositId, fillDeadline, exclusivityDeadline, message) and `chainId()`
 *     the destination's own `block.chainid` (SpokePool.sol `getV3RelayHash`; no pinned chain overrides it).
 *  3. The destination SpokePool's `fillStatuses(relayHash)`, read at the latest block together with that block's time:
 *     2 is filled; 0 (unfilled) or 1 (slow fill requested) is still open while the block time is at or before the fill
 *     deadline, and final after it — every fill path reverts with `ExpiredFillDeadline` once `fillDeadline <
 *     block.timestamp`. Such a deposit is reported `expired`, a terminal state: Across refunds it to its depositor on
 *     the source chain through its next settlement bundles (hours, not minutes; Across's docs: "do not tell users to
 *     expect immediate refunds"), and this module does not watch for the refund itself.
 *
 * Display only: nothing is signed on what this reads. A node that does not answer, or a receipt that does not hold
 * exactly the intent's deposit, leaves the status where it was ("pending"); a terminal state is reported only from a
 * reverted receipt or a fill status that says so.
 */
import {decodeAbiParameters, encodeAbiParameters, keccak256, type Hex} from "viem";
import type {IntentStatus} from "@anywalletkit/protocol-swap2-core/types";
import {redactUrls, timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";
import {ACROSS_FILL_STATUSES, ACROSS_FUNDS_DEPOSITED, ACROSS_MAX_EXCLUSIVITY_PERIOD_S, type AcrossChain} from "./config.js";
import {acrossAddressOf, encodeAcrossDeposit} from "./deposit.js";

/** A deposit as its `FundsDeposited` event states it. Parties and tokens are the raw bytes32 words, lowercase. */
export interface AcrossDepositEvent {
  originChainId: number;
  destinationChainId: bigint;
  depositId: bigint;
  depositor: Hex;
  recipient: Hex;
  exclusiveRelayer: Hex;
  inputToken: Hex;
  outputToken: Hex;
  inputAmount: bigint;
  outputAmount: bigint;
  quoteTimestamp: number;
  fillDeadline: number;
  /** The resolved exclusivity deadline (0 for none), not the deposit's raw parameter. */
  exclusivityDeadline: number;
  message: Hex;
}

/** `fillStatuses` values (V3SpokePoolInterface.sol `FillStatus`). */
export const ACROSS_FILL_STATUS = Object.freeze({UNFILLED: 0, REQUESTED_SLOW_FILL: 1, FILLED: 2} as const);

/** A relay's state on the destination. `expired`: unfilled past its fill deadline — refunded on the source chain by Across. */
export type AcrossFillState = "unfilled" | "slow-fill-requested" | "filled" | "expired";

const EVENT_DATA = [
  {name: "inputToken", type: "bytes32"},
  {name: "outputToken", type: "bytes32"},
  {name: "inputAmount", type: "uint256"},
  {name: "outputAmount", type: "uint256"},
  {name: "quoteTimestamp", type: "uint32"},
  {name: "fillDeadline", type: "uint32"},
  {name: "exclusivityDeadline", type: "uint32"},
  {name: "recipient", type: "bytes32"},
  {name: "exclusiveRelayer", type: "bytes32"},
  {name: "message", type: "bytes"},
] as const;

const RELAY_DATA = {
  type: "tuple",
  components: [
    {name: "depositor", type: "bytes32"},
    {name: "recipient", type: "bytes32"},
    {name: "exclusiveRelayer", type: "bytes32"},
    {name: "inputToken", type: "bytes32"},
    {name: "outputToken", type: "bytes32"},
    {name: "inputAmount", type: "uint256"},
    {name: "outputAmount", type: "uint256"},
    {name: "originChainId", type: "uint256"},
    {name: "depositId", type: "uint256"},
    {name: "fillDeadline", type: "uint32"},
    {name: "exclusivityDeadline", type: "uint32"},
    {name: "message", type: "bytes"},
  ],
} as const;

const WORD = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const DIGEST = /^[0-9a-f]{32}$/;
const QUANTITY = /^0x[0-9a-fA-F]{1,16}$/;
const lowerHex = (s: string): Hex => s.toLowerCase() as Hex;

/**
 * Every `FundsDeposited` the pinned SpokePool of `source` emitted in a transaction receipt (an `eth_getTransactionReceipt`
 * answer), in log order. Logs of any other contract, and logs that do not decode as the event, are skipped.
 */
export function acrossDepositsInReceipt(receipt: unknown, source: AcrossChain): AcrossDepositEvent[] {
  const logs = (receipt as {logs?: unknown} | null)?.logs;
  if (!Array.isArray(logs)) return [];
  const out: AcrossDepositEvent[] = [];
  for (const log of logs as {address?: unknown; topics?: unknown; data?: unknown; removed?: unknown}[]) {
    if (log === null || typeof log !== "object" || log.removed === true) continue;
    if (typeof log.address !== "string" || log.address.toLowerCase() !== source.spokePool) continue;
    const topics = log.topics;
    if (!Array.isArray(topics) || topics.length !== 4 || !topics.every((t) => typeof t === "string" && WORD.test(t))) continue;
    if ((topics[0] as string).toLowerCase() !== ACROSS_FUNDS_DEPOSITED) continue;
    if (typeof log.data !== "string" || !HEX.test(log.data)) continue;
    let d: readonly [Hex, Hex, bigint, bigint, number, number, number, Hex, Hex, Hex];
    try {
      d = decodeAbiParameters(EVENT_DATA, log.data as Hex);
    } catch {
      continue;
    }
    out.push({
      originChainId: source.chainId,
      destinationChainId: BigInt(topics[1] as string),
      depositId: BigInt(topics[2] as string),
      depositor: lowerHex(topics[3] as string),
      inputToken: lowerHex(d[0]),
      outputToken: lowerHex(d[1]),
      inputAmount: d[2],
      outputAmount: d[3],
      quoteTimestamp: d[4],
      fillDeadline: d[5],
      exclusivityDeadline: d[6],
      recipient: lowerHex(d[7]),
      exclusiveRelayer: lowerHex(d[8]),
      message: lowerHex(d[9]),
    });
  }
  return out;
}

/**
 * The `deposit` calldata an event's fields make with this exclusivity parameter — what an intent id's digest is taken
 * over. Null for a deposit whose parties or tokens are not EVM addresses: not one this module builds.
 */
function depositDataOf(e: AcrossDepositEvent, exclusivityParameter: number): Hex | null {
  const depositor = acrossAddressOf(e.depositor);
  const recipient = acrossAddressOf(e.recipient);
  const inputToken = acrossAddressOf(e.inputToken);
  const outputToken = acrossAddressOf(e.outputToken);
  const exclusiveRelayer = acrossAddressOf(e.exclusiveRelayer);
  if (!depositor || !recipient || !inputToken || !outputToken || !exclusiveRelayer) return null;
  try {
    return encodeAcrossDeposit({
      depositor, recipient, inputToken, outputToken, inputAmount: e.inputAmount, outputAmount: e.outputAmount, destinationChainId: e.destinationChainId,
      exclusiveRelayer, quoteTimestamp: e.quoteTimestamp, fillDeadline: e.fillDeadline, exclusivityParameter, message: e.message,
    });
  } catch {
    return null;
  }
}

/**
 * Whether a deposit event is the one an intent id names: the canonical `deposit` calldata of its fields hashes to the
 * id's digest (`acrossIntentId`), so every field — parties, tokens, amounts, destination, deadlines, message — is the
 * signed one. The event carries the resolved exclusivity deadline, not the parameter: 0 for none, the parameter itself
 * for a timestamp, and for an offset the time of the block the deposit landed in plus the offset (SpokePool.sol
 * `_depositV3`) — so an offset is recognized only with `sourceBlockTime`.
 */
export function acrossDepositIsIntent(e: AcrossDepositEvent, digest: string, sourceBlockTime?: number): boolean {
  if (typeof digest !== "string" || !DIGEST.test(digest)) return false;
  const d = e.exclusivityDeadline;
  const candidates: number[] = [];
  if (d === 0) candidates.push(0);
  else {
    if (d > ACROSS_MAX_EXCLUSIVITY_PERIOD_S) candidates.push(d);
    if (sourceBlockTime !== undefined && d - sourceBlockTime > 0 && d - sourceBlockTime <= ACROSS_MAX_EXCLUSIVITY_PERIOD_S) candidates.push(d - sourceBlockTime);
  }
  return candidates.some((p) => {
    const data = depositDataOf(e, p);
    return data !== null && keccak256(data).slice(2, 34) === digest;
  });
}

/** The relay hash of a deposit — the key of `fillStatuses` on its destination chain. */
export function acrossRelayHash(e: AcrossDepositEvent): Hex {
  return keccak256(encodeAbiParameters([RELAY_DATA, {type: "uint256"}], [{
    depositor: e.depositor,
    recipient: e.recipient,
    exclusiveRelayer: e.exclusiveRelayer,
    inputToken: e.inputToken,
    outputToken: e.outputToken,
    inputAmount: e.inputAmount,
    outputAmount: e.outputAmount,
    originChainId: BigInt(e.originChainId),
    depositId: e.depositId,
    fillDeadline: e.fillDeadline,
    exclusivityDeadline: e.exclusivityDeadline,
    message: e.message,
  }, e.destinationChainId]));
}

/** Calldata of `fillStatuses(relayHash)`. */
export function acrossFillStatusCall(relayHash: Hex): Hex {
  if (!WORD.test(relayHash)) throw new Error("across: a relay hash is 32 bytes");
  return `${ACROSS_FILL_STATUSES}${relayHash.slice(2).toLowerCase()}` as Hex;
}

/** A `fillStatuses` answer: 0, 1 or 2; null for anything else (another word, another length). */
export function parseAcrossFillStatus(answer: unknown): 0 | 1 | 2 | null {
  if (typeof answer !== "string" || !/^0x0{63}[0-2]$/i.test(answer)) return null;
  return Number(answer.slice(-1)) as 0 | 1 | 2;
}

/** A fill status read at a destination block whose time is `blockTime`. */
export function acrossFillState(status: 0 | 1 | 2, fillDeadline: number, blockTime: number): AcrossFillState {
  if (status === ACROSS_FILL_STATUS.FILLED) return "filled";
  // `fillDeadline < block.timestamp` reverts every fill, slow or fast: at a later block nothing can fill it any more.
  if (blockTime > fillDeadline) return "expired";
  return status === ACROSS_FILL_STATUS.REQUESTED_SLOW_FILL ? "slow-fill-requested" : "unfilled";
}

/** A JSON-RPC caller: the `result` of `method`, or a throw. */
export type AcrossRpc = (method: string, params: readonly unknown[]) => Promise<unknown>;

const MAX_RPC_BODY = 8 * 1024 * 1024;

/** A minimal JSON-RPC client over `fetch` (12 s per call); its errors never carry the URL (a keyed RPC has its key there). */
export function acrossRpc(url: string, fetchImpl?: typeof fetch, timeoutMs = 12_000): AcrossRpc {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error("across: an RPC URL must use http or https");
  let id = 0;
  return async (method, params) => {
    let text: string;
    try {
      const res = await (fetchImpl ?? fetch)(url, {
        method: "POST",
        headers: {"content-type": "application/json", accept: "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id: ++id, method, params}),
        signal: timeoutSignal(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      throw new Error(`across: ${method} failed — ${redactUrls(err instanceof Error ? err.message : String(err)).slice(0, 160)}`);
    }
    if (text.length > MAX_RPC_BODY) throw new Error(`across: ${method} answered more than ${MAX_RPC_BODY} bytes`);
    let body: {result?: unknown; error?: {message?: unknown}} | null;
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`across: ${method} answered something that is not JSON`);
    }
    if (body === null || typeof body !== "object") throw new Error(`across: ${method} answered something that is not JSON-RPC`);
    if (body.error !== undefined) throw new Error(`across: ${method} failed — ${redactUrls(String(body.error?.message ?? "error")).slice(0, 160)}`);
    if (!Object.prototype.hasOwnProperty.call(body, "result")) throw new Error(`across: ${method} answered no result`);
    return body.result;
  };
}

/** What {@link trackAcrossDeposit} found: the status, and the facts it rests on when they were read. */
export interface AcrossTrack {
  status: IntentStatus;
  deposit?: AcrossDepositEvent;
  relayHash?: Hex;
  fill?: AcrossFillState;
  /** The destination block the fill status was read at. */
  destBlock?: {number: string; timestamp: number};
}

export interface AcrossTrackInput {
  sourceTxHash: string;
  /** The intent id's digest of the deposit calldata (`parseAcrossIntentId(id).digest`): the deposit looked for. */
  intentDigest: string;
  source: AcrossChain;
  dest: AcrossChain;
  /** The source chain's RPC; without it nothing can be read ("pending"). */
  sourceRpc?: AcrossRpc;
  /** The destination chain's RPC; without it the deposit is seen but its fill is not ("pending"). */
  destRpc?: AcrossRpc;
}

/** The time of a source block, by number; null when the node does not say. */
async function blockTimeOf(rpc: AcrossRpc, number: unknown): Promise<number | null> {
  if (typeof number !== "string" || !QUANTITY.test(number)) return null;
  try {
    const block = (await rpc("eth_getBlockByNumber", [number, false])) as {number?: unknown; timestamp?: unknown} | null;
    const timestamp = block?.timestamp;
    if (typeof block?.number !== "string" || block.number.toLowerCase() !== number.toLowerCase()) return null;
    if (typeof timestamp !== "string" || !/^0x[0-9a-fA-F]{1,12}$/.test(timestamp)) return null;
    return parseInt(timestamp, 16);
  } catch {
    return null;
  }
}

/**
 * The intent's deposit in the transaction `sourceTxHash` from `source` to `dest`, and whether it was filled — read on
 * chain only.
 */
export async function trackAcrossDeposit(input: AcrossTrackInput): Promise<AcrossTrack> {
  const {source, dest, sourceRpc, destRpc} = input;
  if (typeof input.sourceTxHash !== "string" || !WORD.test(input.sourceTxHash) || !sourceRpc) return {status: {state: "pending"}};
  if (typeof input.intentDigest !== "string" || !DIGEST.test(input.intentDigest)) return {status: {state: "pending"}};
  let receipt: unknown;
  try {
    receipt = await sourceRpc("eth_getTransactionReceipt", [input.sourceTxHash]);
  } catch {
    return {status: {state: "pending"}};
  }
  // Not mined yet (or not seen by this node).
  if (receipt === null || receipt === undefined) return {status: {state: "pending"}};
  if (typeof receipt !== "object") return {status: {state: "pending"}};
  const status = (receipt as {status?: unknown}).status;
  // The deposit reverted: nothing left the wallet but the gas.
  if (status === "0x0") return {status: {state: "failed"}};
  if (status !== "0x1") return {status: {state: "pending"}};
  // A receipt for another transaction is no answer.
  const txHash = (receipt as {transactionHash?: unknown}).transactionHash;
  if (txHash !== undefined && (typeof txHash !== "string" || txHash.toLowerCase() !== input.sourceTxHash.toLowerCase())) return {status: {state: "pending"}};
  const onRoute = acrossDepositsInReceipt(receipt, source).filter((d) => d.destinationChainId === BigInt(dest.chainId));
  let mine = onRoute.filter((d) => acrossDepositIsIntent(d, input.intentDigest));
  // An offset exclusivity resolves against the source block's time, read only when an event needs it.
  if (mine.length === 0 && onRoute.some((d) => d.exclusivityDeadline !== 0)) {
    const blockTime = await blockTimeOf(sourceRpc, (receipt as {blockNumber?: unknown}).blockNumber);
    if (blockTime === null) return {status: {state: "pending"}};
    mine = onRoute.filter((d) => acrossDepositIsIntent(d, input.intentDigest, blockTime));
  }
  // Not exactly the intent's deposit — a node with partial logs, another transaction's hash, the same call twice:
  // nothing is known about this transfer, which is not a failure.
  if (mine.length !== 1) return {status: {state: "pending"}};
  const deposit = mine[0]!;
  const relayHash = acrossRelayHash(deposit);
  const seen: AcrossTrack = {status: {state: "pending", depositReceived: true}, deposit, relayHash};
  if (!destRpc) return seen;
  try {
    const block = (await destRpc("eth_getBlockByNumber", ["latest", false])) as {number?: unknown; timestamp?: unknown} | null;
    const number = block?.number;
    const timestamp = block?.timestamp;
    if (typeof number !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(number) || typeof timestamp !== "string" || !/^0x[0-9a-fA-F]{1,12}$/.test(timestamp)) return seen;
    const blockTime = parseInt(timestamp, 16);
    const fillStatus = parseAcrossFillStatus(await destRpc("eth_call", [{to: dest.spokePool, data: acrossFillStatusCall(relayHash)}, number]));
    if (fillStatus === null) return seen;
    const fill = acrossFillState(fillStatus, deposit.fillDeadline, blockTime);
    const destBlock = {number: number.toLowerCase(), timestamp: blockTime};
    if (fill === "filled") return {status: {state: "completed", depositReceived: true}, deposit, relayHash, fill, destBlock};
    // Past its fill deadline unfilled: final. Across refunds the depositor on the source chain in the coming hours; the
    // refund is not watched here, so the state is one that ends polling.
    if (fill === "expired") return {status: {state: "expired", depositReceived: true}, deposit, relayHash, fill, destBlock};
    return {status: {state: "pending", depositReceived: true}, deposit, relayHash, fill, destBlock};
  } catch {
    return seen;
  }
}
