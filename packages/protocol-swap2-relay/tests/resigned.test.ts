// Every check on the order's content, in isolation: the order is changed and then signed again by the pinned solver
// (a test key takes the solver's place), with its id put back into the quote and into the deposit. What is left is an
// order that is authentic in every way and still not what the user asked for — the case of a solver, or of whoever
// holds its key, signing something else.
import {secp256k1} from "@noble/curves/secp256k1.js";
import {bytesToHex, hashMessage, hexToBytes, type Hex} from "viem";
import {describe, expect, it, vi} from "vitest";

const KEY = `0x${"42".repeat(32)}` as const;

vi.mock("../src/config.js", async (original) => {
  const {privateKeyToAddress} = await import("viem/accounts");
  const real = await original<typeof import("../src/config.js")>();
  return {...real, RELAY_SOLVERS: [{chainId: "base", address: privateKeyToAddress(`0x${"42".repeat(32)}`).toLowerCase()}]};
});

const {RELAY_SOLVERS} = await import("../src/config.js");
const {RelayRefusal, parseRelayOrder, relayOrderId, relayOrderSigner} = await import("../src/order.js");
const {verifyRelayOrder} = await import("../src/verify.js");
const {depositOf, loadQuote, protoOf, requestOf} = await import("./fixtures.js");
type RelayRefusalCode = import("../src/order.js").RelayRefusalCode;
type QuoteFixture = import("./fixtures.js").QuoteFixture;

const TEST_SOLVER = RELAY_SOLVERS[0]!.address;
const OTHER = "0x1111111111111111111111111111111111111111";
const WEEK = 604_800;

function sign(id: Hex): Hex {
  const sig = secp256k1.sign(hexToBytes(hashMessage({raw: id})), hexToBytes(KEY), {prehash: false, format: "recovered"});
  const out = new Uint8Array(65);
  out.set(sig.subarray(1), 0);
  out[64] = 27 + sig[0]!;
  return bytesToHex(out);
}

/** Change the order, then make everything around it consistent again: id, signature, payment details, calldata. */
function resigned(name: string, edit: (o: Record<string, any>, f: QuoteFixture) => void = () => undefined): QuoteFixture {
  const f = loadQuote(name);
  const p = protoOf(f);
  const o = p.orderData as unknown as Record<string, any>;
  o.solver = TEST_SOLVER;
  edit(o, f);
  let id: Hex;
  try { id = relayOrderId(parseRelayOrder(o)); } catch { return f; }
  p.orderId = id;
  p.orderSignature = sign(id);
  const tx = depositOf(f);
  tx.data = tx.data.slice(0, -64) + id.slice(2);
  return f;
}
function refusal(f: QuoteFixture, withTx = true): RelayRefusalCode | "accepted" {
  try { verifyRelayOrder(requestOf(f), protoOf(f), withTx ? depositOf(f) : undefined); } catch (e) {
    if (e instanceof RelayRefusal) return e.code;
    throw e;
  }
  return "accepted";
}

describe("the test solver stands in for the pinned one", () => {
  it("signs an order the verifier accepts", () => {
    for (const name of ["arb-usdc_ely-hype", "base-eth_arb-eth", "linea-eth_base-eth"]) {
      const f = resigned(name);
      expect(relayOrderSigner(protoOf(f).orderId as Hex, protoOf(f).orderSignature)).toBe(TEST_SOLVER);
      expect(refusal(f)).toBe("accepted");
    }
  });
  it("and the real solver is then not pinned", () => {
    expect(refusal(loadQuote("arb-usdc_ely-hype"))).toBe("solver-not-pinned");
  });
});

