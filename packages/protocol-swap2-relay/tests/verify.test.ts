import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {RELAY_DEPOSIT_ERC20, RELAY_DEPOSIT_ERC20_ALLOWANCE, RELAY_DEPOSIT_NATIVE, RELAY_SOLVERS, relayChain} from "../src/config.js";
import {RelayRefusal, parseRelayOrder, relayOrderId, relayOrderSigner, type RelayRefusalCode} from "../src/order.js";
import {buildRelayDeposit, verifyRelayOrder} from "../src/verify.js";
import {ALL, DIRECT, ORIGIN_SWAP, depositOf, loadQuote, protoOf, requestOf, type QuoteFixture} from "./fixtures.js";

const SOLVER = RELAY_SOLVERS[0]!.address;
const OTHER = "0x1111111111111111111111111111111111111111";

/** The code a call is refused with, or "accepted". */
function refusal(fn: () => unknown): RelayRefusalCode | "accepted" {
  try { fn(); } catch (e) {
    if (e instanceof RelayRefusal) return e.code;
    throw e;
  }
  return "accepted";
}
const fresh = (name: string): QuoteFixture => loadQuote(name);
const check = (f: QuoteFixture, over: Parameters<typeof requestOf>[1] = {}) => refusal(() => verifyRelayOrder(requestOf(f, over), protoOf(f), depositOf(f)));

describe("order id: live vectors", () => {
  const vectors = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/orders/vectors.json", import.meta.url)), "utf8")) as {label: string; orderId: string; orderSignature?: string; orderData: unknown}[];
  it("has the saved vectors", () => expect(vectors.length).toBe(4));
  for (const v of vectors) {
    it(`hashes ${v.label}`, () => {
      const id = relayOrderId(parseRelayOrder(v.orderData));
      expect(id).toBe(v.orderId);
      if (v.orderSignature) expect(relayOrderSigner(id, v.orderSignature)).toBe(SOLVER);
    });
  }
  for (const name of ALL) {
    it(`hashes and attributes the order of ${name}`, () => {
      const p = protoOf(fresh(name));
      const id = relayOrderId(parseRelayOrder(p.orderData));
      expect(id).toBe(p.orderId);
      expect(relayOrderSigner(id, p.orderSignature)).toBe(SOLVER);
    });
  }
  it("reads a salt written in hex or in decimal as the same order", () => {
    const p = protoOf(fresh("base-eth_arb-eth"));
    const dec = {...p.orderData, salt: BigInt(p.orderData.salt).toString(10)};
    expect(relayOrderId(parseRelayOrder(dec))).toBe(p.orderId);
  });
  it("is insensitive to the casing of hex fields and to unknown keys", () => {
    const p = protoOf(fresh("arb-usdc_ely-hype"));
    const o = JSON.parse(JSON.stringify(p.orderData)) as typeof p.orderData & {note?: string};
    o.solver = `0x${o.solver.slice(2).toUpperCase()}`;
    o.output.payments[0]!.recipient = o.output.payments[0]!.recipient.toLowerCase();
    o.note = "not part of the type";
    expect(relayOrderId(parseRelayOrder(o))).toBe(p.orderId);
  });
});

describe("signature", () => {
  const p = protoOf(fresh("base-eth_arb-eth"));
  const id = p.orderId as `0x${string}`;
  it("recovers the solver from v = 27/28 and from v = 0/1", () => {
    expect(relayOrderSigner(id, p.orderSignature)).toBe(SOLVER);
    const v = parseInt(p.orderSignature.slice(-2), 16);
    const alt = p.orderSignature.slice(0, -2) + (v - 27).toString(16).padStart(2, "0");
    expect(relayOrderSigner(id, alt)).toBe(SOLVER);
  });
  it("does not recover the solver from another order's signature", () => {
    const other = protoOf(fresh("bnb-bnb_arb-eth"));
    expect(relayOrderSigner(id, other.orderSignature)).not.toBe(SOLVER);
  });
  it.each([
    ["not a string", 7],
    ["empty", "0x"],
    ["64 bytes", p.orderSignature.slice(0, -2)],
    ["66 bytes", `${p.orderSignature}00`],
    ["a wrong recovery byte", `${p.orderSignature.slice(0, -2)}1d`],
    ["r = 0", `0x${"00".repeat(32)}${p.orderSignature.slice(66)}`],
    ["not hex", `0x${"zz".repeat(65)}`],
  ])("returns null for %s", (_n, sig) => expect(relayOrderSigner(id, sig)).toBeNull());
});

