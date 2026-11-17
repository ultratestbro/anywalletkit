import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {pad, parseAbi, parseEventLogs, slice, type Hex, type Log} from "viem";
import {STARGATE_ABI} from "../src/abi.js";
import {destinationAmount} from "../src/amounts.js";
import {stargateRegistry} from "../src/deployments.js";

type Side = {chain: string; block: {number: string; hash: Hex}; transaction: {hash: Hex}; receipt: {status: string; transactionHash: Hex; blockNumber: string; blockHash: Hex; logs: Log[]}};
const fixture = JSON.parse(readFileSync(new URL("./fixtures/receipts.json", import.meta.url), "utf8")) as {
  kind: string; transfers: {name: string; guid: Hex; assetId: number; discovery: {payload: Hex}; source: Side; destination: Side}[];
};
const endpointAbi = parseAbi(["event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)"]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

describe("historical mainnet Taxi delivery evidence", () => {
  it("covers native/ERC20 pools, unequal decimals and both Hydra directions", () => {
    expect(fixture.kind).toBe("historical-mainnet-receipts");
    expect(fixture.transfers.map((t) => t.name)).toEqual(["native-pool-to-pool", "erc20-pool-to-pool", "local-decimals-18-to-6", "hydra-oft-to-pool", "hydra-pool-to-oft"]);
    const kinds = fixture.transfers.map((t) => [t.source, t.destination].map((s) => stargateRegistry.deployments.find((d) => d.chain === s.chain && d.assetId === t.assetId)!.kind));
    expect(kinds).toEqual([["native", "native"], ["pool", "pool"], ["pool", "pool"], ["oft", "pool"], ["native", "oft"]]);
  });

  for (const transfer of fixture.transfers) {
    it(`${transfer.name}: links the authenticated packet to the destination pool payout`, () => {
      const src = stargateRegistry.deployments.find((d) => d.chain === transfer.source.chain && d.assetId === transfer.assetId)!;
      const dst = stargateRegistry.deployments.find((d) => d.chain === transfer.destination.chain && d.assetId === transfer.assetId)!;
      for (const side of [transfer.source, transfer.destination]) {
        expect(side.receipt.status).toBe("success");
        expect(side.receipt.transactionHash).toBe(side.transaction.hash);
        expect(side.receipt.blockHash).toBe(side.block.hash);
        expect(side.receipt.blockNumber).toBe(side.block.number);
        for (const log of side.receipt.logs) {
          expect(log.removed).toBe(false);
          expect(log.transactionHash).toBe(side.transaction.hash);
          expect(log.blockHash).toBe(side.block.hash);
        }
      }
      const sent = parseEventLogs({abi: STARGATE_ABI, eventName: "OFTSent", logs: transfer.source.receipt.logs.filter((l) => same(l.address, src.address)), strict: true}).filter((l) => l.args.guid === transfer.guid);
      const received = parseEventLogs({abi: STARGATE_ABI, eventName: "OFTReceived", logs: transfer.destination.receipt.logs.filter((l) => same(l.address, dst.address)), strict: true}).filter((l) => l.args.guid === transfer.guid);
      expect(sent).toHaveLength(1); expect(received).toHaveLength(1);
      const a = sent[0]!.args, b = received[0]!.args;
      expect(a.dstEid).toBe(dst.eid); expect(b.srcEid).toBe(src.eid);
      expect(a.amountSentLD).toBeGreaterThan(0n);
      expect(destinationAmount(a.amountReceivedLD, src.localDecimals, dst.localDecimals, src.sharedDecimals)).toBe(b.amountReceivedLD);
      if (transfer.name === "local-decimals-18-to-6") expect(a.amountReceivedLD).toBe(b.amountReceivedLD * 10n ** 12n);
      const packets = parseEventLogs({abi: endpointAbi, logs: transfer.source.receipt.logs.filter((l) => same(l.address, src.endpoint)), strict: true}).filter((l) => slice(l.args.encodedPayload, 81, 113) === transfer.guid);
      expect(packets).toHaveLength(1);
      const packet = packets[0]!.args.encodedPayload;
      expect(slice(packet, 0, 1)).toBe("0x01");
      expect(BigInt(slice(packet, 9, 13))).toBe(BigInt(src.eid));
      expect(BigInt(slice(packet, 45, 49))).toBe(BigInt(dst.eid));
      expect(slice(packet, 13, 45)).toBe(pad(src.tokenMessaging.toLowerCase() as Hex, {size: 32}));
      expect(slice(packet, 49, 81)).toBe(pad(dst.tokenMessaging.toLowerCase() as Hex, {size: 32}));
      const payload = slice(packet, 113);
      expect(payload).toBe(transfer.discovery.payload);
      expect(payload).toHaveLength(88); expect(slice(payload, 0, 1)).toBe("0x01");
      expect(BigInt(slice(payload, 1, 3))).toBe(BigInt(transfer.assetId));
      expect(slice(payload, 3, 35)).toBe(pad(b.toAddress.toLowerCase() as Hex, {size: 32}));
      expect(BigInt(slice(payload, 35, 43)) * 10n ** BigInt(dst.localDecimals - dst.sharedDecimals)).toBe(b.amountReceivedLD);
    });
  }
});
