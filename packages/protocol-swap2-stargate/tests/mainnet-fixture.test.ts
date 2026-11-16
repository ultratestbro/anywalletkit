import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {decodeErrorResult, decodeFunctionData, decodeFunctionResult, encodeFunctionResult, parseAbi, type Abi, type Hex} from "viem";
import {STARGATE_ABI, TOKEN_MESSAGING_ABI} from "../src/abi.js";
import {destinationAmount, sourceMinimum, splitFeeDetails} from "../src/amounts.js";

type Deployment = {chain: string; assetId: string; address: string; token: string; native: boolean; approvalRequired: boolean; localDecimals: number; sharedDecimals: number; eid: number};
type Route = {
  source: string; destination: string; assetId: string; mode: string; amountLD: string;
  sourceDeployment: string; destinationDeployment: string; destinationAmountLD?: string;
  receipt?: {amountSentLD: string; amountReceivedLD: string};
  feeDetails?: {feeAmountLD: string}[];
  fee?: {nativeFee: string; lzTokenFee: string};
  unavailable?: {functionName: string; revertData: Hex; errorName: string; args: boolean[]};
};
const snapshot = JSON.parse(readFileSync(new URL("./fixtures/mainnet.json", import.meta.url), "utf8")) as {
  schemaVersion: number; kind: string; upstreamCommit: string;
  blocks: Record<string, {number: string; hash: Hex}>;
  deployments: Record<string, Deployment>; routes: Route[];
  calls: {chain: string; blockNumber: string; to: string; from: string; functionName: string; data: Hex; result?: Hex; error?: {kind: string; data: Hex}}[];
};
const abi: Abi = [...STARGATE_ABI, ...TOKEN_MESSAGING_ABI, ...parseAbi(["function decimals() view returns (uint8)", "function eid() view returns (uint32)"])];

describe("recorded read-only mainnet evidence (offline)", () => {
  it("records chain block identities and the pinned ABI revision", () => {
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.kind).toBe("mainnet-read-only");
    expect(snapshot.upstreamCommit).toBe("414f47412123d7737520c6ba331c1376ec874a88");
    expect(Object.keys(snapshot.blocks).sort()).toEqual(["arbitrum", "base", "bsc"]);
    for (const block of Object.values(snapshot.blocks)) {
      expect(BigInt(block.number)).toBeGreaterThan(0n);
      expect(block.hash).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it("replays every raw eth_call result or revert using the pinned interfaces", () => {
    expect(snapshot.calls.length).toBeGreaterThan(70);
    for (const call of snapshot.calls) {
      expect(call.blockNumber).toBe(snapshot.blocks[call.chain]!.number);
      const request = decodeFunctionData({abi, data: call.data});
      expect(request.functionName).toBe(call.functionName);
      if (call.error) {
        expect(call.functionName).toBe("quoteSend");
        expect(call.error.kind).toBe("reverted");
        const failure = decodeErrorResult({abi, data: call.error.data});
        expect(failure.errorName).toBe("Bus_InvalidFare");
        expect(failure.args).toEqual([false]);
      } else {
        expect(call.result).toBeDefined();
        const result = decodeFunctionResult({abi, functionName: call.functionName, data: call.result!});
        expect(encodeFunctionResult({abi, functionName: call.functionName, result})).toBe(call.result);
      }
    }
  });

  it("keeps a native pool's true approval flag separate from ERC20 approval requirements", () => {
    const native = snapshot.deployments["base:13"]!;
    expect(native.native).toBe(true);
    expect(native.token.toLowerCase()).toBe("0x0000000000000000000000000000000000000000");
    expect(native.approvalRequired).toBe(true);
  });

  it("preserves unavailable Bus observations rather than synthesizing successful quotes", () => {
    expect(snapshot.routes).toHaveLength(8);
    expect(snapshot.routes.filter((r) => !r.unavailable)).toHaveLength(4);
    for (const route of snapshot.routes.filter((r) => r.mode === "bus")) {
      expect(route.unavailable).toMatchObject({functionName: "quoteSend", errorName: "Bus_InvalidFare", args: [false]});
      expect(route.destinationAmountLD).toBeUndefined();
      expect(route.fee).toBeUndefined();
    }
  });

  for (const route of snapshot.routes.filter((r) => !r.unavailable)) {
    it(`${route.source} -> ${route.destination} asset ${route.assetId}: receipt, fee and unit conversion`, () => {
      const src = snapshot.deployments[route.sourceDeployment]!;
      const dst = snapshot.deployments[route.destinationDeployment]!;
      const recordedQuote = snapshot.calls.find((c) => {
        if (c.chain !== route.source || c.to.toLowerCase() !== src.address.toLowerCase() || c.functionName !== "quoteOFT") return false;
        const {args} = decodeFunctionData({abi: STARGATE_ABI, data: c.data});
        const param = args?.[0] as {dstEid?: number; amountLD?: bigint; oftCmd?: string} | undefined;
        return param?.dstEid === dst.eid && param.amountLD === BigInt(route.amountLD) && param.oftCmd === "0x";
      });
      expect(recordedQuote?.result).toBeDefined();
      const [, details, receipt] = decodeFunctionResult({abi: STARGATE_ABI, functionName: "quoteOFT", data: recordedQuote!.result!});
      expect(receipt.amountSentLD.toString()).toBe(route.receipt!.amountSentLD);
      expect(receipt.amountReceivedLD.toString()).toBe(route.receipt!.amountReceivedLD);
      const accounting = splitFeeDetails(details);
      expect(receipt.amountSentLD - accounting.feeLD + accounting.rewardLD).toBe(receipt.amountReceivedLD);
      const output = destinationAmount(receipt.amountReceivedLD, src.localDecimals, dst.localDecimals, src.sharedDecimals);
      expect(output.toString()).toBe(route.destinationAmountLD);
      expect(sourceMinimum(output, src.localDecimals, dst.localDecimals, src.sharedDecimals)).toBe(receipt.amountReceivedLD);
      expect(BigInt(route.fee!.nativeFee)).toBeGreaterThan(0n);
      expect(route.fee!.lzTokenFee).toBe("0");
    });
  }
});
