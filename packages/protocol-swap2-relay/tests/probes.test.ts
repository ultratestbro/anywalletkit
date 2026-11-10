// Things tried against real fixtures during the independent review that held. Each `it` states what happened.
import {secp256k1} from "@noble/curves/secp256k1.js";
import {describe, expect, it} from "vitest";
import {RelayRefusal} from "../src/order.js";
import {verifyRelayOrder, type RelayRequest} from "../src/verify.js";
import {depositOf, loadQuote, protoOf, requestOf, type QuoteFixture} from "./fixtures.js";

const USDC = "user.arb-usdc_base-usdc";
const ETH = "user.op-eth_base-eth";
const OTHER = "0x1111111111111111111111111111111111111111";
function run(f: QuoteFixture, over: Partial<RelayRequest> = {}, tx: unknown = depositOf(f), proto: unknown = protoOf(f)): string {
  try { verifyRelayOrder(requestOf(f, over), proto as never, tx as never); } catch (e) {
    if (e instanceof RelayRefusal) return e.code;
    return `threw:${(e as Error).message}`;
  }
  return "accepted";
}

describe("signature forms", () => {
  it("v as 0/1 is accepted next to 27/28 (same signer, harmless); other v refused", () => {
    const f = loadQuote(USDC);
    const sig = protoOf(f).orderSignature;
    const v = parseInt(sig.slice(-2), 16);
    protoOf(f).orderSignature = sig.slice(0, -2) + (v - 27).toString(16).padStart(2, "0");
    expect(run(f)).toBe("accepted");
    protoOf(f).orderSignature = sig.slice(0, -2) + (v + 8).toString(16);
    expect(run(f)).toBe("signature-invalid");
  });
  it("the high-s twin of the solver's signature is refused; 64-byte, 66-byte, empty, zeroed, non-string are refused", () => {
    const f = loadQuote(USDC);
    const sig = protoOf(f).orderSignature;
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const flipped = (secp256k1.Point.Fn.ORDER - s).toString(16).padStart(64, "0");
    const v = parseInt(sig.slice(-2), 16);
    protoOf(f).orderSignature = sig.slice(0, 66) + flipped + (v === 27 ? "1c" : "1b");
    expect(run(f)).toBe("signature-invalid");
    for (const bad of [sig.slice(0, 130), `${sig}00`, "0x", `0x${"00".repeat(65)}`, null, 7, [sig], {toString: () => sig}]) {
      protoOf(f).orderSignature = bad as never;
      expect(run(f)).toBe("signature-invalid");
    }
  });
  it("a genuine signature over another fixture's order does not carry over", () => {
    const f = loadQuote(USDC);
    protoOf(f).orderSignature = protoOf(loadQuote(ETH)).orderSignature;
    expect(run(f)).toBe("signature-invalid");
  });
});

describe("calldata and transaction fields", () => {
  it("upper-case hex is the same bytes (accepted); anything else is refused", () => {
    const f = loadQuote(USDC);
    const tx = depositOf(f);
    expect(run(f, {}, {...tx, data: `0x${tx.data.slice(2).toUpperCase()}`})).toBe("accepted");
    expect(run(f, {}, {...tx, data: `${tx.data}00`})).toBe("tx-calldata");
    expect(run(f, {}, {...tx, data: `${tx.data}${"00".repeat(32)}`})).toBe("tx-calldata");
    expect(run(f, {}, {...tx, data: tx.data.slice(0, -2)})).toBe("tx-calldata");
    // dirty upper bits in the depositor word (Solidity would mask or revert)
    expect(run(f, {}, {...tx, data: `${tx.data.slice(0, 10)}ff${tx.data.slice(12)}`})).toBe("tx-calldata");
    // depositor = 0 → the contract credits msg.sender; still refused
    expect(run(f, {}, {...tx, data: `${tx.data.slice(0, 10)}${"0".repeat(64)}${tx.data.slice(74)}`})).toBe("tx-depositor");
    // the allowance-draining overload
    expect(run(f, {}, {...tx, data: `0x5a1ee3ac${tx.data.slice(10, 138)}${tx.data.slice(-64)}`})).toBe("tx-selector");
    expect(run(f, {}, {...tx, data: [tx.data]})).toBe("tx-calldata");
  });
  it("value, chain id and target in any other form are refused", () => {
    const f = loadQuote(USDC);
    const tx = depositOf(f);
    for (const value of ["1", "0x0", "00", "", 0, 0n, null, "0 "]) expect(run(f, {}, {...tx, value})).toBe("tx-value");
    for (const chainId of ["42161", 42161.0000001, 1, null, undefined, 42161n]) expect(run(f, {}, {...tx, chainId})).toBe("tx-chain");
    for (const to of [OTHER, tx.to.slice(0, -1), `${tx.to}00`, ` ${tx.to}`, null, [tx.to]]) expect(run(f, {}, {...tx, to})).toBe("tx-target");
    expect(run(f, {}, {...tx, to: tx.to.toUpperCase().replace("0X", "0x")})).toBe("accepted");
    const n = loadQuote(ETH);
    const ntx = depositOf(n);
    expect(run(n, {}, {...ntx, value: (BigInt(ntx.value) + 1n).toString()})).toBe("tx-value");
    expect(run(n, {}, {...ntx, value: "0"})).toBe("tx-value");
  });
});

