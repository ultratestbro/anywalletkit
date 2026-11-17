import {concatHex, encodeFunctionData, encodePacked, keccak256, pad, parseEventLogs, slice, type Hex, type TransactionReceipt} from "viem";
import {ENDPOINT_ABI, STARGATE_ABI, TOKEN_MESSAGING_ABI} from "./abi.js";
import {conversionRate, destinationAmount, splitSourceAmount} from "./amounts.js";
import type {StargateIntent} from "./intent.js";
import {assertStargate, sameAddress} from "./rpc.js";

const ZERO_HASH = `0x${"00".repeat(32)}`;
const byteLength = (hex: Hex) => (hex.length - 2) / 2;
export interface StargateBusPassenger {assetId: bigint; receiver: Hex; amountSD: bigint; nativeDrop: boolean; bytes: Hex}
export interface StargateBusTicket {
  intent: StargateIntent;
  ticketId: bigint;
  passenger: Hex;
  amount: bigint;
  sourceHash: Hex;
  sourceBlock: bigint;
}
export interface StargateBusProof extends StargateBusTicket {
  guid: Hex;
  driveHash: Hex;
  nonce: bigint;
  message: Hex;
  seat: number;
  passengers: readonly StargateBusPassenger[];
  nativeDropAmount: bigint;
  totalNativeDrops: bigint;
}

export function decodeBusPassenger(bytes: Hex): StargateBusPassenger {
  assertStargate(/^0x[0-9a-f]{86}$/i.test(bytes), "invalid Bus passenger bytes");
  const flag = slice(bytes, 42, 43);
  assertStargate(flag === "0x00" || flag === "0x01", "invalid Bus native-drop flag");
  return {assetId: BigInt(slice(bytes, 0, 2)), receiver: slice(bytes, 2, 34), amountSD: BigInt(slice(bytes, 34, 42)), nativeDrop: flag === "0x01", bytes};
}

/** A uint72 ticket is not a LayerZero GUID, even if it fits a JS number today. */
export function stargateBusTicket(i: StargateIntent, receipt: TransactionReceipt): StargateBusTicket {
  assertStargate(i.mode === "bus" && receipt.status === "success", "not a successful Bus source receipt");
  const sent = parseEventLogs({abi: STARGATE_ABI, eventName: "OFTSent", logs: receipt.logs.filter((l) => sameAddress(l.address, i.source.address)), strict: true})
    .filter((l) => l.args.guid === ZERO_HASH && l.args.dstEid === i.destination.eid && sameAddress(l.args.fromAddress, i.sender));
  assertStargate(sent.length === 1, "missing or ambiguous Bus send");
  const a = sent[0]!.args;
  assertStargate(a.amountSentLD === splitSourceAmount(i.amount, i.source.localDecimals, i.source.sharedDecimals).sentLD, "Bus source amount mismatch");
  const amount = destinationAmount(a.amountReceivedLD, i.source.localDecimals, i.destination.localDecimals, i.source.sharedDecimals);
  assertStargate(amount >= i.minimum, "Bus output below minimum");
  const passenger = encodePacked(["uint16", "bytes32", "uint64", "bool"], [i.source.assetId, pad(i.recipient, {size: 32}), a.amountReceivedLD / conversionRate(i.source.localDecimals, i.source.sharedDecimals), i.nativeDrop > 0n]);
  const rides = parseEventLogs({abi: TOKEN_MESSAGING_ABI, eventName: "BusRode", logs: receipt.logs.filter((l) => sameAddress(l.address, i.source.tokenMessaging)), strict: true})
    .filter((l) => l.args.dstEid === i.destination.eid && sameAddress(l.args.passenger, passenger));
  assertStargate(rides.length === 1, "missing or ambiguous Bus ticket");
  return {intent: i, ticketId: rides[0]!.args.ticketId, passenger, amount, sourceHash: receipt.transactionHash, sourceBlock: receipt.blockNumber};
}

