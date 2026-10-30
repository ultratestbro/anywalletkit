// Scan 2026-10-30 F3 (wrap): wrapPins pinned only the wrapped-native address, so a remote backend could answer with
// any call on it (another selector, another amount, a value on withdraw). wrapPins now carry wrapVerifyQuote: only
// deposit() with the input as value, or withdraw(input) with no value, paying the sender. The real wrap and unwrap
// quotes keep passing.
import {afterEach, describe, expect, it, vi} from "vitest";
import {encodeAbiParameters, encodeFunctionData, parseAbi} from "viem";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {WRAPPED_NATIVE, wrapPins, wrapProvider, wrapVerifyQuote} from "../src/provider.js";

afterEach(() => vi.unstubAllGlobals());

const WETH = WRAPPED_NATIVE[1]!.address;
const ME = "0x4444444444444444444444444444444444444444";
const OTHER = "0x3333333333333333333333333333333333333333";
const ZERO = "0x0000000000000000000000000000000000000000";
const ABI = parseAbi(["function withdraw(uint256 wad)", "function transfer(address to, uint256 amount) returns (bool)"]);
const stub = (async (_url: RequestInfo | URL, init?: RequestInit) => {
  const sel = (JSON.parse(String(init?.body)) as {params: [{data: string}]}).params[0].data;
  return new Response(JSON.stringify({result: sel === "0x95d89b41" ? encodeAbiParameters([{type: "string"}], ["WETH"]) : encodeAbiParameters([{type: "uint8"}], [18])}));
}) as typeof fetch;
const wrapP: QuoteParams = {sourceChain: "eip155:1", destChain: "eip155:1", sourceToken: "ETH", destToken: WETH, destAddress: ME, refundAddress: ME, amountIn: "1000000000000000", dry: false};
const unwrapP: QuoteParams = {...wrapP, sourceToken: "WETH", destToken: ZERO};

describe("scan 2026-10-30 F3: wrapVerifyQuote", () => {
  it("is in the pins and passes the real provider's wrap, unwrap and dry quotes", async () => {
    vi.stubGlobal("fetch", stub);
    expect(wrapPins.verifyQuote).toBe(wrapVerifyQuote);
    const p = wrapProvider({rpcUrls: {1: ["https://rpc.test"]}});
    expect(wrapVerifyQuote(wrapP, (await p.getQuote(wrapP))!)).toBeNull();
    expect(wrapVerifyQuote(unwrapP, (await p.getQuote(unwrapP))!)).toBeNull();
    const {refundAddress: _r, ...rest} = wrapP;
    const dry: QuoteParams = {...rest, destAddress: "", dry: true};
    expect(wrapVerifyQuote(dry, (await p.getQuote(dry))!)).toBeNull();
  });

  it("refuses another selector, amount, value, target, approval, pair or recipient", async () => {
    vi.stubGlobal("fetch", stub);
    const p = wrapProvider({rpcUrls: {1: ["https://rpc.test"]}});
    const w = (await p.getQuote(wrapP))!;
    const u = (await p.getQuote(unwrapP))!;
    const tx = (q: typeof w, o: Record<string, unknown>) => ({...q, txRequest: {...q.txRequest!, ...o}});
    expect(wrapVerifyQuote(wrapP, tx(w, {value: "1"}))).toMatch(/attaches 1/);
    expect(wrapVerifyQuote(wrapP, tx(w, {data: u.txRequest!.data}))).toMatch(/withdraw is not deposit/);
    expect(wrapVerifyQuote(wrapP, tx(w, {data: "0xd0e30db000"}))).toMatch(/neither deposit|is not deposit/);
    expect(wrapVerifyQuote(unwrapP, tx(u, {data: encodeFunctionData({abi: ABI, functionName: "withdraw", args: [1n]})}))).toMatch(/withdraw\(1\) is not/);
    expect(wrapVerifyQuote(unwrapP, tx(u, {value: "1"}))).toMatch(/no value/);
    expect(wrapVerifyQuote(unwrapP, tx(u, {data: encodeFunctionData({abi: ABI, functionName: "transfer", args: [OTHER, 1n]})}))).toMatch(/neither deposit/);
    expect(wrapVerifyQuote(wrapP, tx(w, {to: OTHER}))).toMatch(/not WETH/);
    expect(wrapVerifyQuote(wrapP, tx(w, {approvalAddress: OTHER}))).toMatch(/approves nothing/);
    expect(wrapVerifyQuote({...wrapP, destToken: ZERO}, w)).toMatch(/only ETH ↔ WETH/);
    expect(wrapVerifyQuote({...wrapP, destAddress: OTHER}, w)).toMatch(/sender's own address/);
  });
});