describe("order encoding", () => {
  it("number forms that hash the same are accepted; ones that do not are refused", () => {
    const f = loadQuote(USDC);
    const o = protoOf(f).orderData as any;
    const amt = o.inputs[0].payment.amount as string;
    o.inputs[0].payment.amount = Number(amt); // a safe integer: same value, same hash
    expect(run(f)).toBe("accepted");
    o.inputs[0].payment.amount = `0x${BigInt(amt).toString(16)}`;
    expect(run(f)).toBe("accepted");
    for (const bad of [`${amt}.0`, `${amt}e0`, `-${amt}`, ` ${amt}`, `0${amt}`, 2 ** 53, 1.5, -1, null, [amt], true, `0x${"f".repeat(65)}`]) {
      o.inputs[0].payment.amount = bad;
      expect(run(f)).not.toBe("accepted");
    }
  });
  it("address fields: upper case is the same bytes; padded, short, zero-x-less are refused", () => {
    const f = loadQuote(USDC);
    const o = protoOf(f).orderData as any;
    const r = o.output.payments[0].recipient as string;
    o.output.payments[0].recipient = `0x${r.slice(2).toUpperCase()}`;
    expect(run(f)).toBe("accepted");
    for (const bad of [`0x${"00".repeat(12)}${r.slice(2)}`, r.slice(0, -2), r.slice(2), `${r}00`, "0x"]) {
      o.output.payments[0].recipient = bad;
      expect(run(f)).not.toBe("accepted");
    }
  });
  it("chain slugs are compared exactly; a numeric or CAIP form of the right chain is refused", () => {
    const f = loadQuote(USDC);
    const o = protoOf(f).orderData as any;
    for (const bad of ["Base", "base ", "8453", "eip155:8453", "bаse" /* Cyrillic а */, "optimism"]) {
      o.output.chainId = bad;
      expect(run(f)).not.toBe("accepted");
    }
  });
  it("__proto__ / inherited fields / duplicate keys: only own properties are read, last duplicate wins for hash and checks alike", () => {
    const f = loadQuote(USDC);
    const raw = JSON.stringify(protoOf(f).orderData);
    // recipient inherited instead of own
    const o = JSON.parse(raw);
    const pay = o.output.payments[0];
    const rec = pay.recipient;
    delete pay.recipient;
    Object.setPrototypeOf(pay, {recipient: rec});
    expect(run(f, {}, depositOf(f), {...protoOf(f), orderData: o})).not.toBe("accepted");
    // a duplicate key: JSON.parse keeps the last, and the id no longer matches the signed one
    const dup = JSON.parse(raw.replace(`"recipient":"${rec}"`, `"recipient":"${rec}","recipient":"${OTHER}"`));
    expect(run(f, {}, depositOf(f), {...protoOf(f), orderData: dup})).toMatch(/-recipient$/);
    // an extra unknown field is ignored by the hash and by the checks (harmless: not part of the order)
    const extra = JSON.parse(raw);
    extra.__proto__ = {solver: OTHER};
    extra.note = "x";
    expect(run(f, {}, depositOf(f), {...protoOf(f), orderData: extra})).toBe("accepted");
  });
  it("the request side: a different recipient, depositor, token, amount, chain never matches a genuine order", () => {
    const f = loadQuote(USDC);
    expect(run(f, {recipient: OTHER})).toBe("output-recipient");
    expect(run(f, {depositor: OTHER})).not.toBe("accepted");
    expect(run(f, {amount: BigInt(f.request.amount) + 1n})).toBe("input-amount");
    expect(run(f, {destChain: "eip155:10"})).toBe("output-chain");
    expect(run(f, {destToken: "0x0000000000000000000000000000000000000000"})).toBe("output-currency");
    expect(run(f, {sourceChain: "eip155:10"})).toBe("tx-chain");
    expect(run(f, {nowMs: Math.floor(f.request.nowMs / 1000)})).not.toBe("accepted"); // seconds passed as ms
    expect(run(f, {nowMs: f.request.nowMs * 1000})).not.toBe("accepted");
  });
});
