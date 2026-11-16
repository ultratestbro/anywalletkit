import {describe, expect, it} from "vitest";
import {concatHex, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodePacked, getAbiItem, keccak256, pad, toHex, type Abi, type AbiEvent, type Hex, type Log, type TransactionReceipt} from "viem";
import {ENDPOINT_ABI, STARGATE_ABI, TOKEN_MESSAGING_ABI} from "../src/abi.js";
import {busPassengerPrefix, stargateBusPayout, stargateBusProof, stargateBusTicket} from "../src/bus.js";
import {createStargateTracker} from "../src/tracking.js";
import {parseStargateIntent} from "../src/intent.js";
import {stargateRegistry} from "../src/deployments.js";
import {setup, actor, recipient} from "./helpers/rpc.js";

const H = (n: number): Hex => toHex(BigInt(n), {size: 32});
const ZERO = H(0), GUID = H(99), SOURCE_HASH = H(1), DRIVE_HASH = H(2), DEST_HASH = H(3);
const blockHash = (n: bigint): Hex => toHex(n + 1000n, {size: 32});
function log(abi: Abi, name: string, args: Record<string, unknown>, address: Hex, tx: Hex, block: bigint, index: number): TransactionReceipt["logs"][number] {
  const event = getAbiItem({abi, name}) as AbiEvent;
  const inputs = event.inputs.filter((p) => !p.indexed);
  return {address, topics: encodeEventTopics({abi, eventName: name, args} as never) as [Hex, ...Hex[]], data: encodeAbiParameters(inputs, inputs.map((p) => args[p.name!]) as never), transactionHash: tx, blockNumber: block, blockHash: blockHash(block), transactionIndex: 0, logIndex: index, removed: false};
}
function receipt(logs: TransactionReceipt["logs"], tx: Hex, block: bigint): TransactionReceipt {
  return {logs, transactionHash: tx, blockNumber: block, blockHash: blockHash(block), status: "success"} as TransactionReceipt;
}
function wireLog(l: Log) { return {...l, blockNumber: toHex(l.blockNumber!), logIndex: toHex(l.logIndex!), transactionIndex: "0x0"}; }
function wireReceipt(r: TransactionReceipt) { return {...r, status: r.status === "success" ? "0x1" : "0x0", blockNumber: toHex(r.blockNumber), logs: r.logs.map(wireLog)}; }

/** Explicitly synthetic Bus evidence, including tickets above 2^64 and duplicate passengers. */
function busFixture() {
  const f = setup();
  const ticketId = (1n << 65n) + 7n, first = ticketId - 2n;
  const amountSD = 10_000_000n;
  const passenger = (to: Hex) => encodePacked(["uint16", "bytes32", "uint64", "bool"], [1, pad(to, {size: 32}), amountSD, false]);
  const passengers = [passenger(recipient), passenger(actor), passenger(recipient)];
  const intentId = ["stargate", 1, f.source.eid, f.destination.eid, 1, "bus", actor, recipient, f.request.amount, amountSD, 0].join(":");
  const intent = parseStargateIntent(intentId, stargateRegistry);
  const rode = (index: number) => log(TOKEN_MESSAGING_ABI, "BusRode", {dstEid: f.destination.eid, ticketId: first + BigInt(index), fare: 20n, passenger: passengers[index]}, f.source.tokenMessaging, index === 2 ? SOURCE_HASH : H(10 + index), index === 2 ? 10n : 9n, index === 2 ? 0 : index);
  const source = receipt([rode(2), log(STARGATE_ABI, "OFTSent", {guid: ZERO, dstEid: f.destination.eid, fromAddress: actor, amountSentLD: f.request.amount, amountReceivedLD: f.request.amount}, f.source.address, SOURCE_HASH, 10n, 1)], SOURCE_HASH, 10n);
  const message = concatHex([encodePacked(["uint8", "uint128", "uint128"], [2, 0n, 0n]), ...passengers]);
  const packet = concatHex([encodePacked(["uint8", "uint64", "uint32", "bytes32", "uint32", "bytes32", "bytes32"], [1, 123n, f.source.eid, pad(f.source.tokenMessaging, {size: 32}), f.destination.eid, pad(f.destination.tokenMessaging, {size: 32}), GUID]), message]);
  const drive = receipt([
    log(ENDPOINT_ABI, "PacketSent", {encodedPayload: packet, options: "0x", sendLibrary: actor}, f.source.endpoint, DRIVE_HASH, 20n, 0),
    log(TOKEN_MESSAGING_ABI, "BusDriven", {dstEid: f.destination.eid, startTicketId: first, numPassengers: 3, guid: GUID}, f.source.tokenMessaging, DRIVE_HASH, 20n, 1),
  ], DRIVE_HASH, 20n);
  const paid = (seat: number) => log(STARGATE_ABI, "OFTReceived", {guid: GUID, srcEid: f.source.eid, toAddress: seat === 1 ? actor : recipient, amountReceivedLD: amountSD}, f.destination.address, DEST_HASH, 30n, seat);
  const cached = (seat: number) => log(STARGATE_ABI, "UnreceivedTokenCached", {guid: GUID, index: seat, srcEid: f.source.eid, receiver: seat === 1 ? actor : recipient, amountLD: amountSD, composeMsg: "0x"}, f.destination.address, DEST_HASH, 30n, seat);
  const destination = receipt([paid(0), paid(1), paid(2)], DEST_HASH, 30n);
  const ticket = stargateBusTicket(intent, source), proof = stargateBusProof(ticket, drive);
  const previous = H(8);
  let last = previous;
  for (const p of passengers) last = keccak256(concatHex([last, p]));
  const rows = passengers.map((passenger, index) => ({ticketId: first + BigInt(index), passenger}));
  return {...f, first, ticketId, passengers, intentId, intent, sourceReceipt: source, driveReceipt: drive, destinationReceipt: destination, paid, cached, rode, ticket, proof, previous, last, rows, ref: {intentId, sourceTxHash: SOURCE_HASH}};
}