/** Authenticate a driven range AND the exact passenger bytes at this ticket's seat. */
export function stargateBusProof(ticket: StargateBusTicket, receipt: TransactionReceipt): StargateBusProof {
  const i = ticket.intent;
  assertStargate(receipt.status === "success" && receipt.blockNumber >= ticket.sourceBlock, "invalid Bus drive receipt");
  const drives = parseEventLogs({abi: TOKEN_MESSAGING_ABI, eventName: "BusDriven", logs: receipt.logs.filter((l) => sameAddress(l.address, i.source.tokenMessaging)), strict: true})
    .filter((l) => l.args.dstEid === i.destination.eid && l.args.startTicketId <= ticket.ticketId && ticket.ticketId < l.args.startTicketId + BigInt(l.args.numPassengers));
  assertStargate(drives.length === 1, "ticket not uniquely covered by BusDriven");
  const drive = drives[0]!.args;
  assertStargate(drive.guid !== ZERO_HASH, "Bus drive has no GUID");
  const packets = parseEventLogs({abi: ENDPOINT_ABI, eventName: "PacketSent", logs: receipt.logs.filter((l) => sameAddress(l.address, i.source.endpoint)), strict: true})
    .filter((l) => byteLength(l.args.encodedPayload) >= 113 && sameAddress(slice(l.args.encodedPayload, 81, 113), drive.guid));
  assertStargate(packets.length === 1, "missing Bus endpoint packet");
  const packet = packets[0]!.args.encodedPayload;
  assertStargate(slice(packet, 0, 1) === "0x01" && BigInt(slice(packet, 9, 13)) === BigInt(i.source.eid) && BigInt(slice(packet, 45, 49)) === BigInt(i.destination.eid) && sameAddress(slice(packet, 13, 45), pad(i.source.tokenMessaging, {size: 32})) && sameAddress(slice(packet, 49, 81), pad(i.destination.tokenMessaging, {size: 32})), "Bus packet pathway mismatch");
  const message = slice(packet, 113);
  assertStargate(byteLength(message) === 33 + drive.numPassengers * 43 && slice(message, 0, 1) === "0x02" && drive.numPassengers > 0, "Bus message size/type mismatch");
  const passengers = Array.from({length: drive.numPassengers}, (_, index) => decodeBusPassenger(slice(message, 33 + index * 43, 33 + (index + 1) * 43)));
  const seat = passengers.findIndex((_, index) => drive.startTicketId + BigInt(index) === ticket.ticketId);
  assertStargate(seat >= 0 && sameAddress(passengers[seat]!.bytes, ticket.passenger), "ticket passenger differs from driven message");
  const totalNativeDrops = BigInt(slice(message, 1, 17)), nativeDropAmount = BigInt(slice(message, 17, 33));
  assertStargate(totalNativeDrops === BigInt(passengers.filter((p) => p.nativeDrop).length), "Bus native drop count mismatch");
  return {...ticket, guid: drive.guid, driveHash: receipt.transactionHash, nonce: BigInt(slice(packet, 1, 9)), message, seat, passengers, totalNativeDrops, nativeDropAmount};
}

/**
 * OFTReceived has no seat index. Match the complete ordered payout/cache sequence
 * for this asset, so two identical passengers cannot claim each other's payment.
 */
export function stargateBusPayout(p: StargateBusProof, receipt: TransactionReceipt): "paid" | "cached" | null {
  if (receipt.status !== "success") return null;
  const i = p.intent;
  const events = parseEventLogs({abi: STARGATE_ABI, logs: receipt.logs.filter((l) => sameAddress(l.address, i.destination.address)), strict: true})
    .filter((l) => (l.eventName === "OFTReceived" || l.eventName === "UnreceivedTokenCached") && sameAddress(l.args.guid, p.guid));
  const expected = p.passengers.flatMap((passenger, seat) => passenger.assetId === BigInt(i.source.assetId) ? [{passenger, seat}] : []);
  if (events.length !== expected.length) return null;
  let result: "paid" | "cached" | null = null;
  for (let index = 0; index < expected.length; index++) {
    const {passenger, seat} = expected[index]!, event = events[index]!;
    const amount = passenger.amountSD * conversionRate(i.destination.localDecimals, i.destination.sharedDecimals);
    if (event.eventName === "OFTReceived") {
      if (event.args.srcEid !== i.source.eid || !sameAddress(pad(event.args.toAddress, {size: 32}), passenger.receiver) || event.args.amountReceivedLD !== amount) return null;
      if (seat === p.seat) result = "paid";
    } else if (event.eventName === "UnreceivedTokenCached") {
      if (event.args.index !== seat || event.args.srcEid !== i.source.eid || !sameAddress(pad(event.args.receiver, {size: 32}), passenger.receiver) || event.args.amountLD !== amount || event.args.composeMsg !== "0x") return null;
      if (seat === p.seat) result = "cached";
    } else return null;
  }
  return result;
}

