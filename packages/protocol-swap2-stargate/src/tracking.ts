import {encodeFunctionData, encodePacked, keccak256, pad, parseAbi, parseEventLogs, slice, type Hex, type PublicClient, type TransactionReceipt} from "viem";
import {timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";
import type {IntentRef, IntentStatus, RecoveryQuote} from "@anywalletkit/protocol-swap2-core/types";
import {ENDPOINT_ABI, STARGATE_ABI} from "./abi.js";
import {conversionRate, destinationAmount, splitSourceAmount} from "./amounts.js";
import {stargateRegistry} from "./deployments.js";
import {parseStargateIntent, type StargateIntent} from "./intent.js";
import type {StargateRegistry} from "./registry.js";
import {assertStargate, nonzeroAddress, sameAddress, stargateRpc, type StargateRpcConfig} from "./rpc.js";

export interface StargateTrackingConfig extends StargateRpcConfig {
  registry?: StargateRegistry;
  scanUrl?: string;
  /** Default: RPC finalized block. Explicit depths are an app finality policy, not universal finality. */
  confirmations?: Readonly<Record<string, number>>;
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

/** Source pool + endpoint packet, independent of Scan. Plain Taxi only. */
export function stargateTaxiProof(i: StargateIntent, receipt: TransactionReceipt): StargateTaxiProof {
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
  assertStargate(/^0x01[0-9a-f]{84}$/i.test(message), "unsupported Taxi compose payload");
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
}

export function createStargateTracker(config: StargateTrackingConfig) {
  const registry = config.registry ?? stargateRegistry;
  const rpc = stargateRpc(config);
  const confirmations = {...config.confirmations};
  assertStargate(Object.values(confirmations).every((n) => Number.isSafeInteger(n) && n >= 1 && n <= 100_000), "invalid finality policy");
  const scan = (config.scanUrl ?? "https://scan.layerzero-api.com").replace(/\/+$/, "");
  assertStargate(/^https?:\/\//.test(scan), "invalid Scan URL");
  const fetchImpl = config.fetchImpl ?? fetch;

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
  async function proof(ref: IntentRef): Promise<StargateTaxiProof | null> {
    const i = parseStargateIntent(ref.intentId, registry);
    if (!hash(ref.sourceTxHash) || i.mode !== "taxi") return null;
    const r = await receipt(rpc.client(i.source.chain), i.source.chain, i.source.chainId, ref.sourceTxHash);
    if (r?.status === "reverted" && r.from && r.to && sameAddress(r.from, i.sender) && sameAddress(r.to, i.source.address)) throw new SourceReverted();
    return r ? stargateTaxiProof(i, r) : null;
  }
  async function cached(p: StargateTaxiProof): Promise<boolean> {
    const i = p.intent;
    const c = rpc.client(i.destination.chain);
    assertStargate(await c.getChainId() === i.destination.chainId, "recovery RPC chain mismatch");
    const actual = await c.readContract({address: i.destination.address, abi: STARGATE_ABI, functionName: "unreceivedTokens", args: [p.guid, 0]});
    const expected = keccak256(encodePacked(["uint32", "address", "uint256", "bytes"], [i.source.eid, i.recipient, p.amount, "0x"]));
    return actual === expected;
  }
  async function retryableMessage(p: StargateTaxiProof): Promise<boolean> {
    const i = p.intent, c = rpc.client(i.destination.chain);
    assertStargate(await c.getChainId() === i.destination.chainId, "recovery RPC chain mismatch");
    const actual = await c.readContract({address: i.destination.endpoint, abi: ENDPOINT_ABI, functionName: "inboundPayloadHash", args: [i.destination.tokenMessaging, i.source.eid, pad(i.source.tokenMessaging, {size: 32}), p.nonce]});
    return actual === keccak256(encodePacked(["bytes32", "bytes"], [p.guid, p.message]));
  }
  async function destinationHashes(ref: IntentRef, p: StargateTaxiProof): Promise<Hex[]> {
    const provided = [ref.destTxHash, ref.recoveryChain === p.intent.destination.chain ? ref.recoveryTxHash : undefined].filter(hash);
    try {
      const response = await fetchImpl(`${scan}/v1/messages/guid/${p.guid}`, {signal: timeoutSignal(12_000), headers: {accept: "application/json"}});
      if (!response.ok) return provided;
      const json: unknown = await response.json();
      const data = (json as {data?: unknown})?.data;
      if (!Array.isArray(data)) return provided;
      for (const item of data.slice(0, 32)) {
        const m = item as {guid?: string; destination?: {tx?: {txHash?: string}}};
        if (typeof m.guid === "string" && sameAddress(m.guid, p.guid) && hash(m.destination?.tx?.txHash)) provided.push(m.destination.tx.txHash);
      }
    } catch { /* Scan is discovery only; caller-supplied hashes still need receipt verification. */ }
    return [...new Set(provided)];
  }
  async function trackIntent(ref: IntentRef): Promise<IntentStatus> {
    let deposited = false;
    try {
      const p = await proof(ref);
      if (!p) return {state: "pending"};
      deposited = true;
      const d = p.intent.destination, c = rpc.client(d.chain);
      for (const txHash of await destinationHashes(ref, p)) {
        try {
          const r = await receipt(c, d.chain, d.chainId, txHash);
          // OFTReceived proves token delivery, not the executor's separate native drop.
          if (r && stargateTaxiPayout(p, r)) return {state: p.intent.nativeDrop > 0n ? "partial" : "completed", depositReceived: true, destTxHash: txHash};
        } catch { /* A bad or unindexed discovery candidate proves no payout. */ }
      }
      if (await cached(p) || await retryableMessage(p)) return {state: "action-required", depositReceived: true};
      return {state: "pending", depositReceived: true};
    } catch (error) { return error instanceof SourceReverted ? {state: "failed"} : {state: "pending", ...(deposited ? {depositReceived: true} : {})}; }
  }
  async function getRecoveryQuotes(ref: IntentRef): Promise<RecoveryQuote[]> {
    try {
      const p = await proof(ref);
      if (!p) return [];
      const i = p.intent;
      const c = rpc.client(i.destination.chain);
      if (await c.readContract({address: i.destination.address, abi: STARGATE_ABI, functionName: "status"}) !== 1) return [];
      if (await cached(p)) return [{id: `${p.guid}:retry-token:0`, kind: "retry-token", description: "Retry the cached Stargate token payout to the original recipient. Destination transaction gas is paid separately.", validUntilMs: Date.now() + 60_000,
        tx: {chain: i.destination.chain, chainId: i.destination.chainId, to: i.destination.address, value: "0", data: encodeFunctionData({abi: STARGATE_ABI, functionName: "retryReceiveToken", args: [p.guid, 0, i.source.eid, i.recipient, p.amount, "0x"]})},
      }];
      if (await retryableMessage(p)) return [{id: `${p.guid}:retry-message`, kind: "retry-message", description: "Retry the verified LayerZero Taxi message. Destination transaction gas is paid separately.", validUntilMs: Date.now() + 60_000,
        tx: {chain: i.destination.chain, chainId: i.destination.chainId, to: i.destination.endpoint, value: "0", data: encodeFunctionData({abi: ENDPOINT_ABI, functionName: "lzReceive", args: [{srcEid: i.source.eid, sender: pad(i.source.tokenMessaging, {size: 32}), nonce: p.nonce}, i.destination.tokenMessaging, p.guid, p.message, "0x"]})},
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
  return {trackIntent, getRecoveryQuotes, verifyRecovery, recoveryTargets: (chain: string) => [...new Set([...registry.callTargets(chain), ...registry.deployments.filter((d) => d.chain === chain).map((d) => d.endpoint)])]};
}
