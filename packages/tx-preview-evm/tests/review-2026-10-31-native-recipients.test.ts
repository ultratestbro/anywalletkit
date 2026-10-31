import {describe, expect, it} from "vitest";
import {previewEvmTx, type Rpc} from "../src/index.js";

// Every plain native transfer of a batch (no selector, value > 0) is a recipient, not only the last call.
// Offline: the RPC is a stub (eth_simulateV1 "ok" for every call, no logs).

const ME = "0x8abe813577e47415a3cd0bbc68c7abca2c4c55ba";
const STRANGER = "0x91c4d2aa6e15f0a7b3c9d8e7f6a5b4c3d2e1e07a";
const OTHER = "0x00000000000000000000000000000000000e0b11";

const rpc: Rpc = async (method, params) => {
  if (method === "eth_getBlockByNumber") return {number: "0x10", timestamp: "0x6543"};
  if (method === "eth_simulateV1") {
    const calls = (params[0] as {blockStateCalls: {calls: unknown[]}[]}).blockStateCalls[0]!.calls;
    return [{calls: calls.map(() => ({status: "0x1", gasUsed: "0x5208", logs: []}))}];
  }
  throw Object.assign(new Error(`the method ${method} does not exist`), {code: -32601});
};
const preview = (calls: Array<{to: string; value?: bigint}>) => previewEvmTx({chainId: 1, from: ME, own: [ME], rpc, calls});
const recipientChecks = (p: Awaited<ReturnType<typeof preview>>) => p.checks.filter((c) => c.code.startsWith("recipient-"));

describe("native recipients across a batch", () => {
  it("control: the foreign transfer as the last call is a recipient-foreign warning", async () => {
    const p = await preview([{to: ME, value: 1n}, {to: STRANGER, value: 10n ** 18n}]);
    expect(p.checks).toContainEqual({code: "recipient-foreign", status: "warn", detail: {address: STRANGER}});
  });

  it("[foreign 1 ETH, own 1 wei]: the foreign recipient is still a warning, the own one ok", async () => {
    const p = await preview([{to: STRANGER, value: 10n ** 18n}, {to: ME, value: 1n}]);
    expect(p.checks).toContainEqual({code: "recipient-foreign", status: "warn", detail: {address: STRANGER}});
    expect(p.checks).toContainEqual({code: "recipient-own", status: "ok", detail: {address: ME}});
  });

  it("every native leg, lowercased and once each", async () => {
    const p = await preview([{to: STRANGER.toUpperCase().replace("0X", "0x"), value: 1n}, {to: OTHER, value: 2n}, {to: STRANGER, value: 3n}, {to: ME, value: 0n}]);
    expect(recipientChecks(p)).toEqual([
      {code: "recipient-foreign", status: "warn", detail: {address: STRANGER}},
      {code: "recipient-foreign", status: "warn", detail: {address: OTHER}},
    ]);
  });

  it("control: a zero-value call is no recipient", async () => {
    expect(recipientChecks(await preview([{to: STRANGER, value: 0n}]))).toEqual([]);
  });
});
