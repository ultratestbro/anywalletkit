import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {describeActivitySuite, parseActivityFixture, type ActivityFixtureJson} from "@anywalletkit/conformance";
import {parseEventLogs, type Hex, type Log} from "viem";
import {STARGATE_ABI} from "../src/abi.js";
import {describeStargateActivity} from "../src/activity.js";
import {stargateRegistry} from "../src/deployments.js";
import {StargateSwap2Protocol} from "../src/protocol.js";
import {setup} from "./helpers/rpc.js";

type Side = {chain: string; block: {number: string; timestamp: string}; transaction: {hash: string; from: string; to: string; input: string; value: string}; receipt: {status: string; gasUsed?: string; effectiveGasPrice?: string; logs: Log[]}};
const taxi = JSON.parse(readFileSync(new URL("./fixtures/receipts.json", import.meta.url), "utf8")) as {transfers: {name: string; source: Side; destination: Side}[]};
const bus = JSON.parse(readFileSync(new URL("./fixtures/bus-receipts.json", import.meta.url), "utf8")) as {buses: {guid: string; drive: Side; destination: Side; riders: {source: Side}[]}[]};
function fixture(side: Side, owner: string, title: string, incoming: boolean, token: string | null, amount: bigint): ActivityFixtureJson {
  const tx = side.transaction;
  return {note: `Historical receipt ${tx.hash}`, own: [owner], tx: {chain: side.chain, hash: tx.hash, time: parseInt(side.block.timestamp, 10), status: "confirmed", address: owner, from: tx.from, to: tx.to, nativeValue: tx.value, block: side.block.number, ...(side.receipt.gasUsed !== undefined && side.receipt.effectiveGasPrice !== undefined ? {fee: String(BigInt(side.receipt.gasUsed) * BigInt(side.receipt.effectiveGasPrice))} : {}), call: {to: tx.to, data: tx.input}, transfers: [], raw: {source: "alchemy", tx: {tx, receipt: side.receipt}, tokens: [], internal: []}}, expect: {kind: "bridge", title, ...(incoming ? {assetsIn: [{token, amount: String(amount)}]} : {assetsOut: [{token, amount: String(amount)}]})}};
}
const fixtures: ActivityFixtureJson[] = [];
for (const side of [...taxi.transfers.flatMap((t) => [t.source, t.destination]), ...bus.buses.flatMap((b) => [b.destination, ...b.riders.map((r) => r.source)])]) {
  for (const d of stargateRegistry.deployments.filter((d) => d.chain === side.chain)) {
    const events = parseEventLogs({abi: STARGATE_ABI, logs: side.receipt.logs.filter((l) => l.address.toLowerCase() === d.address.toLowerCase()), strict: true});
    for (const event of events) {
      const token = d.kind === "native" ? null : d.token;
      if (event.eventName === "OFTSent" && event.args.fromAddress.toLowerCase() === side.transaction.from.toLowerCase()) fixtures.push(fixture(side, side.transaction.from, /^0x0{64}$/.test(event.args.guid) ? "Queued" : "Bridged", false, token, event.args.amountSentLD));
      if (event.eventName === "OFTReceived") fixtures.push(fixture(side, event.args.toAddress, "Received", true, token, event.args.amountReceivedLD));
    }
  }
}
const config = {...setup().config, fromChain: "eip155:8453", skipAccountChainCheck: true};
describeActivitySuite("Stargate receipt-backed history", {Protocol: StargateSwap2Protocol, config, fixtures});

describe("Stargate history attribution", () => {
  it("rejects removed, foreign, unordered or mismatched-block receipt logs", () => {
    const {tx, own} = parseActivityFixture(fixtures[0]!);
    expect(describeStargateActivity(tx, {own})).not.toBeNull();
    const raw = tx.raw as {tx: {receipt: Side["receipt"]}};
    for (const logs of [raw.tx.receipt.logs.map((l) => ({...l, removed: true})), raw.tx.receipt.logs.map((l) => ({...l, transactionHash: `0x${"ab".repeat(32)}`})), [...raw.tx.receipt.logs].reverse()]) {
      expect(describeStargateActivity({...tx, raw: {tx: {receipt: {...raw.tx.receipt, logs}}}}, {own})).toBeNull();
    }
    expect(describeStargateActivity({...tx, block: 1n}, {own})).toBeNull();
    expect(describeStargateActivity(tx, {own: new Set(["0x1111111111111111111111111111111111111111"])})).toBeNull();
  });

  it("does not infer delivery from a plain pool transfer or a cached-token event", () => {
    const f = fixtures.find((f) => f.expect.assetsIn)!;
    const {tx, own} = parseActivityFixture(f);
    expect(describeStargateActivity({...tx, raw: undefined}, {own})).toBeNull();
    const receipt = (tx.raw as {tx: {receipt: Side["receipt"]}}).tx.receipt;
    const payouts = parseEventLogs({abi: STARGATE_ABI, eventName: "OFTReceived", logs: receipt.logs}).map((l) => l.logIndex);
    expect(describeStargateActivity({...tx, raw: {tx: {receipt: {...receipt, logs: receipt.logs.filter((l) => l.logIndex === null || !payouts.includes(l.logIndex))}}}}, {own})).toBeNull();
  });

  it("does not charge the destination executor's gas to the recipient", () => {
    const f = fixtures.find((f) => f.expect.assetsIn && f.own[0]!.toLowerCase() !== f.tx.from.toLowerCase())!;
    const {tx, own} = parseActivityFixture(f);
    // Synthetic gas enrichment: the recorded receipt need not include gas metadata.
    expect(describeStargateActivity({...tx, fee: 1000n}, {own})?.fee).toBeUndefined();
  });

  it("records an owned Bus drive as a separate payment without claiming a payout", () => {
    const side = bus.buses[0]!.drive;
    const f = fixture(side, side.transaction.from, "Advanced", false, null, 0n);
    const {tx, own} = parseActivityFixture(f);
    expect(describeStargateActivity(tx, {own})).toMatchObject({title: "Advanced Stargate Bus", assetsIn: [], assetsOut: [], fee: tx.fee! + tx.nativeValue});
    expect(describeStargateActivity({...tx, to: "0x1111111111111111111111111111111111111111" as Hex}, {own})).toBeNull();
  });
});