describe("an authentic order that is not the request", () => {
  const cases: [string, (o: Record<string, any>, f: QuoteFixture) => void, RelayRefusalCode][] = [
    // shape
    ["unknown version", (o) => { o.version = "v2"; }, "order-version"],
    ["two inputs", (o) => { o.inputs.push(JSON.parse(JSON.stringify(o.inputs[0]))); }, "order-inputs"],
    ["an extra output payment to someone else", (o) => { o.output.payments.push({...o.output.payments[0], recipient: OTHER}); }, "order-payments"],
    ["an extra output payment of zero", (o) => { o.output.payments.push({...o.output.payments[0], minimumAmount: "0", expectedAmount: "0"}); }, "order-payments"],
    ["a destination call", (o) => { o.output.calls = ["0x00"]; }, "order-calls"],
    ["an order-level fee", (o) => { o.fees = [{recipientChainId: "base", recipient: OTHER, currencyChainId: "arbitrum", currency: o.inputs[0].payment.currency, amount: "1000000"}]; }, "order-fees"],
    ["zero input weight", (o) => { o.inputs[0].payment.weight = "0"; }, "input-weight"],
    // solver
    ["the solver on another chain", (o) => { o.solverChainId = "arbitrum"; }, "solver-not-pinned"],
    // output
    ["another recipient", (o) => { o.output.payments[0].recipient = OTHER; }, "output-recipient"],
    ["the recipient with a byte appended", (o) => { o.output.payments[0].recipient += "00"; }, "output-recipient"],
    ["the recipient left-padded to 32 bytes", (o) => { o.output.payments[0].recipient = `0x${"00".repeat(12)}${o.output.payments[0].recipient.slice(2)}`; }, "output-recipient"],
    ["an empty recipient", (o) => { o.output.payments[0].recipient = "0x"; }, "output-recipient"],
    ["another destination chain", (o) => { o.output.chainId = "hyperevm"; }, "output-chain"],
    ["the destination as a number in a string", (o) => { o.output.chainId = "99901"; }, "output-chain"],
    ["the destination in another casing", (o) => { o.output.chainId = "Elysium"; }, "output-chain"],
    ["the destination with a trailing space", (o) => { o.output.chainId = "elysium "; }, "output-chain"],
    ["another output token", (o) => { o.output.payments[0].currency = OTHER; }, "output-currency"],
    ["an empty output token", (o) => { o.output.payments[0].currency = "0x"; }, "output-currency"],
    ["a zero minimum", (o) => { o.output.payments[0].minimumAmount = "0"; }, "output-minimum"],
    ["a minimum of one unit", (o) => { o.output.payments[0].minimumAmount = "1"; }, "output-minimum"],
    ["a minimum just under half the expected amount", (o) => { o.output.payments[0].minimumAmount = (BigInt(o.output.payments[0].expectedAmount) / 2n - 1n).toString(); }, "output-minimum"],
    ["an expected amount under the minimum", (o) => { o.output.payments[0].expectedAmount = (BigInt(o.output.payments[0].minimumAmount) - 1n).toString(); }, "output-expected"],
    ["an output deadline already past", (o, f) => { o.output.deadline = Math.floor(f.request.nowMs / 1000) - 1; }, "output-deadline"],
    ["an output deadline a minute away", (o, f) => { o.output.deadline = Math.floor(f.request.nowMs / 1000) + 60; }, "output-deadline"],
    ["an output deadline a day away", (o, f) => { o.output.deadline = Math.floor(f.request.nowMs / 1000) + 86_400; }, "output-deadline"],
    ["an output deadline a month away", (o, f) => { o.output.deadline = Math.floor(f.request.nowMs / 1000) + 30 * 86_400; }, "output-deadline"],
    ["an output deadline of zero", (o) => { o.output.deadline = 0; }, "output-deadline"],
    // input
    ["another input chain", (o) => { o.inputs[0].payment.chainId = "base"; }, "input-chain"],
    ["another input token", (o) => { o.inputs[0].payment.currency = OTHER; }, "input-currency"],
    ["the native coin as input", (o) => { o.inputs[0].payment.currency = `0x${"00".repeat(20)}`; }, "input-currency"],
    ["a larger input", (o) => { o.inputs[0].payment.amount = (BigInt(o.inputs[0].payment.amount) + 1n).toString(); }, "input-amount"],
    ["a smaller input", (o) => { o.inputs[0].payment.amount = (BigInt(o.inputs[0].payment.amount) - 1n).toString(); }, "input-amount"],
    // refunds
    ["a source refund to someone else", (o) => { o.inputs[0].refunds[0].recipient = OTHER; }, "refund-recipient"],
    ["a destination refund to someone else", (o) => { o.inputs[0].refunds[1].recipient = OTHER; }, "refund-recipient"],
    ["a third refund to someone else", (o) => { o.inputs[0].refunds.push({...o.inputs[0].refunds[0], recipient: OTHER}); }, "refund-recipient"],
    ["a source refund in another token", (o) => { o.inputs[0].refunds[0].currency = OTHER; }, "refund-currency"],
    ["a destination refund naming no token", (o) => { o.inputs[0].refunds[1].currency = "0x"; }, "refund-currency"],
    ["a refund on a third chain", (o) => { o.inputs[0].refunds[1].chainId = "base"; }, "refund-chain"],
    ["no refunds at all", (o) => { o.inputs[0].refunds = []; }, "refund-missing"],
    ["only a destination refund", (o) => { o.inputs[0].refunds = [o.inputs[0].refunds[1]]; }, "refund-missing"],
    ["a refund deadline already past", (o, f) => { o.inputs[0].refunds[0].deadline = Math.floor(f.request.nowMs / 1000) - 1; }, "refund-deadline"],
    ["a refund deadline an hour away", (o, f) => { o.inputs[0].refunds[0].deadline = Math.floor(f.request.nowMs / 1000) + 3600; }, "refund-deadline"],
    ["a refund deadline a year away", (o, f) => { o.inputs[0].refunds[1].deadline = Math.floor(f.request.nowMs / 1000) + 365 * 86_400; }, "refund-deadline"],
  ];
  it.each(cases)("%s", (_n, edit, code) => {
    const f = resigned("arb-usdc_ely-hype", edit);
    expect(refusal(f)).toBe(code);
    // The same refusal with no transaction in hand: the order alone is enough to say no.
    expect(refusal(f, false)).toBe(code);
  });

  it("the fixture's refunds are the two this file edits: source to the sender, destination to the recipient", () => {
    const o = protoOf(loadQuote("arb-usdc_ely-hype")).orderData;
    expect(o.inputs[0]!.refunds.map((r) => r.chainId)).toEqual(["arbitrum", "elysium"]);
  });
  it("a deadline exactly one lifetime from now is accepted, at both edges of the window", () => {
    const at = (delta: number) => resigned("arb-usdc_ely-hype", (o, f) => {
      const t = Math.floor(f.request.nowMs / 1000) + WEEK + delta;
      o.output.deadline = t;
      for (const r of o.inputs[0].refunds) r.deadline = t;
    });
    expect(refusal(at(0))).toBe("accepted");
    expect(refusal(at(300))).toBe("accepted");
    expect(refusal(at(301))).toBe("output-deadline");
    expect(refusal(at(-600))).toBe("accepted");
    expect(refusal(at(-601))).toBe("output-deadline");
  });
  it("a native order: more input than the user sends is refused before the value is looked at", () => {
    const f = resigned("base-eth_arb-eth", (o) => { o.inputs[0].payment.amount = (BigInt(o.inputs[0].payment.amount) * 2n).toString(); });
    expect(refusal(f)).toBe("input-amount");
  });
  it("payment details that no longer describe the re-signed order are refused", () => {
    const f = resigned("arb-usdc_ely-hype");
    protoOf(f).paymentDetails.amount = "19999999";
    expect(refusal(f)).toBe("payment-details");
  });
  it("a re-signed order keeps its old id in the calldata: refused on the id", () => {
    const f = resigned("arb-usdc_ely-hype", (o) => { o.salt = "0x02"; });
    const old = depositOf(loadQuote("arb-usdc_ely-hype")).data;
    depositOf(f).data = old;
    expect(refusal(f)).toBe("tx-id");
  });
  it("a signature by the test solver over another id is refused", () => {
    const f = resigned("arb-usdc_ely-hype");
    protoOf(f).orderSignature = sign(`0x${"11".repeat(32)}`);
    expect(refusal(f)).toBe("signature-invalid");
  });
});
