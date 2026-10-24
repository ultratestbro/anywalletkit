import {describe, expect, it} from "vitest";
import {redactUrls} from "../src/index.js";

describe("redactUrls (scan 2026-10-23 F8)", () => {
  it("removes every URL, keyed paths and query strings included, and leaves the rest", () => {
    const viem = 'HTTP request failed.\n\nStatus: 429\nURL: https://x.quiknode.pro/abc123def/\nRequest body: {"method":"eth_call"}';
    expect(redactUrls(viem)).toBe('HTTP request failed.\n\nStatus: 429\nURL: <url>\nRequest body: {"method":"eth_call"}');
    expect(redactUrls("see wss://node.example/ws?key=k1 and http://a.b/c")).toBe("see <url> and <url>");
    expect(redactUrls("lifi: no route for USDC → ETH")).toBe("lifi: no route for USDC → ETH");
  });
});
