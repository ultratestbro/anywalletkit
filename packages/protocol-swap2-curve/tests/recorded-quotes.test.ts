// Quotes the live provider built on 2026-11-05 (fixtures/quotes, recorded read-only): curveVerifyQuote — what a client
// runs on a remote quote, with the shipped deployments and allowlist — accepts each as recorded and refuses it altered.
import {describe, expect, it} from "vitest";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {decodeExchange, encodeExchange} from "../src/abi.js";
import {CURVE_DEPLOYMENTS} from "../src/deployments.js";
import {curveVerifyQuote} from "../src/verify.js";

const recorded = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/quotes/quotes-2026-11-05.json", import.meta.url)), "utf8")) as {label: string; params: QuoteParams; quote: Quote}[];
const ODD = "0x00000000000000000000000000000000000bad01";

describe("recorded live quotes", () => {
  it("covers both router families and a two-pool route", () => {
    expect(recorded.map((r) => r.quote.providerData!.family)).toEqual(["ng5", "ng5", "lite4"]);
    expect(recorded.some((r) => r.quote.providerData!.pools!.split(",").length === 2)).toBe(true);
  });
  for (const {label, params, quote} of recorded) {
    const chainId = Number(quote.intentId.split(":")[1]);
    const d = CURVE_DEPLOYMENTS[chainId]!;
    const call = decodeExchange(d.family, quote.txRequest!.data!)!;
    const reseal = (route: typeof call.route, receiver = call.receiver!) => ({...quote, txRequest: {...quote.txRequest!, data: encodeExchange(d.family, {route, params: call.params}, call.amount, call.minDy, receiver)}});
    it(`${label}: accepted as recorded`, () => {
      expect(curveVerifyQuote(params, quote)).toBeNull();
    });
    it(`${label}: refused paying someone else, or with a lower minimum`, () => {
      expect(curveVerifyQuote(params, reseal(call.route, "0x1111111111111111111111111111111111111111"))).toMatch(/not the recipient/);
      expect(curveVerifyQuote(params, {...quote, txRequest: {...quote.txRequest!, data: encodeExchange(d.family, call, call.amount, 1n, call.receiver!)}})).toMatch(/minimum 1 is not the quote's/);
    });
    if (call.route[3] !== "0x0000000000000000000000000000000000000000") {
      it(`${label}: refused when the token between the pools is one the catalog does not list`, () => {
        const route = [...call.route];
        route[2] = ODD;
        expect(curveVerifyQuote(params, reseal(route))).toMatch(/catalog does not list/);
      });
    }
  }
});
