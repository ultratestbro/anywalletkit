import {describe, expect, it} from "vitest";
import {HttpRequestError, InvalidInputRpcError, MethodNotFoundRpcError, MethodNotSupportedRpcError, RpcRequestError, InternalRpcError} from "viem";
import {previewEvmTx, simulateUnsupported, type Rpc} from "../src/index.js";

const URL_ = "https://rpc.example";
const body = {method: "eth_simulateV1", params: []};
const rpcErr = (code: number, message: string) => new RpcRequestError({body, error: {code, message}, url: URL_});
const ME = "0x8abe813577e47415a3cd0bbc68c7abca2c4c55ba";

describe("eth_simulateV1 unsupported — structured first, bounded text (scan F23)", () => {
  it("classifies the measured node responses as unsupported", () => {
    // -32601 (Avalanche, Hyperliquid, MegaETH, Linea official, Arc, Morph, Flare)
    expect(simulateUnsupported(new MethodNotFoundRpcError(rpcErr(-32601, "the method eth_simulateV1 does not exist/is not available"), {method: "eth_simulateV1"}))).toBe(true);
    expect(simulateUnsupported(Object.assign(new Error("Method not found"), {code: -32601}))).toBe(true);
    expect(simulateUnsupported(new MethodNotSupportedRpcError(rpcErr(-32004, "x"), {method: "eth_simulateV1"}))).toBe(true);
    // HTTP 403 with a -32601 JSON body (zkSync, Celo, Unichain official, Sei, X Layer)
    expect(simulateUnsupported(new HttpRequestError({status: 403, url: URL_, body, details: JSON.stringify({code: -32601, message: "Unsupported method: eth_simulateV1"})}))).toBe(true);
    expect(simulateUnsupported(new HttpRequestError({status: 403, url: URL_, body, details: '{"jsonrpc":"2.0","id":1,"error":{"code": -32601,"message":"rpc method is not whitelisted"}}'}))).toBe(true);
    // Monad: -32000 "`validation: false` is not supported yet" keeps its eth_call fallback
    expect(simulateUnsupported(new InvalidInputRpcError(rpcErr(-32000, "`validation: false` is not supported yet")))).toBe(true);
  });

  it("other failures are not 'unsupported'", () => {
    expect(simulateUnsupported(new InternalRpcError(rpcErr(-32603, "execution reverted")))).toBe(false);
    expect(simulateUnsupported(new HttpRequestError({status: 429, url: URL_, body, details: "Too Many Requests"}))).toBe(false);
    expect(simulateUnsupported(new Error("timeout"))).toBe(false);
  });

  it("a 1 MB 'method method …' message returns at once and is not misclassified", () => {
    const huge = "method ".repeat(150_000); // ≈1 MB, no "not"
    const errs = [new Error(huge), new InvalidInputRpcError(rpcErr(-32000, huge)), new HttpRequestError({status: 500, url: URL_, body, details: huge})];
    for (const e of errs) {
      const t0 = performance.now();
      expect(simulateUnsupported(e)).toBe(false);
      expect(performance.now() - t0).toBeLessThan(50);
    }
    // the old pattern's worst case: "method" × n then "not" far past the inspected head → still not misread
    const t0 = performance.now();
    expect(simulateUnsupported(new Error(`${huge}not`))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("previewEvmTx falls back to eth_call on each unsupported shape", async () => {
    for (const thrown of [
      new MethodNotFoundRpcError(rpcErr(-32601, "nope"), {method: "eth_simulateV1"}),
      new HttpRequestError({status: 403, url: URL_, body, details: JSON.stringify({code: -32601, message: "x"})}),
      new InvalidInputRpcError(rpcErr(-32000, "`validation: false` is not supported yet")),
    ]) {
      const calls: string[] = [];
      const rpc: Rpc = async (method) => {
        calls.push(method);
        if (method === "eth_simulateV1") throw thrown;
        if (method === "eth_call") return "0x";
        return null;
      };
      const p = await previewEvmTx({chainId: 1, from: ME, calls: [{to: ME, value: 1n}], rpc, own: [ME]});
      expect(calls).toContain("eth_call");
      expect(p.simulation.status).toBe("unavailable");
    }
  });
});