describe("live quotes pass", () => {
  for (const name of DIRECT) {
    it(name, () => {
      const f = fresh(name);
      const v = verifyRelayOrder(requestOf(f), protoOf(f), depositOf(f));
      expect(v.id).toBe(protoOf(f).orderId);
      // What this module builds is what Relay's API offered, byte for byte.
      expect(v.deposit.data).toBe(depositOf(f).data.toLowerCase());
      expect(v.deposit.to).toBe(relayChain(f.request.sourceChain)!.depository);
      expect(v.deposit.value).toBe(depositOf(f).value);
      const native = /^0x0{40}$/.test(f.request.sourceToken);
      expect(v.deposit.data.slice(0, 10)).toBe(native ? RELAY_DEPOSIT_NATIVE : RELAY_DEPOSIT_ERC20);
      expect(v.deposit.approvalAddress).toBe(native ? undefined : v.deposit.to);
      expect(v.minimumAmount).toBe(BigInt(protoOf(f).orderData.output.payments[0]!.minimumAmount));
      expect(v.minimumAmount <= v.expectedAmount).toBe(true);
    });
  }
  it("covers eleven direct corridors, among them Arbitrum USDC → Elysium HYPE and native → native", () => {
    expect(DIRECT.length).toBe(11);
    expect(DIRECT).toContain("arb-usdc_ely-hype");
    expect(DIRECT).toContain("base-eth_arb-eth");
  });
  it("verifies the order alone when no transaction is given, and builds the deposit", () => {
    const f = fresh("arb-usdc_ely-hype");
    const v = verifyRelayOrder(requestOf(f), protoOf(f));
    expect(v.deposit.data).toBe(depositOf(f).data.toLowerCase());
  });
});

describe("routes that swap on the source chain are refused by name", () => {
  for (const name of ORIGIN_SWAP) {
    it(name, () => {
      const f = fresh(name);
      expect(check(f)).toBe("tx-target");
      // And without the transaction the order still does not describe a deposit of what the user sends.
      expect(refusal(() => verifyRelayOrder(requestOf(f), protoOf(f)))).not.toBe("accepted");
    });
  }
});

