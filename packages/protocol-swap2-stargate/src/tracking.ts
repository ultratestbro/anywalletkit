import {encodeFunctionData, encodePacked, keccak256, pad, parseAbi, parseEventLogs, slice, type Hex, type PublicClient, type TransactionReceipt} from "viem";
import {timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";
import type {IntentRef, IntentStatus, RecoveryQuote} from "@anywalletkit/protocol-swap2-core/types";
import {ENDPOINT_ABI, STARGATE_ABI, TOKEN_MESSAGING_ABI} from "./abi.js";
import {conversionRate, destinationAmount, splitSourceAmount} from "./amounts.js";
import {stargateRegistry} from "./deployments.js";
import {parseStargateIntent, type StargateIntent} from "./intent.js";
import type {StargateRegistry} from "./registry.js";
import {assertStargate, nonzeroAddress, sameAddress, stargateRpc, type StargateRpcConfig} from "./rpc.js";
import {busDriveData, busPassengerPrefix, stargateBusNativeDrop, stargateBusPayout, stargateBusProof, stargateBusTicket, type StargateBusProof, type StargateBusTicket} from "./bus.js";
import {STARGATE_TAXI_EXECUTORS, stargateTaxiNativeDrop} from "./native-drop.js";
import {COMPOSE_ABI, LIFI_ETHEREUM_COMPOSER, lifiStargateComposeOutcome, stargateComposeQueueState, type LifiStargateComposeProof} from "./compose.js";
import {checkStargateComposer, isStargateComposeIntent, parseStargateComposeIntent, stargateComposeMessage, stargateComposeProof, stargateComposeRetryGas, type StargateComposeIntent} from "./compose-route.js";

export interface StargateTrackingConfig extends StargateRpcConfig {
  registry?: StargateRegistry;
  scanUrl?: string;
  /** Default: RPC finalized block. Explicit depths are an app finality policy, not universal finality. */
  confirmations?: Readonly<Record<string, number>>;
  /** Seconds after the compose delivery before a manual lzCompose retry is offered. Default 600. */
  composeRetryAfterS?: number;
  /** Explicit reviewed executor pins for Taxi native-drop evidence. Default: verified Base executor only. */
  taxiExecutors?: Readonly<Record<string, readonly Hex[]>>;
  /** Bounded default log discovery. Older queues can use the indexer callbacks below. */
  busLogPageSize?: number;
  busLogPages?: number;
  /** Untrusted discovery hints: every candidate is authenticated against a source receipt/packet. */
  findBusDrive?: (ticket: Readonly<StargateBusTicket>) => Promise<readonly Hex[]>;
  /** Untrusted queue bytes: the current on-chain passenger hash chain must match. */
  queuedBusPassengers?: (query: {chain: string; tokenMessaging: Hex; dstEid: number; firstTicketId: bigint; count: number; blockNumber: bigint}) => Promise<readonly {ticketId: bigint; passenger: Hex}[]>;
}
const endpointAbi = parseAbi(["event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)"]);
const hash = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const ZERO_HASH = `0x${"00".repeat(32)}`;
class SourceReverted extends Error {}
export interface StargateTaxiProof {
  intent: StargateIntent;
  guid: Hex;
  amount: bigint;
  packet: Hex;
  message: Hex;
  nonce: bigint;
  sourceHash: Hex;
}
type TransferProof = StargateTaxiProof | StargateBusProof;
const seatOf = (p: TransferProof) => "seat" in p ? p.seat : 0;

/** Source pool + endpoint packet, independent of Scan. Plain Taxi only. */
export function stargateTaxiProof(i: StargateIntent, receipt: TransactionReceipt): StargateTaxiProof {
  return taxiProof(i, receipt);
}

/** Read-only packet evidence. This does not approve the destination call for execution. */
export function stargateComposedTaxiProof(i: StargateIntent, receipt: TransactionReceipt, composeFrom: Hex, composeMsg: Hex): StargateTaxiProof {
  assertStargate(nonzeroAddress(composeFrom) && /^0x(?:[0-9a-f]{2}){1,16384}$/i.test(composeMsg), "invalid expected compose payload");
  return taxiProof(i, receipt, `${pad(composeFrom, {size: 32})}${composeMsg.slice(2)}` as Hex);
}

function taxiProof(i: StargateIntent, receipt: TransactionReceipt, expectedCompose?: Hex): StargateTaxiProof {
  assertStargate(i.mode === "taxi" && receipt.status === "success", "not a successful Taxi source receipt");
  const sent = parseEventLogs({abi: STARGATE_ABI, eventName: "OFTSent", logs: receipt.logs.filter((l) => sameAddress(l.address, i.source.address)), strict: true})
    .filter((l) => sameAddress(l.args.fromAddress, i.sender) && l.args.dstEid === i.destination.eid);
  assertStargate(sent.length === 1, "missing or ambiguous source transfer");
  const event = sent[0]!.args;
  assertStargate(event.guid !== ZERO_HASH && event.amountSentLD === splitSourceAmount(i.amount, i.source.localDecimals, i.source.sharedDecimals).sentLD, "source amount mismatch");
  const amount = destinationAmount(event.amountReceivedLD, i.source.localDecimals, i.destination.localDecimals, i.source.sharedDecimals);
  assertStargate(amount >= i.minimum, "source output is below the intent minimum");
  const packets = parseEventLogs({abi: endpointAbi, eventName: "PacketSent", logs: receipt.logs.filter((l) => sameAddress(l.address, i.source.endpoint)), strict: true})
    .filter((l) => l.args.encodedPayload.length >= 228 && sameAddress(slice(l.args.encodedPayload, 81, 113), event.guid));
  assertStargate(packets.length === 1, "missing or ambiguous endpoint packet");
  const packet = packets[0]!.args.encodedPayload;
  assertStargate(slice(packet, 0, 1) === "0x01" && BigInt(slice(packet, 9, 13)) === BigInt(i.source.eid) && BigInt(slice(packet, 45, 49)) === BigInt(i.destination.eid), "packet pathway mismatch");
  assertStargate(sameAddress(slice(packet, 13, 45), pad(i.source.tokenMessaging, {size: 32})) && sameAddress(slice(packet, 49, 81), pad(i.destination.tokenMessaging, {size: 32})), "packet messaging contracts mismatch");
  const message = slice(packet, 113);
  assertStargate(expectedCompose === undefined ? /^0x01[0-9a-f]{84}$/i.test(message) : /^0x01[0-9a-f]+$/i.test(message) && sameAddress(slice(message, 43), expectedCompose), "unsupported Taxi compose payload");
  assertStargate(BigInt(slice(message, 1, 3)) === BigInt(i.source.assetId) && sameAddress(slice(message, 3, 35), pad(i.recipient, {size: 32})) && BigInt(slice(message, 35, 43)) * conversionRate(i.destination.localDecimals, i.destination.sharedDecimals) === amount, "Taxi passenger mismatch");
  return {intent: i, guid: event.guid, amount, packet, message, nonce: BigInt(slice(packet, 1, 9)), sourceHash: receipt.transactionHash};
}

export function stargateTaxiPayout(proof: StargateTaxiProof, receipt: TransactionReceipt): boolean {
  if (receipt.status !== "success") return false;
  const i = proof.intent;
  const received = parseEventLogs({abi: STARGATE_ABI, eventName: "OFTReceived", logs: receipt.logs.filter((l) => sameAddress(l.address, i.destination.address)), strict: true})
    .filter((l) => sameAddress(l.args.guid, proof.guid));
  return received.length === 1 && received[0]!.args.srcEid === i.source.eid && sameAddress(received[0]!.args.toAddress, i.recipient) && received[0]!.args.amountReceivedLD === proof.amount;
}

/** Receipt/block/log identity checks are separate from the provider's event semantics. */
export function checkStargateReceipt(receipt: TransactionReceipt, expectedHash: Hex, blockHash: Hex): void {
  assertStargate(sameAddress(receipt.transactionHash, expectedHash) && sameAddress(receipt.blockHash, blockHash), "receipt block/hash mismatch");
  assertStargate(receipt.logs.every((l) => !l.removed && l.blockNumber === receipt.blockNumber && l.transactionHash !== null && sameAddress(l.transactionHash, expectedHash) && l.blockHash !== null && sameAddress(l.blockHash, blockHash)), "receipt contains foreign or removed logs");
  assertStargate(receipt.logs.every((l, index) => l.logIndex !== null && l.logIndex >= 0 && (index === 0 || l.logIndex > receipt.logs[index - 1]!.logIndex!)), "receipt log order is invalid");
}

export function createStargateTracker(config: StargateTrackingConfig) {
  const registry = config.registry ?? stargateRegistry;
  const rpc = stargateRpc(config);
  const confirmations = {...config.confirmations};
  const taxiExecutors = Object.fromEntries(Object.entries(config.taxiExecutors ?? STARGATE_TAXI_EXECUTORS).map(([chain, addresses]) => {
    assertStargate(/^eip155:[1-9][0-9]*$/.test(chain) && addresses.length <= 32 && addresses.every(nonzeroAddress), "invalid Taxi executor pins");
    return [chain, [...addresses]];
  }));
  assertStargate(Object.values(confirmations).every((n) => Number.isSafeInteger(n) && n >= 1 && n <= 100_000), "invalid finality policy");
  const scan = (config.scanUrl ?? "https://scan.layerzero-api.com").replace(/\/+$/, "");
  assertStargate(/^https?:\/\//.test(scan), "invalid Scan URL");
  const fetchImpl = config.fetchImpl ?? fetch;
  // The LayerZero executor normally runs lzCompose right after delivery; racing it only wastes the user's gas.
  const composeRetryAfter = config.composeRetryAfterS ?? 600;
  assertStargate(Number.isSafeInteger(composeRetryAfter) && composeRetryAfter >= 0 && composeRetryAfter <= 7 * 86_400, "invalid compose retry delay");
  const pageSize = config.busLogPageSize ?? 2000, pages = config.busLogPages ?? 8;
  const findDrive = config.findBusDrive, queuedPassengers = config.queuedBusPassengers;
  assertStargate(Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= 10_000 && Number.isSafeInteger(pages) && pages >= 1 && pages <= 32, "invalid Bus log discovery bounds");

  async function receipt(c: PublicClient, chain: string, chainId: number, txHash: Hex): Promise<TransactionReceipt | null> {
    const [id, r] = await Promise.all([c.getChainId(), c.getTransactionReceipt({hash: txHash})]);
    assertStargate(id === chainId, "receipt RPC chain mismatch");
    const depth = confirmations[chain];
    const [block, head] = await Promise.all([c.getBlock({blockNumber: r.blockNumber}), c.getBlock({blockTag: depth === undefined ? "finalized" : "latest"})]);
    assertStargate(block.hash && head.hash && head.number !== null, "missing receipt finality evidence");
    checkStargateReceipt(r, txHash, block.hash);
    if (head.number < r.blockNumber + BigInt((depth ?? 1) - 1)) return null;
    return r;
  }
  async function busProof(ticket: StargateBusTicket, ref: IntentRef): Promise<StargateBusProof | null> {
    const i = ticket.intent, c = rpc.client(i.source.chain);
    const candidates: Hex[] = [];
    if (ref.recoveryChain === i.source.chain && hash(ref.recoveryTxHash)) candidates.push(ref.recoveryTxHash);
    if (findDrive) candidates.push(...(await findDrive(Object.freeze({...ticket, intent: Object.freeze({...ticket.intent})}))).filter(hash).slice(0, 32));
    const tryCandidates = async () => {
      for (const txHash of [...new Set(candidates.splice(0))]) {
        try {
          const r = await receipt(c, i.source.chain, i.source.chainId, txHash);
          if (r) return stargateBusProof(ticket, r);
        } catch { /* Hints never substitute for a confirmed drive packet. */ }
      }
      return null;
    };
    const hinted = await tryCandidates();
    if (hinted) return hinted;
    const head = await c.getBlockNumber();
    for (let page = 0; page < pages; page++) {
      const fromBlock = ticket.sourceBlock + BigInt(page * pageSize);
      if (fromBlock > head) break;
      const end = fromBlock + BigInt(pageSize - 1), toBlock = end < head ? end : head;
      const logs = await c.getContractEvents({address: i.source.tokenMessaging, abi: TOKEN_MESSAGING_ABI, eventName: "BusDriven", fromBlock, toBlock, strict: true});
      for (const log of logs) if (!log.removed && log.args.dstEid === i.destination.eid && log.args.startTicketId <= ticket.ticketId && ticket.ticketId < log.args.startTicketId + BigInt(log.args.numPassengers) && hash(log.transactionHash)) candidates.push(log.transactionHash);
      const found = await tryCandidates();
      if (found) return found;
    }
    return null;
  }
  async function evidence(ref: IntentRef): Promise<{proof: TransferProof | null; ticket?: StargateBusTicket; compose?: StargateComposeIntent} | null> {
    const compose = isStargateComposeIntent(ref.intentId) ? parseStargateComposeIntent(ref.intentId, registry) : undefined;
    const i = compose ? compose.bridge : parseStargateIntent(ref.intentId, registry);
    if (!hash(ref.sourceTxHash)) return null;
    const r = await receipt(rpc.client(i.source.chain), i.source.chain, i.source.chainId, ref.sourceTxHash);
    if (r?.status === "reverted" && r.from && r.to && sameAddress(r.from, i.sender) && sameAddress(r.to, i.source.address)) throw new SourceReverted();
    if (!r) return null;
    if (compose) return {proof: stargateComposedTaxiProof(i, r, i.sender, stargateComposeMessage(compose)), compose};
    if (i.mode === "taxi") return {proof: stargateTaxiProof(i, r)};
    const ticket = stargateBusTicket(i, r);
    return {ticket, proof: await busProof(ticket, ref)};
  }
  async function cached(p: TransferProof): Promise<boolean> {
    const i = p.intent;
    const c = rpc.client(i.destination.chain);
    assertStargate(await c.getChainId() === i.destination.chainId, "recovery RPC chain mismatch");
    const actual = await c.readContract({address: i.destination.address, abi: STARGATE_ABI, functionName: "unreceivedTokens", args: [p.guid, seatOf(p)]});
    const expected = keccak256(encodePacked(["uint32", "address", "uint256", "bytes"], [i.source.eid, i.recipient, p.amount, "0x"]));
    return actual === expected;
  }
  async function retryableMessage(p: TransferProof): Promise<boolean> {
    const i = p.intent, c = rpc.client(i.destination.chain);
    assertStargate(await c.getChainId() === i.destination.chainId, "recovery RPC chain mismatch");
    const actual = await c.readContract({address: i.destination.endpoint, abi: ENDPOINT_ABI, functionName: "inboundPayloadHash", args: [i.destination.tokenMessaging, i.source.eid, pad(i.source.tokenMessaging, {size: 32}), p.nonce]});
    return actual === keccak256(encodePacked(["bytes32", "bytes"], [p.guid, p.message]));
  }
  async function destinationHashes(ref: IntentRef, p: TransferProof): Promise<Hex[]> {
    const provided = [ref.destTxHash, ref.recoveryChain === p.intent.destination.chain ? ref.recoveryTxHash : undefined].filter(hash);
    try {
      const response = await fetchImpl(`${scan}/v1/messages/guid/${p.guid}`, {signal: timeoutSignal(12_000), headers: {accept: "application/json"}});
      if (!response.ok) return provided;
      const json: unknown = await response.json();
      const data = (json as {data?: unknown})?.data;
      if (!Array.isArray(data)) return provided;
      for (const item of data.slice(0, 32)) {
        const m = item as {guid?: string; destination?: {tx?: {txHash?: string}; nativeDrop?: {tx?: {txHash?: string}}; lzCompose?: {txs?: unknown}}};
        if (typeof m.guid === "string" && sameAddress(m.guid, p.guid)) {
          if (hash(m.destination?.tx?.txHash)) provided.push(m.destination.tx.txHash);
          if (hash(m.destination?.nativeDrop?.tx?.txHash)) provided.push(m.destination.nativeDrop.tx.txHash);
          const composed = m.destination?.lzCompose?.txs;
          if (Array.isArray(composed)) for (const tx of composed.slice(0, 8)) if (hash((tx as {txHash?: unknown})?.txHash)) provided.push((tx as {txHash: Hex}).txHash);
        }
      }
    } catch { /* Scan is discovery only; caller-supplied hashes still need receipt verification. */ }
    return [...new Set(provided)];
  }
  /**
   * Compose state from finalized receipts and the Endpoint queue. Scan names candidate
   * transactions only; the queue commitment decides whether a retry is possible at all.
   */
  type ComposeState = {outcome: "completed" | "intermediate-refunded"; txHash: Hex; lifi: LifiStargateComposeProof} | {queue: ReturnType<typeof stargateComposeQueueState>; retryable: boolean; delivered: Hex | undefined; lifi: LifiStargateComposeProof};
  async function composeState(ref: IntentRef, c: StargateComposeIntent, p: StargateTaxiProof): Promise<ComposeState> {
    const d = p.intent.destination, client = rpc.client(d.chain), lifi = stargateComposeProof(c, p);
    let deliveredAt: bigint | undefined, delivered: Hex | undefined;
    for (const txHash of await destinationHashes(ref, p)) {
      try {
        const r = await receipt(client, d.chain, d.chainId, txHash);
        if (!r) continue;
        if (stargateTaxiPayout(p, r)) { delivered = txHash; deliveredAt = (await client.getBlock({blockNumber: r.blockNumber})).timestamp; }
        const outcome = lifiStargateComposeOutcome(lifi, r);
        if (outcome.state !== "unverified") return {outcome: outcome.state, txHash, lifi};
      } catch { /* A bad or unindexed discovery candidate proves nothing. */ }
    }
    assertStargate(await client.getChainId() === d.chainId, "compose RPC chain mismatch");
    const queue = stargateComposeQueueState(lifi.messageHash, await client.readContract({address: d.endpoint, abi: COMPOSE_ABI, functionName: "composeQueue", args: [d.address, LIFI_ETHEREUM_COMPOSER.receiver, p.guid, 0]}));
    const stale = deliveredAt !== undefined && deliveredAt + BigInt(composeRetryAfter) <= BigInt(Math.floor(Date.now() / 1000));
    return {queue, retryable: queue === "pending" && stale, delivered, lifi};
  }
  async function trackIntent(ref: IntentRef): Promise<IntentStatus> {
    let deposited = false;
    try {
      const e = await evidence(ref);
      if (!e) return {state: "pending"};
      deposited = true;
      const p = e.proof;
      if (!p) return {state: "pending", depositReceived: true};
      if (e.compose && !("seat" in p)) {
        const s = await composeState(ref, e.compose, p);
        // A receiver fallback pays the bridged asset instead of the requested output.
        if ("outcome" in s) return {state: s.outcome === "completed" ? "completed" : "partial", depositReceived: true, destTxHash: s.txHash};
        if (s.retryable) return {state: "action-required", depositReceived: true, ...(s.delivered ? {destTxHash: s.delivered} : {})};
        if (!s.delivered && (await cached(p) || await retryableMessage(p))) return {state: "action-required", depositReceived: true};
        return {state: "pending", depositReceived: true};
      }
      const d = p.intent.destination, c = rpc.client(d.chain);
      let paidHash: Hex | undefined, nativeDropProved = false;
      for (const txHash of await destinationHashes(ref, p)) {
        try {
          const r = await receipt(c, d.chain, d.chainId, txHash);
          if (r) {
            if ("seat" in p && stargateBusNativeDrop(p, r)) nativeDropProved = true;
            if (!("seat" in p) && stargateTaxiNativeDrop(p, r, taxiExecutors[d.chain] ?? [])) nativeDropProved = true;
            let paid = "seat" in p ? stargateBusPayout(p, r) === "paid" : stargateTaxiPayout(p, r);
            if (!paid && "seat" in p && stargateTaxiPayout({...p, packet: "0x"}, r)) {
              // A later retry has one payout event, without the original batch sequence.
              const tx = await c.getTransaction({hash: txHash});
              paid = !!tx.to && sameAddress(tx.to, d.address) && tx.blockHash === r.blockHash && tx.input.toLowerCase() === retryTokenData(p).toLowerCase();
            }
            if (paid) paidHash = txHash;
          }
        } catch { /* A bad or unindexed discovery candidate proves no payout. */ }
      }
      if (paidHash) return {state: p.intent.nativeDrop > 0n && !nativeDropProved ? "partial" : "completed", depositReceived: true, destTxHash: paidHash};
      if (await cached(p) || await retryableMessage(p)) return {state: "action-required", depositReceived: true};
      return {state: "pending", depositReceived: true};
    } catch (error) { return error instanceof SourceReverted ? {state: "failed"} : {state: "pending", ...(deposited ? {depositReceived: true} : {})}; }
  }
  function retryTokenData(p: TransferProof): Hex {
    const i = p.intent;
    return encodeFunctionData({abi: STARGATE_ABI, functionName: "retryReceiveToken", args: [p.guid, seatOf(p), i.source.eid, i.recipient, p.amount, "0x"]});
  }
  async function driveRecovery(ticket: StargateBusTicket): Promise<RecoveryQuote[]> {
    const started = Date.now();
    const i = ticket.intent, c = rpc.client(i.source.chain), d = rpc.client(i.destination.chain);
    const [block, destinationBlock] = await Promise.all([rpc.snapshot(c, i.source.chainId), rpc.snapshot(d, i.destination.chainId)]);
    await Promise.all([rpc.verify(c, i.source, i.destination, block), rpc.verify(d, i.destination, i.source, destinationBlock)]);
    const at = {address: i.source.tokenMessaging, abi: TOKEN_MESSAGING_ABI, blockNumber: block.number};
    const [[maxPassengers, , , length, first], capacity] = await Promise.all([
      c.readContract({...at, functionName: "busQueues", args: [i.destination.eid]}),
      c.readContract({...at, functionName: "queueCapacity"}),
    ]);
    if (capacity === 0 || first > ticket.ticketId || ticket.ticketId >= first + BigInt(length) || ticket.ticketId >= first + BigInt(maxPassengers)) return [];
    let count = 1;
    while (first + BigInt(count - 1) < ticket.ticketId) count++;
    const rows: {ticketId: bigint; passenger: Hex}[] = [];
    if (queuedPassengers) rows.push(...await queuedPassengers({chain: i.source.chain, tokenMessaging: i.source.tokenMessaging, dstEid: i.destination.eid, firstTicketId: first, count, blockNumber: block.number}));
    else {
      // Every ticket in this prefix was queued no later than our own source receipt.
      for (let page = 0; page < pages; page++) {
        const end = ticket.sourceBlock - BigInt(page * pageSize);
        if (end < 0n) break;
        const start = end - BigInt(pageSize - 1);
        const logs = await c.getContractEvents({address: i.source.tokenMessaging, abi: TOKEN_MESSAGING_ABI, eventName: "BusRode", fromBlock: start > 0n ? start : 0n, toBlock: end, strict: true});
        for (const log of logs) if (!log.removed && log.args.dstEid === i.destination.eid && log.args.ticketId >= first && log.args.ticketId <= ticket.ticketId) rows.push({ticketId: log.args.ticketId, passenger: log.args.passenger});
        if (rows.length >= count) break;
      }
    }
    assertStargate(rows.length <= 4096, "too many indexed queue rows");
    const previousIndex = parseInt(((first - 1n + BigInt(capacity)) % BigInt(capacity)).toString(), 10);
    const lastIndex = parseInt((ticket.ticketId % BigInt(capacity)).toString(), 10);
    const [previous, last] = await Promise.all([
      first === 0n ? Promise.resolve(ZERO_HASH as Hex) : c.readContract({...at, functionName: "getPassengerHash", args: [i.destination.eid, previousIndex]}),
      c.readContract({...at, functionName: "getPassengerHash", args: [i.destination.eid, lastIndex]}),
    ]);
    const passengers = busPassengerPrefix(rows, first, count, previous, last, ticket);
    const fee = await c.readContract({...at, functionName: "quoteDriveBus", args: [i.destination.eid, passengers]});
    assertStargate(fee.lzTokenFee === 0n, "unsupported drive fee token");
    await Promise.all([rpc.unchanged(c, block), rpc.unchanged(d, destinationBlock)]);
    assertStargate(Date.now() < started + 60_000, "drive quote expired during reads");
    return [{id: `bus-drive:${ticket.sourceHash}:${first}:${keccak256(passengers)}`, kind: "drive-bus", description: `Pay to drive ${count} queued passenger(s), including this ticket. The payment covers the whole batch; source transaction gas is additional.`, validUntilMs: started + 60_000,
      tx: {chain: i.source.chain, chainId: i.source.chainId, to: i.source.tokenMessaging, value: String(fee.nativeFee), data: busDriveData(i.destination.eid, passengers)},
    }];
  }
  async function getRecoveryQuotes(ref: IntentRef): Promise<RecoveryQuote[]> {
    try {
      const e = await evidence(ref);
      if (!e) return [];
      const p = e.proof;
      if (!p) return e.ticket ? await driveRecovery(e.ticket) : [];
      const i = p.intent;
      const c = rpc.client(i.destination.chain);
      if (e.compose && !("seat" in p)) {
        const s = await composeState(ref, e.compose, p);
        if (!("outcome" in s) && s.retryable) {
          // Fresh pins and recoverGas: a retry with too little gas would make the receiver pay out the bridged token.
          const block = await c.getBlock({blockTag: "latest"});
          const {recoverGas} = await checkStargateComposer(c, i.destination, block.number);
          return [{id: `${p.guid}:compose:0`, kind: "compose", description: "Run the pending LI.FI compose on Ethereum again with the reviewed swap minimum. If the swap still fails, the composer pays the bridged token to the recipient. Ethereum transaction gas is paid separately.", validUntilMs: Date.now() + 60_000,
            tx: {chain: i.destination.chain, chainId: i.destination.chainId, to: i.destination.endpoint, value: "0", gasLimit: String(stargateComposeRetryGas(e.compose, recoverGas)), data: encodeFunctionData({abi: COMPOSE_ABI, functionName: "lzCompose", args: [i.destination.address, LIFI_ETHEREUM_COMPOSER.receiver, p.guid, 0, s.lifi.message, "0x"]})},
          }];
        }
        if ("outcome" in s || s.delivered || s.queue !== "absent") return [];
      }
      if (await c.readContract({address: i.destination.address, abi: STARGATE_ABI, functionName: "status"}) !== 1) return [];
      if (await cached(p)) return [{id: `${p.guid}:retry-token:${seatOf(p)}`, kind: "retry-token", description: "Retry the cached Stargate token payout to the original recipient. Destination transaction gas is paid separately.", validUntilMs: Date.now() + 60_000,
        tx: {chain: i.destination.chain, chainId: i.destination.chainId, to: i.destination.address, value: "0", data: retryTokenData(p)},
      }];
      if (await retryableMessage(p)) return [{id: `${p.guid}:retry-message`, kind: "retry-message", description: "Retry the verified LayerZero message. Any attached value funds native drops for the entire Bus batch; destination transaction gas is additional.", validUntilMs: Date.now() + 60_000,
        tx: {chain: i.destination.chain, chainId: i.destination.chainId, to: i.destination.endpoint, value: "totalNativeDrops" in p ? String(p.totalNativeDrops * p.nativeDropAmount) : "0", data: encodeFunctionData({abi: ENDPOINT_ABI, functionName: "lzReceive", args: [{srcEid: i.source.eid, sender: pad(i.source.tokenMessaging, {size: 32}), nonce: p.nonce}, i.destination.tokenMessaging, p.guid, p.message, "0x"]})},
      }];
      return [];
    } catch { return []; }
  }
  async function verifyRecovery(ref: IntentRef, offered: RecoveryQuote, actor: string): Promise<string | null> {
    if (!nonzeroAddress(actor) || !Number.isFinite(offered.validUntilMs) || offered.validUntilMs <= Date.now() || offered.validUntilMs > Date.now() + 60_000) return "stargate: invalid recovery actor or expiry";
    const fresh = (await getRecoveryQuotes(ref)).find((q) => q.id === offered.id);
    if (!fresh || fresh.kind !== offered.kind || Object.keys(offered.tx).length !== Object.keys(fresh.tx).length || Object.entries(fresh.tx).some(([key, value]) => offered.tx[key as keyof typeof offered.tx] !== value)) return "stargate: recovery no longer matches the cached on-chain payout";
    return null;
  }
  return {trackIntent, getRecoveryQuotes, verifyRecovery, recoveryTargets: (chain: string) => [...new Set([...registry.callTargets(chain), ...registry.deployments.filter((d) => d.chain === chain).flatMap((d) => [d.endpoint, d.tokenMessaging])])]};
}
