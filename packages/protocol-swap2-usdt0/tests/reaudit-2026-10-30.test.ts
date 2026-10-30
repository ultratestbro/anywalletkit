// Reaudit 2026-10-30, #1: usdt0VerifyQuote bound the amount, eid, recipient and fee of a remote send but not the
// tokens the app asked for, and the OFT burns (or locks) its own token whatever the request named. A compromised
// backend could answer "Arbitrum USDC → …" with a valid USDT0 send. Both sides of the request are now checked with
// the provider's own tokenMatches; the USDT / USDT0 spellings and contract addresses keep passing.
import {describe, expect, it} from "vitest";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {usdt0VerifyQuote} from "../src/config.js";
import {ARB, ETH, HYPE, PARAMS, make} from "./fixtures.js";

const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const params = (o: Partial<QuoteParams> = {}): QuoteParams => ({...PARAMS, dry: false, ...o} as QuoteParams);

describe("reaudit 2026-10-30 #1: usdt0VerifyQuote binds the requested tokens", () => {
  it("a valid USDT0 send is refused for a USDC source, by address or by symbol", async () => {
    const q = (await make().p.getQuote(params()))!;
    expect(usdt0VerifyQuote(params({sourceToken: ARB_USDC}), q)).toMatch(/source token .* is not USDT0/);
    expect(usdt0VerifyQuote(params({sourceToken: "USDC"}), q)).toMatch(/source token USDC is not USDT0/);
  });

  it("a destination named by a symbol that is not USDT0 is refused", async () => {
    const q = (await make().p.getQuote(params()))!;
    expect(usdt0VerifyQuote(params({destToken: "USDC"}), q)).toMatch(/destination token USDC is not USDT0/);
  });

  it("USDT0 / USDT / USD₮0 spellings and the contract addresses still pass", async () => {
    const q = (await make().p.getQuote(params()))!;
    for (const sourceToken of ["USDT0", "usdt0", "USD₮0", "USDT", ARB.token, ARB.token.toLowerCase()]) {
      expect(usdt0VerifyQuote(params({sourceToken}), q), sourceToken).toBeNull();
    }
    for (const destToken of ["USDT0", HYPE.token]) expect(usdt0VerifyQuote(params({destToken}), q), destToken).toBeNull();
    const eth = params({sourceChain: "eip155:1", sourceToken: "USDT"});
    expect(usdt0VerifyQuote(eth, (await make().p.getQuote(eth))!)).toBeNull();
    expect(usdt0VerifyQuote({...eth, sourceToken: ETH.token}, (await make().p.getQuote(eth))!)).toBeNull();
  });
});