function busServer() {
  const f = busFixture();
  const state = {driven: false, first: f.first, maxPassengers: 16, driveFee: 100n, destination: f.destinationReceipt, cache: ZERO, payload: ZERO, tamperQueue: false};
  f.state.feeSD = 0n;
  f.state.override = (r, value) => {
    if (r.functionName === "busQueues") return [state.maxPassengers, 20n, 30n, 3, state.first];
    if (r.functionName === "queueCapacity") return 512;
    if (r.functionName === "getPassengerHash") return BigInt(String(r.args[1])) === f.ticketId % 512n ? f.last : f.previous;
    if (r.functionName === "quoteDriveBus") return {nativeFee: state.driveFee, lzTokenFee: 0n};
    if (r.functionName === "unreceivedTokens") return BigInt(String(r.args[1])) === 2n ? state.cache : ZERO;
    return value;
  };
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).startsWith("https://scan.test")) return Response.json({data: state.driven ? [{guid: GUID, destination: {tx: {txHash: DEST_HASH}}, status: {name: "DELIVERED"}}] : []});
    const body = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]};
    let result: unknown;
    if (body.method === "eth_getTransactionReceipt") {
      const r = body.params[0] === SOURCE_HASH ? f.sourceReceipt : body.params[0] === DRIVE_HASH ? f.driveReceipt : state.destination;
      result = wireReceipt(r);
    } else if (body.method === "eth_getBlockByNumber") {
      const number = body.params[0] === "latest" || body.params[0] === "finalized" ? 100n : BigInt(String(body.params[0]));
      result = {number: toHex(number), hash: blockHash(number), timestamp: toHex(BigInt(Math.floor(Date.now() / 1000))), transactions: []};
    } else if (body.method === "eth_blockNumber") result = "0x64";
    else if (body.method === "eth_getLogs") {
      const q = body.params[0] as {topics: Hex[]};
      const driveTopic = f.driveReceipt.logs[1]!.topics[0];
      const logs = q.topics[0] === driveTopic ? state.driven ? [f.driveReceipt.logs[1]!] : [] : [f.rode(0), f.rode(1), f.rode(2)];
      result = logs.map(wireLog);
      if (state.tamperQueue && q.topics[0] !== driveTopic) result = [wireLog(f.rode(2))];
    } else if (body.method === "eth_call") {
      const call = body.params[0] as {data: Hex};
      try {
        const decoded = decodeFunctionData({abi: ENDPOINT_ABI, data: call.data});
        if (decoded.functionName === "inboundPayloadHash") result = state.payload;
      } catch { /* normal pool/messaging read */ }
      if (result === undefined) return f.config.fetchImpl(url, init);
    } else return f.config.fetchImpl(url, init);
    return Response.json({id: body.id, jsonrpc: "2.0", result});
  };
  const tracker = createStargateTracker({...f.config, fetchImpl, scanUrl: "https://scan.test", busLogPages: 1});
  return {...f, tracker, control: state};
}

