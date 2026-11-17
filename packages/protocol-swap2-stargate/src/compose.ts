import {decodeAbiParameters, encodeAbiParameters, encodePacked, keccak256, pad, parseAbi, parseAbiParameters, parseEventLogs, zeroAddress, type Address, type Hex, type TransactionReceipt} from "viem";
import type {StargateIntent} from "./intent.js";
import {assertStargate, nonzeroAddress, sameAddress} from "./rpc.js";
import {checkStargateReceipt, stargateComposedTaxiProof, stargateTaxiPayout, type StargateTaxiProof} from "./tracking.js";

export const COMPOSE_ABI = parseAbi([
  "function composeQueue(address from, address to, bytes32 guid, uint16 index) view returns (bytes32)",
  "function lzCompose(address from, address to, bytes32 guid, uint16 index, bytes message, bytes extraData) payable",
  "event ComposeSent(address from, address to, bytes32 guid, uint16 index, bytes message)",
  "event ComposeDelivered(address from, address to, bytes32 guid, uint16 index)",
]);
export const LIFI_COMPOSE_ABI = parseAbi([
  "function executor() view returns (address)",
  "function endpointV2() view returns (address)",
  "function tokenMessaging() view returns (address)",
  "function recoverGas() view returns (uint256)",
  "event LiFiTransferCompleted(bytes32 indexed transactionId, address receivingAssetId, address receiver, uint256 amount, uint256 timestamp)",
  "event LiFiTransferRecovered(bytes32 indexed transactionId, address receivingAssetId, address receiver, uint256 amount, uint256 timestamp)",
  "event AssetSwapped(bytes32 transactionId, address dex, address fromAssetId, address toAssetId, uint256 fromAmount, uint256 toAmount, uint256 timestamp)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
export const LIFI_COMPOSE_PAYLOAD = parseAbiParameters("bytes32 transactionId, (address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)[] swaps, address receiver");

/** Observational pins only; these addresses are NOT a call/spender allowlist. */
export const LIFI_ETHEREUM_COMPOSER = Object.freeze({
  chain: "eip155:1",
  receiver: "0xB539B40793171211DCA8834da044fC14bCe64BDC" as Address,
  executor: "0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88" as Address,
  receiverCodeHash: "0x535b6e74e5bbb38e9a469de60ff2587cf498b92a99be01f34d20c37a77e4cea2" as Hex,
  executorCodeHash: "0xf937f13890d789171f0bcf3c558a64869105000b6771dc182ddc165bde92ddfe" as Hex,
});

export interface StargateComposeExpectation {
  /** Bridge recipient must be the pinned composer; sender is the actual OFTSent actor. */
  bridge: StargateIntent;
  composeFrom: Address;
  composeMsg: Hex;
  recipient: Address;
  finalToken: Address;
  minimum: bigint;
}
export interface LifiStargateComposeProof {
  readonly bridge: StargateTaxiProof;
  readonly transactionId: Hex;
  readonly message: Hex;
  readonly messageHash: Hex;
  readonly recipient: Address;
  readonly finalToken: Address;
  readonly minimum: bigint;
  readonly swap: {readonly callTo: Address; readonly fromAmount: bigint};
  /** True only for routes this SDK encoded and checked before signing (`compose-route`); historical proofs are evidence only. */
  readonly executionSupported: boolean;
}

export {stargateComposeOptions} from "./quote.js";

/** Zero is absent; ONE is consumed (unlike cleared inboundPayloadHash for lzReceive). */
export function stargateComposeQueueState(messageHash: Hex, queue: Hex): "absent" | "consumed" | "pending" | "mismatch" {
  assertStargate(/^0x[0-9a-f]{64}$/i.test(messageHash) && /^0x[0-9a-f]{64}$/i.test(queue), "invalid compose commitment");
  if (BigInt(queue) === 0n) return "absent";
  if (BigInt(queue) === 1n) return "consumed";
  return sameAddress(messageHash, queue) ? "pending" : "mismatch";
}

/**
 * Read-only single-swap LI.FI adapter. Receipts/code must first be obtained from
 * canonical finalized blocks on their respective chains. Consistency is checked
 * here; untrusted JSON supplied by a remote server is not independent RPC evidence.
 */
export function proveLifiStargateCompose(expected: StargateComposeExpectation, source: TransactionReceipt, delivery: TransactionReceipt, code: {receiver: Hex; executor: Hex}): LifiStargateComposeProof {
  const pins = LIFI_ETHEREUM_COMPOSER, i = expected.bridge;
  assertStargate(i.destination.chain === pins.chain && sameAddress(i.recipient, pins.receiver), "unreviewed composer");
  assertStargate(keccak256(code.receiver) === pins.receiverCodeHash && keccak256(code.executor) === pins.executorCodeHash, "composer bytecode changed");
  assertStargate(nonzeroAddress(expected.recipient) && /^0x[0-9a-f]{40}$/i.test(expected.finalToken) && typeof expected.minimum === "bigint" && expected.minimum > 0n && expected.minimum < (1n << 256n), "invalid final action");
  for (const receipt of [source, delivery]) checkStargateReceipt(receipt, receipt.transactionHash, receipt.blockHash);
  const bridge = stargateComposedTaxiProof(i, source, expected.composeFrom, expected.composeMsg);
  const [transactionId, swaps, recipient] = decodeAbiParameters(LIFI_COMPOSE_PAYLOAD, expected.composeMsg);
  assertStargate(encodeAbiParameters(LIFI_COMPOSE_PAYLOAD, [transactionId, swaps, recipient]).toLowerCase() === expected.composeMsg.toLowerCase(), "noncanonical compose message");
  assertStargate(BigInt(transactionId) !== 0n && swaps.length === 1 && sameAddress(recipient, expected.recipient), "unsupported compose action or recipient");
  const swap = swaps[0]!;
  assertStargate(nonzeroAddress(swap.callTo) && nonzeroAddress(swap.approveTo) && swap.fromAmount > 0n && swap.fromAmount <= bridge.amount && sameAddress(swap.sendingAssetId, i.destination.token) && sameAddress(swap.receivingAssetId, expected.finalToken) && !sameAddress(swap.sendingAssetId, swap.receivingAssetId), "compose asset or amount mismatch");
  assertStargate(stargateTaxiPayout(bridge, delivery), "bridge has not paid the composer");
  const message = encodePacked(["uint64", "uint32", "uint256", "bytes32", "bytes"], [bridge.nonce, i.source.eid, bridge.amount, pad(expected.composeFrom, {size: 32}), expected.composeMsg]);
  const sent = parseEventLogs({abi: COMPOSE_ABI, eventName: "ComposeSent", logs: delivery.logs.filter((l) => sameAddress(l.address, i.destination.endpoint)), strict: true})
    .filter((l) => sameAddress(l.args.guid, bridge.guid));
  assertStargate(sent.length === 1 && sameAddress(sent[0]!.args.from, i.destination.address) && sameAddress(sent[0]!.args.to, pins.receiver) && sent[0]!.args.index === 0 && sameAddress(sent[0]!.args.message, message), "compose queue message mismatch");
  const intent = Object.freeze({...i, source: Object.freeze({...i.source}), destination: Object.freeze({...i.destination})});
  return Object.freeze({bridge: Object.freeze({...bridge, intent}), transactionId, message, messageHash: keccak256(message), recipient, finalToken: expected.finalToken, minimum: expected.minimum, swap: Object.freeze({callTo: swap.callTo, fromAmount: swap.fromAmount}), executionSupported: false as boolean});
}

export type StargateComposeOutcome =
  | {state: "unverified"}
  | {state: "completed"; token: Address; amount: bigint; transactionHash: Hex}
  | {state: "intermediate-refunded"; token: Address; amount: bigint; transactionHash: Hex};

/** Final token payment is separate from successful Endpoint compose delivery. */
export function lifiStargateComposeOutcome(p: LifiStargateComposeProof, receipt: TransactionReceipt): StargateComposeOutcome {
  const unknown = {state: "unverified"} as const;
  try {
    if (receipt.status !== "success") return unknown;
    checkStargateReceipt(receipt, receipt.transactionHash, receipt.blockHash);
    const pins = LIFI_ETHEREUM_COMPOSER, d = p.bridge.intent.destination;
    const delivered = parseEventLogs({abi: COMPOSE_ABI, eventName: "ComposeDelivered", logs: receipt.logs.filter((l) => sameAddress(l.address, d.endpoint)), strict: true});
    // Refuse batched attribution until every compose invocation can be delimited.
    if (delivered.length !== 1) return unknown;
    const end = delivered[0]!;
    if (!sameAddress(end.args.guid, p.bridge.guid) || !sameAddress(end.args.from, d.address) || !sameAddress(end.args.to, pins.receiver) || end.args.index !== 0) return unknown;
    const recovered = parseEventLogs({abi: LIFI_COMPOSE_ABI, eventName: "LiFiTransferRecovered", logs: receipt.logs.filter((l) => sameAddress(l.address, pins.receiver)), strict: true}).filter((l) => sameAddress(l.args.transactionId, p.transactionId));
    const completed = parseEventLogs({abi: LIFI_COMPOSE_ABI, eventName: "LiFiTransferCompleted", logs: receipt.logs.filter((l) => sameAddress(l.address, pins.executor)), strict: true}).filter((l) => sameAddress(l.args.transactionId, p.transactionId));
    function paid(token: Address, from: Address, before: number): bigint {
      const transfers = parseEventLogs({abi: LIFI_COMPOSE_ABI, eventName: "Transfer", logs: receipt.logs.filter((l) => sameAddress(l.address, token) && l.logIndex! < before), strict: true});
      let net = 0n;
      for (const {args} of transfers) {
        if (sameAddress(args.to, p.recipient) && sameAddress(args.from, from)) net += args.value;
        if (sameAddress(args.from, p.recipient)) net -= args.value;
      }
      return net;
    }
    if (recovered.length === 1 && completed.length === 0) {
      const event = recovered[0]!;
      if (event.logIndex! >= end.logIndex! || !sameAddress(event.args.receivingAssetId, d.token) || !sameAddress(event.args.receiver, p.recipient) || event.args.amount !== p.bridge.amount) return unknown;
      // Native payout is proven by the pinned receiver's event after safeTransferETH.
      if (d.token !== zeroAddress && paid(d.token, pins.receiver, event.logIndex!) !== p.bridge.amount) return unknown;
      return {state: "intermediate-refunded", token: d.token, amount: p.bridge.amount, transactionHash: receipt.transactionHash};
    }
    if (completed.length !== 1 || recovered.length !== 0 || p.finalToken === zeroAddress) return unknown;
    const event = completed[0]!;
    if (event.logIndex! >= end.logIndex! || !sameAddress(event.args.receiver, p.recipient) || !sameAddress(event.args.receivingAssetId, d.token)) return unknown;
    const swaps = parseEventLogs({abi: LIFI_COMPOSE_ABI, eventName: "AssetSwapped", logs: receipt.logs.filter((l) => sameAddress(l.address, pins.executor)), strict: true}).filter((l) => sameAddress(l.args.transactionId, p.transactionId));
    if (swaps.length !== 1) return unknown;
    const swap = swaps[0]!;
    if (swap.logIndex! >= event.logIndex! || !sameAddress(swap.args.dex, p.swap.callTo) || !sameAddress(swap.args.fromAssetId, d.token) || !sameAddress(swap.args.toAssetId, p.finalToken) || swap.args.fromAmount !== p.swap.fromAmount) return unknown;
    // Executor's Completed event names the INPUT asset and may report a gross balance.
    // Count actual final-token transfers instead of trusting those two fields.
    const amount = paid(p.finalToken, pins.executor, event.logIndex!);
    if (amount < p.minimum || amount !== swap.args.toAmount) return unknown;
    return {state: "completed", token: p.finalToken, amount, transactionHash: receipt.transactionHash};
  } catch { return unknown; }
}
