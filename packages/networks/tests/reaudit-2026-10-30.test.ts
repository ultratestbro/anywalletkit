// Reaudit 2026-10-30, #5: verifyNetwork read a 200 answer with res.text() before any check, so a hostile RPC could
// make the wallet buffer as much as it sent within the deadline. Answers are now capped at MAX_RESPONSE_BYTES:
// a declared content-length over it is not read, a stream is dropped once it passes it.
import {describe, expect, it} from "vitest";
import {MAX_RESPONSE_BYTES, verifyNetwork, type FetchLike} from "../src/verify.js";

const net = {caip2: "eip155:1", family: "evm" as const, rpcs: ["https://rpc.example"]};
const asFetch = (f: () => Promise<Response>) => f as unknown as FetchLike;

describe("reaudit 2026-10-30 #5: verifyNetwork caps the answer", () => {
  it("a declared content-length over the cap is refused without reading the body", async () => {
    let read = false;
    const out = await verifyNetwork(net, {fetch: asFetch(async () => {
      const r = new Response("{}", {status: 200, headers: {"content-length": String(MAX_RESPONSE_BYTES + 1)}});
      Object.defineProperty(r, "text", {value: async () => { read = true; return "{}"; }});
      Object.defineProperty(r, "body", {value: null});
      return r;
    })});
    expect(out).toMatchObject({ok: false, error: expect.stringMatching(/^too-large/)});
    expect(read).toBe(false);
  });

  it("a chunked stream is cancelled once it passes the cap", async () => {
    let pulled = 0, cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({pull(c) { pulled++; c.enqueue(chunk); }, cancel() { cancelled = true; }});
    const out = await verifyNetwork(net, {fetch: asFetch(async () => new Response(stream, {status: 200}))});
    expect(out).toMatchObject({ok: false, error: expect.stringMatching(/^too-large/)});
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(40);
  });

  it("a body without a stream is checked on the text", async () => {
    const big = "x".repeat(MAX_RESPONSE_BYTES + 1);
    const out = await verifyNetwork(net, {fetch: asFetch(async () => { const r = new Response(big); Object.defineProperty(r, "body", {value: null}); return r; })});
    expect(out).toMatchObject({ok: false, error: expect.stringMatching(/^too-large/)});
  });

  it("a normal identity answer, streamed or not, still verifies", async () => {
    const ok = JSON.stringify({jsonrpc: "2.0", id: 1, result: "0x1"});
    const streamed = await verifyNetwork(net, {fetch: asFetch(async () => new Response(ok, {status: 200}))});
    expect(streamed.error ?? "").not.toMatch(/too-large/);
    expect(streamed).toMatchObject({ok: true});
    const plain = await verifyNetwork(net, {fetch: asFetch(async () => { const r = new Response(ok); Object.defineProperty(r, "body", {value: null}); return r; })});
    expect(plain).toMatchObject({ok: true});
  });
});