describe("Bus passenger proofs and paid queue recovery (synthetic)", () => {
  it("keeps uint72 ticket identity and authenticates its exact seat", () => {
    const f = busFixture();
    expect(f.ticket.ticketId).toBeGreaterThan(1n << 64n);
    expect(f.proof.seat).toBe(2);
    expect(f.proof.guid).toBe(GUID);
    expect(stargateBusPayout(f.proof, f.destinationReceipt)).toBe("paid");
    expect(() => stargateBusProof({...f.ticket, ticketId: f.ticketId + 1n}, f.driveReceipt)).toThrow(/covered/);
    expect(() => stargateBusProof({...f.ticket, passenger: f.passengers[1]!}, f.driveReceipt)).toThrow(/passenger/);
  });

  it("does not confuse two identical passengers when only one was paid", () => {
    const f = busFixture();
    const firstPaid = {...f.destinationReceipt, logs: [f.paid(0), f.paid(1), f.cached(2)]};
    expect(stargateBusPayout(f.proof, firstPaid)).toBe("cached");
    const lastPaid = {...f.destinationReceipt, logs: [f.cached(0), f.paid(1), f.paid(2)]};
    expect(stargateBusPayout(f.proof, lastPaid)).toBe("paid");
    expect(stargateBusPayout(f.proof, {...f.destinationReceipt, logs: [f.paid(0)]})).toBeNull();
    expect(stargateBusPayout(f.proof, {...f.destinationReceipt, logs: [f.paid(0), f.paid(1), f.cached(0)]})).toBeNull();
  });

  it("requires the continuous queue prefix and its live hash-chain commitment", () => {
    const f = busFixture();
    expect(busPassengerPrefix(f.rows, f.first, 3, f.previous, f.last, f.ticket)).toBe(concatHex(f.passengers));
    for (const rows of [f.rows.slice(1), [...f.rows, f.rows[0]!], [f.rows[0]!, f.rows[1]!, {...f.rows[2]!, passenger: f.passengers[1]!}]]) expect(() => busPassengerPrefix(rows, f.first, 3, f.previous, f.last, f.ticket)).toThrow();
    expect(() => busPassengerPrefix(f.rows, f.first, 3, ZERO, f.last, f.ticket)).toThrow(/hash chain/);
    expect(() => busPassengerPrefix(f.rows, f.first, 2, f.previous, f.last, f.ticket)).toThrow(/include/);
  });

  it("tracks queued → driven → specific finalized payout", async () => {
    const f = busServer();
    expect(await f.tracker.trackIntent(f.ref)).toEqual({state: "pending", depositReceived: true});
    f.control.driven = true;
    expect(await f.tracker.trackIntent(f.ref)).toEqual({state: "completed", depositReceived: true, destTxHash: DEST_HASH});
    f.control.destination = {...f.destinationReceipt, logs: [f.paid(0), f.paid(1), f.cached(2)]};
    f.control.cache = keccak256(encodePacked(["uint32", "address", "uint256", "bytes"], [f.source.eid, recipient, f.proof.amount, "0x"]));
    expect((await f.tracker.trackIntent(f.ref)).state).toBe("action-required");
    const [recovery] = await f.tracker.getRecoveryQuotes(f.ref);
    expect(recovery?.id).toBe(`${GUID}:retry-token:2`);
    expect(decodeFunctionData({abi: STARGATE_ABI, data: recovery!.tx.data as Hex})).toMatchObject({functionName: "retryReceiveToken", args: [GUID, 2, f.source.eid, recipient, f.proof.amount, "0x"]});
  });

  it("quotes a separate payment for the whole prefix, never just the user's seat", async () => {
    const f = busServer();
    const [q] = await f.tracker.getRecoveryQuotes(f.ref);
    expect(q).toMatchObject({kind: "drive-bus", tx: {chain: f.source.chain, to: f.source.tokenMessaging, value: "100"}});
    expect(decodeFunctionData({abi: TOKEN_MESSAGING_ABI, data: q!.tx.data as Hex})).toMatchObject({functionName: "driveBus", args: [f.destination.eid, concatHex(f.passengers)]});
    expect(await f.tracker.verifyRecovery(f.ref, q!, actor)).toBeNull();
    expect(await f.tracker.verifyRecovery(f.ref, {...q!, tx: {...q!.tx, value: "101"}}, actor)).not.toBeNull();
    f.control.driveFee = 101n;
    expect(await f.tracker.verifyRecovery(f.ref, q!, actor)).not.toBeNull();
    f.control.first = f.ticketId + 1n;
    expect(await f.tracker.getRecoveryQuotes(f.ref)).toEqual([]);
    expect(await f.tracker.verifyRecovery(f.ref, q!, actor)).not.toBeNull();
  });

  it("does not offer a drive that cannot include this ticket or has incomplete indexed bytes", async () => {
    const f = busServer();
    f.control.maxPassengers = 2;
    expect(await f.tracker.getRecoveryQuotes(f.ref)).toEqual([]);
    f.control.maxPassengers = 16;
    f.control.tamperQueue = true;
    expect(await f.tracker.getRecoveryQuotes(f.ref)).toEqual([]);
  });
});