describe("a valid order for a different request is refused (replay)", () => {
  const f = fresh("arb-usdc_ely-hype");
  it.each<[string, Parameters<typeof requestOf>[1], RelayRefusalCode]>([
    ["another recipient", {recipient: OTHER}, "output-recipient"],
    ["another destination chain", {destChain: "eip155:999"}, "output-chain"],
    ["another output token", {destToken: "0xb88339cb7199b77e23db6e890353e22632ba630f"}, "output-currency"],
    ["a higher floor", {minAmountOut: BigInt(protoOf(f).orderData.output.payments[0]!.minimumAmount) + 1n}, "output-minimum"],
    ["a tighter slippage", {slippageBps: 50}, "output-minimum"],
    ["another source chain", {sourceChain: "eip155:8453"}, "tx-chain"],
    ["another input token", {sourceToken: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"}, "input-currency"],
    ["another amount", {amount: 20_000_001n}, "input-amount"],
    ["another sender", {depositor: OTHER}, "refund-recipient"],
    ["ten minutes later", {nowMs: f.request.nowMs + 601_000}, "output-deadline"],
    ["a week later", {nowMs: f.request.nowMs + 604_900_000}, "output-deadline"],
    ["a clock far behind", {nowMs: f.request.nowMs - 400_000}, "output-deadline"],
  ])("%s", (_n, over, code) => expect(check(f, over)).toBe(code));
  it("another source chain is refused on the order too when no transaction is given", () => {
    expect(refusal(() => verifyRelayOrder(requestOf(f, {sourceChain: "eip155:8453"}), protoOf(f)))).toBe("input-chain");
  });
  it("accepts the caller's floor at the order's minimum and the slippage it was quoted with", () => {
    expect(check(f, {minAmountOut: BigInt(protoOf(f).orderData.output.payments[0]!.minimumAmount), slippageBps: 100})).toBe("accepted");
  });
  it("the recipient of a quote for someone else is that someone, and only that", () => {
    const g = fresh("base-eth_arb-eth.other-recipient");
    expect(g.request.recipient.toLowerCase()).not.toBe(g.request.depositor.toLowerCase());
    expect(check(g)).toBe("accepted");
    expect(check(g, {recipient: g.request.depositor})).toBe("output-recipient");
  });
});

describe("request sanity", () => {
  const f = fresh("base-eth_arb-eth");
  it.each<[string, Parameters<typeof requestOf>[1], RelayRefusalCode]>([
    ["an unpinned source chain", {sourceChain: "eip155:14"}, "chain-unsupported"],
    ["a non-EVM destination", {destChain: "solana:mainnet"}, "chain-unsupported"],
    ["a prototype key as chain", {destChain: "constructor"}, "chain-unsupported"],
    ["the same chain twice", {destChain: f.request.sourceChain}, "chain-unsupported"],
    ["a zero depositor", {depositor: "0x0000000000000000000000000000000000000000"}, "request-invalid"],
    ["a zero recipient", {recipient: "0x0000000000000000000000000000000000000000"}, "request-invalid"],
    ["a short address", {recipient: "0x1234"}, "request-invalid"],
    ["a zero amount", {amount: 0n}, "request-invalid"],
    ["a slippage above the bound", {slippageBps: 5001}, "request-invalid"],
    ["a fractional slippage", {slippageBps: 1.5}, "request-invalid"],
    ["a clock that is not a time", {nowMs: Number.NaN}, "request-invalid"],
  ])("%s", (_n, over, code) => expect(check(f, over)).toBe(code));
});

describe("the envelope", () => {
  const f = fresh("base-eth_arb-eth");
  const withProto = (edit: (p: Record<string, unknown>) => void) => {
    const g = fresh("base-eth_arb-eth");
    edit(protoOf(g) as unknown as Record<string, unknown>);
    return check(g);
  };
  it("no protocol data", () => expect(refusal(() => verifyRelayOrder(requestOf(f), null, depositOf(f)))).toBe("protocol-data-missing"));
  it("no order data", () => expect(withProto((p) => { delete p.orderData; })).toBe("protocol-data-missing"));
  it("another hub type", () => expect(withProto((p) => { p.hubType = "offchain"; })).toBe("hub-type"));
  it("the order as a JSON string", () => expect(withProto((p) => { p.orderData = JSON.stringify(p.orderData); })).toBe("order-malformed"));
  it("no order id", () => expect(withProto((p) => { delete p.orderId; })).toBe("order-id-mismatch"));
  it("another order's id", () => expect(withProto((p) => { p.orderId = protoOf(fresh("bnb-bnb_arb-eth")).orderId; })).toBe("order-id-mismatch"));
  it("no signature", () => expect(withProto((p) => { delete p.orderSignature; })).toBe("signature-invalid"));
  it("another order's signature", () => expect(withProto((p) => { p.orderSignature = protoOf(fresh("bnb-bnb_arb-eth")).orderSignature; })).toBe("signature-invalid"));
  it("a signature with one bit flipped", () => expect(withProto((p) => {
    const s = p.orderSignature as string;
    p.orderSignature = s.slice(0, 10) + (s[10] === "0" ? "1" : "0") + s.slice(11);
  })).toBe("signature-invalid"));
  it("no payment details", () => expect(withProto((p) => { delete p.paymentDetails; })).toBe("payment-details"));
  it.each([
    ["chain", (d: Record<string, unknown>) => { d.chainId = "arbitrum"; }],
    ["depository", (d: Record<string, unknown>) => { d.depository = OTHER; }],
    ["currency", (d: Record<string, unknown>) => { d.currency = OTHER; }],
    ["amount", (d: Record<string, unknown>) => { d.amount = "1"; }],
  ])("payment details naming another %s", (_n, edit) => expect(withProto((p) => edit(p.paymentDetails as Record<string, unknown>))).toBe("payment-details"));
});

describe("malformed orders", () => {
  const edit = (fn: (o: Record<string, any>) => void) => {
    const g = fresh("arb-usdc_ely-hype");
    fn(protoOf(g).orderData as unknown as Record<string, any>);
    return check(g);
  };
  it.each<[string, (o: Record<string, any>) => void]>([
    ["a missing field", (o) => { delete o.salt; }],
    ["a negative amount", (o) => { o.inputs[0].payment.amount = "-1"; }],
    ["an amount with a sign", (o) => { o.inputs[0].payment.amount = "+20000000"; }],
    ["an amount in exponent form", (o) => { o.inputs[0].payment.amount = "2e7"; }],
    ["an amount with a leading zero", (o) => { o.inputs[0].payment.amount = "020000000"; }],
    ["an amount with whitespace", (o) => { o.inputs[0].payment.amount = " 20000000"; }],
    ["a fractional number", (o) => { o.inputs[0].payment.amount = 2.5; }],
    ["a number past 2^53", (o) => { o.inputs[0].payment.amount = 2 ** 60; }],
    ["an amount past uint256", (o) => { o.inputs[0].payment.amount = (2n ** 256n).toString(); }],
    ["a deadline past uint32", (o) => { o.output.deadline = 2 ** 32; }],
    ["odd-length bytes", (o) => { o.output.payments[0].recipient = "0xabc"; }],
    ["bytes without 0x", (o) => { o.output.payments[0].recipient = o.output.payments[0].recipient.slice(2); }],
    ["an array where an object belongs", (o) => { o.output = [o.output]; }],
    ["an object where a list belongs", (o) => { o.inputs = {0: o.inputs[0], length: 1}; }],
    ["a chain id given as a number", (o) => { o.output.chainId = 99901; }],
    ["a solver that is not an address", (o) => { o.solver = `${o.solver}00`; }],
    ["too many inputs", (o) => { o.inputs = Array.from({length: 9}, () => o.inputs[0]); }],
    ["a null order", (o) => { for (const k of Object.keys(o)) delete o[k]; }],
  ])("%s", (_n, fn) => expect(edit(fn)).toBe("order-malformed"));
  it("a field supplied only through the prototype chain is missing", () => {
    const g = fresh("arb-usdc_ely-hype");
    const p = protoOf(g);
    const {version: _v, ...rest} = p.orderData;
    (p as {orderData: unknown}).orderData = Object.assign(Object.create({version: "v1"}), rest);
    expect(check(g)).toBe("order-malformed");
  });
});

describe("the order's own terms (signature left as issued)", () => {
  const edit = (fn: (o: Record<string, any>) => void, name = "arb-usdc_ely-hype") => {
    const g = fresh(name);
    fn(protoOf(g).orderData as unknown as Record<string, any>);
    return check(g);
  };
  it.each<[string, (o: Record<string, any>) => void, RelayRefusalCode]>([
    ["unknown version", (o) => { o.version = "v2"; }, "order-version"],
    ["two inputs", (o) => { o.inputs.push(o.inputs[0]); }, "order-inputs"],
    ["no input", (o) => { o.inputs = []; }, "order-inputs"],
    ["an extra payment", (o) => { o.output.payments.push({...o.output.payments[0], recipient: OTHER}); }, "order-payments"],
    ["no payment", (o) => { o.output.payments = []; }, "order-payments"],
    ["destination calls", (o) => { o.output.calls = ["0xdeadbeef"]; }, "order-calls"],
    ["an order-level fee", (o) => { o.fees = [{recipientChainId: "base", recipient: OTHER, currencyChainId: "base", currency: OTHER, amount: "1"}]; }, "order-fees"],
    ["zero weight", (o) => { o.inputs[0].payment.weight = "0"; }, "input-weight"],
    ["another solver", (o) => { o.solver = OTHER; }, "solver-not-pinned"],
    ["the solver on another chain", (o) => { o.solverChainId = "ethereum"; }, "solver-not-pinned"],
    ["a changed salt", (o) => { o.salt = "0x01"; }, "order-id-mismatch"],
    ["a changed extra data", (o) => { o.output.extraData = "0x"; }, "order-id-mismatch"],
    ["a changed refund minimum", (o) => { o.inputs[0].refunds[0].minimumAmount = "1"; }, "order-id-mismatch"],
    ["a changed expected amount", (o) => { o.output.payments[0].expectedAmount = (BigInt(o.output.payments[0].expectedAmount) + 1n).toString(); }, "order-id-mismatch"],
  ])("%s", (_n, fn, code) => expect(edit(fn)).toBe(code));
});

describe("the deposit transaction", () => {
  const editTx = (fn: (t: Record<string, any>, f: QuoteFixture) => void, name = "arb-usdc_ely-hype") => {
    const g = fresh(name);
    fn(depositOf(g) as unknown as Record<string, any>, g);
    return check(g);
  };
  const word = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
  it.each<[string, (t: Record<string, any>) => void, RelayRefusalCode]>([
    ["another chain id", (t) => { t.chainId = 8453; }, "tx-chain"],
    ["the chain id as a string", (t) => { t.chainId = "42161"; }, "tx-chain"],
    ["no chain id", (t) => { delete t.chainId; }, "tx-chain"],
    ["another target", (t) => { t.to = OTHER; }, "tx-target"],
    ["the other deployment's depository", (t) => { t.to = "0x59916da825d2d2ec1bf878d71c88826f6633ecca"; }, "tx-target"],
    ["a target with trailing bytes", (t) => { t.to = `${t.to}00`; }, "tx-target"],
    ["no calldata", (t) => { t.data = "0x"; }, "tx-calldata"],
    ["the whole-allowance deposit", (t) => { t.data = RELAY_DEPOSIT_ERC20_ALLOWANCE + t.data.slice(10, 138) + t.data.slice(-64); }, "tx-selector"],
    ["an unknown selector", (t) => { t.data = `0xdeadbeef${t.data.slice(10)}`; }, "tx-selector"],
    ["approve instead of a deposit", (t) => { t.data = `0x095ea7b3${word(OTHER)}${word("ff")}`; }, "tx-selector"],
    ["the native deposit for a token order", (t) => { t.data = RELAY_DEPOSIT_NATIVE + t.data.slice(10, 74) + t.data.slice(-64); }, "tx-selector"],
    ["trailing bytes", (t) => { t.data = `${t.data}00`; }, "tx-calldata"],
    ["a truncated call", (t) => { t.data = t.data.slice(0, -2); }, "tx-calldata"],
    ["dirty padding in the depositor", (t) => { t.data = `${t.data.slice(0, 10)}01${t.data.slice(12)}`; }, "tx-calldata"],
    ["dirty padding in the token", (t) => { t.data = `${t.data.slice(0, 74)}01${t.data.slice(76)}`; }, "tx-calldata"],
    ["another depositor", (t) => { t.data = t.data.slice(0, 10) + word(OTHER) + t.data.slice(74); }, "tx-depositor"],
    ["the zero depositor (credits whoever sends)", (t) => { t.data = t.data.slice(0, 10) + word("0") + t.data.slice(74); }, "tx-depositor"],
    ["another token", (t) => { t.data = t.data.slice(0, 74) + word(OTHER) + t.data.slice(138); }, "tx-token"],
    ["a larger amount", (t) => { t.data = t.data.slice(0, 138) + word((20_000_001).toString(16)) + t.data.slice(202); }, "tx-amount"],
    ["a smaller amount", (t) => { t.data = t.data.slice(0, 138) + word("1") + t.data.slice(202); }, "tx-amount"],
    ["another order id", (t) => { t.data = t.data.slice(0, -64) + word("ab".repeat(32)); }, "tx-id"],
    ["value on a token deposit", (t) => { t.value = "1"; }, "tx-value"],
    ["a hex value", (t) => { t.value = "0x0"; }, "tx-value"],
    ["a numeric value", (t) => { t.value = 0; }, "tx-value"],
  ])("ERC-20: %s", (_n, fn, code) => expect(editTx(fn)).toBe(code));

  it.each<[string, (t: Record<string, any>) => void, RelayRefusalCode]>([
    ["less value than the order's input", (t) => { t.value = (BigInt(t.value) - 1n).toString(); }, "tx-value"],
    ["more value than the order's input", (t) => { t.value = (BigInt(t.value) + 1n).toString(); }, "tx-value"],
    ["no value", (t) => { t.value = "0"; }, "tx-value"],
    ["another depositor", (t) => { t.data = t.data.slice(0, 10) + word(OTHER) + t.data.slice(74); }, "tx-depositor"],
    ["another order id", (t) => { t.data = t.data.slice(0, 74) + word("cd".repeat(32)); }, "tx-id"],
    ["the token deposit for a native order", (t) => { t.data = RELAY_DEPOSIT_ERC20 + t.data.slice(10, 74) + word(OTHER) + word("1") + t.data.slice(74); }, "tx-selector"],
    ["Linea's depository on Base", (t) => { t.to = "0x59916da825d2d2ec1bf878d71c88826f6633ecca"; }, "tx-target"],
  ])("native: %s", (_n, fn, code) => expect(editTx(fn, "base-eth_arb-eth")).toBe(code));

  it("accepts the API's checksummed or upper-case hex as the same bytes", () => {
    const g = fresh("arb-usdc_ely-hype");
    const t = depositOf(g);
    t.data = `0x${t.data.slice(2).toUpperCase()}`;
    t.to = `0x${t.to.slice(2).toUpperCase()}`;
    expect(check(g)).toBe("accepted");
  });
  it("another order's deposit does not fund this order", () => {
    const g = fresh("base-eth_arb-eth");
    const other = depositOf(fresh("base-eth_arb-eth.other-recipient"));
    Object.assign(depositOf(g), {data: other.data});
    expect(check(g)).toBe("tx-id");
  });
});

describe("buildRelayDeposit", () => {
  const base = relayChain("eip155:8453")!;
  const id = `0x${"ab".repeat(32)}` as const;
  it("refuses a zero or malformed depositor, a bad token, a zero amount and a short id", () => {
    expect(refusal(() => buildRelayDeposit(base, "0x0000000000000000000000000000000000000000", OTHER, 1n, id))).toBe("request-invalid");
    expect(refusal(() => buildRelayDeposit(base, "0x12", OTHER, 1n, id))).toBe("request-invalid");
    expect(refusal(() => buildRelayDeposit(base, OTHER, "0x12", 1n, id))).toBe("request-invalid");
    expect(refusal(() => buildRelayDeposit(base, OTHER, OTHER, 0n, id))).toBe("request-invalid");
    expect(refusal(() => buildRelayDeposit(base, OTHER, OTHER, 1n, "0xab"))).toBe("order-id-mismatch");
  });
  it("never builds the whole-allowance variant", () => {
    expect(buildRelayDeposit(base, OTHER, OTHER, 1n, id).data.slice(0, 10)).toBe(RELAY_DEPOSIT_ERC20);
    expect(buildRelayDeposit(base, OTHER, "0x0000000000000000000000000000000000000000", 1n, id).data.slice(0, 10)).toBe(RELAY_DEPOSIT_NATIVE);
  });
});
