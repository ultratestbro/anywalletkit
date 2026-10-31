import {describe, expect, it} from "vitest";
import {previewEvmTx, type Rpc} from "../src/index.js";

// Without eth_simulateV1 the eth_call fallback says "reverted" only on evidence that the EVM reverted;
// a dropped connection or a node error is "unavailable". Offline stub RPC.

const ME = "0x8abe813577e47415a3cd0bbc68c7abca2c4c55ba";
const TARGET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const NOPE = "0x08c379a0" + (32n).toString(16).padStart(64, "0") + (4n).toString(16).padStart(64, "0") + "6e6f706500000000000000000000000000000000000000000000000000000000";

const stub = (onCall: () => unknown): Rpc => async (method) => {
  if (method === "eth_getBlockByNumber") return {number: "0x10", timestamp: "0x6543"};
  if (method === "eth_simulateV1") throw Object.assign(new Error("the method eth_simulateV1 does not exist"), {code: -32601});
  if (method === "eth_call") return onCall();
  throw new Error(`unexpected ${method}`);
};
const fails = (err: unknown) => stub(() => { throw err; });
const preview = (rpc: Rpc) => previewEvmTx({chainId: 1, from: ME, own: [ME], rpc, calls: [{to: TARGET, data: ("0xa9059cbb" + "00".repeat(64)) as `0x${string}`}]});

describe("eth_call fallback: reverted needs revert evidence", () => {
  it("control: a real revert (code 3, Error(string) data) is simulation-reverted with its reason", async () => {
    const p = await preview(fails(Object.assign(new Error("execution reverted: nope"), {code: 3, data: NOPE})));
    expect(p.simulation).toMatchObject({status: "reverted", reason: "nope"});
    expect(p.checks.find((c) => c.code === "simulation-reverted")?.status).toBe("warn");
  });

  it("revert data nested in the cause chain (viem-shaped) is reverted with its reason", async () => {
    const inner = Object.assign(new Error("RPC error"), {code: -32000, data: {data: NOPE}});
    const p = await preview(fails(Object.assign(new Error("Execution reverted for an unknown reason."), {name: "CallExecutionError", cause: inner})));
    expect(p.simulation).toMatchObject({status: "reverted", reason: "nope"});
  });

  it.each([
    ["code 3 without data", Object.assign(new Error("execution reverted"), {code: 3})],
    ["-32000 saying so", Object.assign(new Error("VM execution error"), {code: -32000})],
    ["viem's ExecutionRevertedError in the cause", Object.assign(new Error("call failed"), {cause: Object.assign(new Error("reverted"), {name: "ExecutionRevertedError"})})],
  ])("%s is reverted", async (_, err) => {
    expect((await preview(fails(err))).simulation.status).toBe("reverted");
  });

  it.each([
    ["fetch failed / ECONNRESET", new TypeError("fetch failed: ECONNRESET")],
    ["a timeout", Object.assign(new Error("The request took too long to respond."), {name: "TimeoutError"})],
    ["an internal node error", Object.assign(new Error("internal error"), {code: -32603})],
    ["-32000 about something else", Object.assign(new Error("header not found"), {code: -32000})],
    ["a rate limit", Object.assign(new Error("Too Many Requests"), {code: 429})],
  ])("%s is simulation-unavailable, not reverted", async (_, err) => {
    const p = await preview(fails(err));
    expect(p.simulation.status).toBe("unavailable");
    expect(p.checks.find((c) => c.code === "simulation-unavailable")?.status).toBe("unknown");
    expect(p.checks.some((c) => c.code === "simulation-reverted")).toBe(false);
  });
});