/** Native-drop events omit GUID: require one authenticated delivery to this OApp in the receipt. */
export function stargateBusNativeDrop(p: StargateBusProof, receipt: TransactionReceipt): boolean {
  if (receipt.status !== "success" || !p.passengers[p.seat]?.nativeDrop || p.nativeDropAmount === 0n) return false;
  const i = p.intent;
  const deliveries = parseEventLogs({abi: ENDPOINT_ABI, eventName: "PacketDelivered", logs: receipt.logs.filter((l) => sameAddress(l.address, i.destination.endpoint)), strict: true})
    .filter((l) => sameAddress(l.args.receiver, i.destination.tokenMessaging));
  if (deliveries.length !== 1) return false;
  const origin = deliveries[0]!.args.origin;
  if (origin.nonce !== p.nonce || origin.srcEid !== i.source.eid || !sameAddress(origin.sender, pad(i.source.tokenMessaging, {size: 32}))) return false;
  const drops = parseEventLogs({abi: TOKEN_MESSAGING_ABI, logs: receipt.logs.filter((l) => sameAddress(l.address, i.destination.tokenMessaging)), strict: true})
    .filter((l) => l.eventName === "NativeDropApplied" || l.eventName === "NativeDropFailed");
  const expected = p.passengers.flatMap((passenger, seat) => passenger.nativeDrop ? [{passenger, seat}] : []);
  if (drops.length !== expected.length) return false;
  let paid = false;
  for (let index = 0; index < expected.length; index++) {
    const event = drops[index]!, target = expected[index]!;
    if (!sameAddress(pad(event.args.receiver, {size: 32}), target.passenger.receiver) || event.args.amount !== p.nativeDropAmount || event.logIndex! >= deliveries[0]!.logIndex!) return false;
    if (target.seat === p.seat) paid = event.eventName === "NativeDropApplied";
  }
  return paid;
}

export function busPassengerPrefix(rows: readonly {ticketId: bigint; passenger: Hex}[], first: bigint, count: number, previousHash: Hex, expectedHash: Hex, ticket: StargateBusTicket): Hex {
  assertStargate(Number.isInteger(count) && count >= 1 && count <= 255 && ticket.ticketId >= first && ticket.ticketId < first + BigInt(count), "drive prefix does not include this ticket");
  const selected = Array.from({length: count}, (_, index) => {
    const matches = rows.filter((row) => row.ticketId === first + BigInt(index));
    assertStargate(matches.length === 1, "missing or duplicate queued passenger");
    const row = matches[0]!;
    decodeBusPassenger(row.passenger);
    if (row.ticketId === ticket.ticketId) assertStargate(sameAddress(row.passenger, ticket.passenger), "queued passenger differs from source receipt");
    return row.passenger;
  });
  let current = previousHash;
  for (const passenger of selected) current = keccak256(concatHex([current, passenger]));
  assertStargate(sameAddress(current, expectedHash), "queued passenger hash chain mismatch");
  return concatHex(selected);
}

export function busDriveData(dstEid: number, passengers: Hex): Hex {
  return encodeFunctionData({abi: TOKEN_MESSAGING_ABI, functionName: "driveBus", args: [dstEid, passengers]});
}
