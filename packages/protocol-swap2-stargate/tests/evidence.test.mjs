import {beforeEach, describe, expect, it, vi} from "vitest";
import {encodeFunctionResult, parseAbi} from "viem";
import {context} from "../scripts/evidence.mjs";

const {client} = vi.hoisted(() => ({client: {getChainId: vi.fn(), getBlockNumber: vi.fn(), getBlock: vi.fn(), call: vi.fn()}}));
vi.mock("viem", async (original) => ({...await original(), createPublicClient: () => client}));
const hash = `0x${"12".repeat(32)}`;
const address = "0x0000000000000000000000000000000000000001";
const abi = parseAbi(["function decimals() view returns (uint8)"]);

beforeEach(() => {
  vi.resetAllMocks();
  client.getChainId.mockResolvedValue(8453);
  client.getBlockNumber.mockResolvedValue(1024n);
  client.getBlock.mockResolvedValue({number: 1000n, hash, timestamp: 1n});
  client.call.mockResolvedValue({data: encodeFunctionResult({abi, functionName: "decimals", result: 6})});
});

describe("read-only evidence collection failures", () => {
  it("pins every call to a recorded block and stores raw response bytes", async () => {
    const ctx = await context("eip155:8453", 8453, ["https://example.invalid"]);
    expect(await ctx.read(address, abi, "decimals")).toBe(6);
    expect(client.call).toHaveBeenCalledWith(expect.objectContaining({blockNumber: 1000n}));
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].result).toBe(encodeFunctionResult({abi, functionName: "decimals", result: 6}));
    expect(ctx.block.hash).toBe(hash);
  });
  it("refuses a wrong-chain RPC before contract reads", async () => {
    client.getChainId.mockResolvedValue(1);
    await expect(context("eip155:8453", 8453, ["https://example.invalid"])).rejects.toThrow("wrong-rpc-chain");
    expect(client.call).not.toHaveBeenCalled();
  });
  it("detects a changed block hash before publication", async () => {
    const ctx = await context("eip155:8453", 8453, ["https://example.invalid"]);
    client.getBlock.mockResolvedValue({number: 1000n, hash: `0x${"34".repeat(32)}`});
    await expect(ctx.checkBlock()).rejects.toThrow("block-changed");
  });
  it("refuses a block response for a different height", async () => {
    client.getBlock.mockResolvedValue({number: 999n, hash, timestamp: 1n});
    await expect(context("eip155:8453", 8453, ["https://example.invalid"])).rejects.toThrow("missing-block-identity");
  });
  it("never turns a failed read into verified evidence or retains provider error bodies", async () => {
    const ctx = await context("eip155:8453", 8453, ["https://example.invalid"]);
    client.call.mockRejectedValue(new Error("https://rpc.invalid/secret-api-key"));
    await expect(ctx.read(address, abi, "decimals")).rejects.toThrow(/^rpc-call-or-decode:decimals$/);
    expect(ctx.calls).toEqual([]);
    client.getChainId.mockRejectedValue(new Error("https://rpc.invalid/secret-api-key"));
    await expect(context("eip155:8453", 8453, ["https://example.invalid"])).rejects.toThrow(/^rpc-unavailable$/);
  });
  it("does not record empty or malformed ABI responses", async () => {
    const ctx = await context("eip155:8453", 8453, ["https://example.invalid"]);
    for (const data of [undefined, "0x", "0x12"]) {
      client.call.mockResolvedValue({data});
      await expect(ctx.read(address, abi, "decimals")).rejects.toThrow();
    }
    expect(ctx.calls).toEqual([]);
  });
});
