import {afterEach, describe, expect, it, vi} from "vitest";
import {refusalOf, type Swap2RefusalReason} from "../src/errors.js";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {Swap2ExecutionPlan} from "../src/swap2/base.js";
import type {CrossChainProvider, Quote, QuoteParams, TxRequest, UnsignedTx} from "../src/types.js";
import {PERMIT2_ADDRESS, appendPermit2Signature, permit2TransferJson, readPermit2Transfer} from "../src/permit2.js";
import {remoteProvider} from "../src/remote.js";
import {createSwap2Handler} from "../src/server.js";
import {validQuote} from "../src/validate.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base
const SETTLER = "0x1035029091415555555555555555555555550001";
const ME = "0x4444444444444444444444444444444444444444";
const AMOUNT = 1_000_000n;
const now = () => Math.floor(Date.now() / 1000);

type Typed = {domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: {permitted: Record<string, unknown>; spender: string; nonce: unknown; deadline: unknown} & Record<string, unknown>};
function typed(over: (t: Typed) => void = () => {}): string {
  const t: Typed = {
    domain: {name: "Permit2", chainId: 8453, verifyingContract: PERMIT2_ADDRESS},
    types: {
      EIP712Domain: [{name: "name", type: "string"}, {name: "chainId", type: "uint256"}, {name: "verifyingContract", type: "address"}],
      PermitTransferFrom: [{name: "permitted", type: "TokenPermissions"}, {name: "spender", type: "address"}, {name: "nonce", type: "uint256"}, {name: "deadline", type: "uint256"}],
      TokenPermissions: [{name: "token", type: "address"}, {name: "amount", type: "uint256"}],
    },
    primaryType: "PermitTransferFrom",
    message: {permitted: {token: USDC.toLowerCase(), amount: AMOUNT.toString()}, spender: SETTLER, nonce: "2241959297937691820908574931991575", deadline: String(now() + 300)},
  };
  over(t);
  return JSON.stringify(t);
}
const expected = {chainId: 8453, token: USDC, amount: AMOUNT, spender: SETTLER};

describe("readPermit2Transfer", () => {
  it("accepts the swap's own PermitTransferFrom and rebuilds it from local constants", () => {
    const t = readPermit2Transfer(typed(), expected);
    expect(t.domain).toEqual({name: "Permit2", chainId: 8453, verifyingContract: PERMIT2_ADDRESS});
    expect(t.primaryType).toBe("PermitTransferFrom");
    expect(Object.keys(t.types)).toEqual(["PermitTransferFrom", "TokenPermissions"]);
    expect(t.message).toEqual({permitted: {token: USDC.toLowerCase(), amount: "1000000"}, spender: SETTLER, nonce: "2241959297937691820908574931991575", deadline: t.deadline.toString()});
  });

  it("reads a hex chainId and hex uint256 fields, and writes decimals back", () => {
    const t = readPermit2Transfer(typed((x) => { x.domain.chainId = "0x2105"; x.message.permitted.amount = "0xf4240"; x.message.nonce = "0x10"; }), expected);
    expect(t.message.permitted.amount).toBe("1000000");
    expect(t.message.nonce).toBe("16");
    expect(JSON.parse(permit2TransferJson(t)).domain.chainId).toBe(8453);
  });

  const refusals: [string, (t: Typed) => void, RegExp, Swap2RefusalReason][] = [
    ["another token", (t) => { t.message.permitted.token = "0x4200000000000000000000000000000000000006"; }, /permitted token is not the source token/, "price_check_failed"],
    ["a larger amount", (t) => { t.message.permitted.amount = (AMOUNT + 1n).toString(); }, /permitted amount is not the swap's 1000000/, "price_check_failed"],
    ["a smaller amount", (t) => { t.message.permitted.amount = (AMOUNT - 1n).toString(); }, /permitted amount is not the swap's/, "price_check_failed"],
    ["an unlimited amount", (t) => { t.message.permitted.amount = ((1n << 256n) - 1n).toString(); }, /permitted amount is not the swap's/, "price_check_failed"],
    ["another spender", (t) => { t.message.spender = "0x9999999999999999999999999999999999999999"; }, /spender is not the contract the swap calls/, "vault_mismatch"],
    ["another domain name", (t) => { t.domain.name = "Permit3"; }, /domain name is not Permit2/, "vault_mismatch"],
    ["another chain", (t) => { t.domain.chainId = 1; }, /domain chainId is not the source chain 8453/, "vault_mismatch"],
    ["another verifying contract", (t) => { t.domain.verifyingContract = "0x0000000000225e31D15943971F47aD3022F714Fa"; }, /verifying contract is not Permit2/, "vault_mismatch"],
    ["an extra domain field", (t) => { t.domain.salt = "0x00"; }, /domain is not \{name, chainId, verifyingContract\}/, "vault_mismatch"],
    ["a passed deadline", (t) => { t.message.deadline = String(now() - 1); }, /deadline has passed/, "quote_expired"],
    ["a far deadline", (t) => { t.message.deadline = String(now() + 3 * 3600); }, /deadline is more than 3600 s away/, "policy_refused"],
    ["a deadline that is not a number", (t) => { t.message.deadline = "soon"; }, /deadline has passed or is not a uint256/, "policy_refused"],
    ["a nonce that is not a uint256", (t) => { t.message.nonce = "-1"; }, /nonce is not a uint256/, "policy_refused"],
    ["a witness type", (t) => { t.types.Witness = [{name: "x", type: "uint256"}]; }, /unexpected type Witness/, "policy_refused"],
    ["a reordered PermitTransferFrom", (t) => { t.types.PermitTransferFrom = [...(t.types.PermitTransferFrom as unknown[])].reverse(); }, /types are not Permit2's/, "policy_refused"],
    ["an extra message field", (t) => { t.message.witness = "0x00"; }, /message is not \{permitted, spender, nonce, deadline\}/, "policy_refused"],
    ["an allowance permit", (t) => { t.primaryType = "PermitSingle"; }, /primaryType PermitSingle is not PermitTransferFrom/, "policy_refused"],
  ];
  for (const [name, tamper, why, reason] of refusals) {
    it(`refuses ${name} (${reason})`, () => {
      const err = (() => { try { readPermit2Transfer(typed(tamper), expected); } catch (e) { return e; } return null; })();
      expect((err as Error).message).toMatch(why);
      expect(refusalOf(err)?.reason).toBe(reason);
    });
  }

  it("passes on no provider address strings: a mixed-case address with a wrong checksum comes back lowercase, which signers accept", () => {
    // One letter of USDC's checksum flipped: equal case-insensitively, refused by a strict address parser.
    const badChecksum = "0x833589FCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const spender = "0xAbCd000000000000000000000000000000000003";
    const t = readPermit2Transfer(typed((x) => { x.message.permitted.token = badChecksum; x.message.spender = spender; }), {...expected, spender});
    expect(t.message.permitted.token).toBe(USDC.toLowerCase());
    expect(t.message.spender).toBe(spender.toLowerCase());
    expect(JSON.parse(permit2TransferJson(t)).message.spender).toBe(spender.toLowerCase());
  });

  it("refuses what is not JSON, and a spender that is Permit2 or the token", () => {
    expect(() => readPermit2Transfer("{", expected)).toThrow(/not JSON/);
    expect(refusalOf((() => { try { readPermit2Transfer("{", expected); } catch (e) { return e; } return null; })())?.reason).toBe("policy_refused");
    expect(refusalOf((() => { try { readPermit2Transfer(typed(), {...expected, spender: PERMIT2_ADDRESS}); } catch (e) { return e; } return null; })())?.reason).toBe("vault_mismatch");
    expect(() => readPermit2Transfer(typed((t) => { t.message.spender = PERMIT2_ADDRESS; }), {...expected, spender: PERMIT2_ADDRESS})).toThrow(/spender is Permit2, the token itself or the zero address/);
    expect(() => readPermit2Transfer(typed((t) => { t.message.spender = USDC; }), {...expected, spender: USDC})).toThrow(/spender is Permit2/);
  });
});

describe("appendPermit2Signature", () => {
  it("appends uint256(length) and the signature", () => {
    const sig = `0x${"ab".repeat(65)}`;
    expect(appendPermit2Signature("0x1fff991f", sig)).toBe(`0x1fff991f${"0".repeat(62)}41${"ab".repeat(65)}`);
  });
  it("refuses a missing, short or non-hex signature (the account's failure: unclassified) and calldata that is not hex (policy_refused)", () => {
    for (const bad of ["", "0x", "0xsig", `0x${"ab".repeat(63)}`, `0x${"ab".repeat(2049)}`]) expect(() => appendPermit2Signature("0x1fff991f", bad)).toThrow(/no usable signature/);
    const caught = (f: () => unknown) => { try { f(); } catch (e) { return e; } return null; };
    expect(refusalOf(caught(() => appendPermit2Signature("0x1fff991f", "0x")))).toBeUndefined();
    const notHex = caught(() => appendPermit2Signature("0x1fff99", `0x${"ab".repeat(65)}`));
    expect((notHex as Error).message).toBe("swap2: Permit2 transfer refused — the calldata is not hex bytes");
    expect(refusalOf(notHex)?.reason).toBe("policy_refused");
  });
});

// ── the engine ───────────────────────────────────────────────────────────────

const DATA = `0x1fff991f${"00".repeat(96)}`;
const SIG = `0x${"cd".repeat(65)}`;
function tx(over: Partial<TxRequest> = {}): TxRequest {
  return {to: SETTLER, data: DATA, value: "0", chainId: 8453, gasLimit: "400000", approvalAddress: PERMIT2_ADDRESS, permit2Transfer: typed(), ...over};
}
function without(key: keyof TxRequest): TxRequest {
  const t = tx();
  delete t[key];
  return t;
}
function provider(request: TxRequest, over: Partial<CrossChainProvider> = {}, quote: Partial<Quote> = {}): CrossChainProvider {
  return {
    name: "permit2", enabled: () => true, supportsRoute: () => true, supportsSameChain: true,
    getQuote: async (params) => ({
      provider: "permit2", intentId: "intent", depositAddress: "", depositMemo: null, txRequest: request,
      sourceAmount: params.amountIn, destAmount: "400000000000000", minDestAmount: "396000000000000",
      feeUsd: 0, etaSeconds: 15, reliability: 1, validUntilMs: Date.now() + 30_000, ...quote,
    }),
    buildDeposit: async (q) => ({chain: "", to: q.txRequest!.to!, value: q.txRequest!.value ?? "0", ...(({to: _to, value: _value, nativeFee: _fee, ...rest}) => rest)(q.txRequest!)}),
    trackIntent: async () => ({state: "pending"}),
    ...over,
  };
}
const options = {fromToken: "USDC", toToken: "0x0000000000000000000000000000000000000000", toChain: 8453, recipient: ME, fromTokenAmount: AMOUNT, minAmountOut: 396_000_000_000_000n};

interface Log { sent: {to?: string; data?: string; value?: bigint; gasLimit?: bigint}[]; signed: unknown[]; estimated: {data?: string; gasLimit?: bigint}[]; order?: string[] }
function account(log: Log, over: Record<string, unknown> = {}) {
  return {
    getAddress: async () => ME,
    getChainId: async () => 8453,
    getBalance: async () => 10n ** 18n,
    getAllowance: async () => 0n,
    quoteSendTransaction: async (t: {data?: string; gasLimit?: bigint}) => { log.estimated.push(t); return {fee: 1n}; },
    sendTransaction: async (t: {to?: string; data?: string; value?: bigint; gasLimit?: bigint}) => { log.sent.push(t); log.order?.push(`send:${t.data?.slice(0, 10)}`); return {hash: `0x${log.sent.length}`}; },
    waitForTransaction: async () => {},
    signTypedData: async (args: unknown) => { log.signed.push(args); log.order?.push("sign"); return SIG; },
    ...over,
  };
}
function protocol(p: CrossChainProvider, acc: unknown, review?: (plan: Swap2ExecutionPlan) => unknown) {
  class P extends SingleProviderSwap2 {
    protected readonly provider = p;
    protected chainSupported(): boolean { return true; }
  }
  return new P(acc as never, {fromChain: "eip155:8453", ...(review ? {reviewExecution: review as never} : {})});
}
const fresh = (): Log => ({sent: [], signed: [], estimated: []});
const APPROVE = (amount: bigint) => `0x095ea7b3${PERMIT2_ADDRESS.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;

describe("Permit2 signature-transfer execution", () => {
  it("approves Permit2 for exactly the input, signs the rebuilt typed data, appends the signature and sends", async () => {
    const log = fresh();
    let plan: Swap2ExecutionPlan | undefined;
    const result = await protocol(provider(tx()), account(log), (p) => { plan = p; }).swap2(options);

    expect(plan!.approvals).toEqual([{token: USDC.toLowerCase(), spender: PERMIT2_ADDRESS, amount: AMOUNT, chainId: 8453}].map((a) => ({...a, token: plan!.approvals[0]!.token})));
    expect(plan!.approvals[0]!.token.toLowerCase()).toBe(USDC.toLowerCase());
    expect(plan!.source).toMatchObject({kind: "call", to: SETTLER, data: DATA, value: 0n});
    const shown = JSON.parse((plan!.source as {permit2Transfer: string}).permit2Transfer);
    expect(shown.message.permitted.amount).toBe("1000000");
    expect(shown.domain).toEqual({name: "Permit2", chainId: 8453, verifyingContract: PERMIT2_ADDRESS});

    // typed data only, with the primary type named, and nothing the provider added
    expect(log.signed).toHaveLength(1);
    const signed = log.signed[0] as {domain: unknown; types: Record<string, unknown>; primaryType: string; message: {spender: string}};
    expect(signed.primaryType).toBe("PermitTransferFrom");
    expect(Object.keys(signed.types)).toEqual(["PermitTransferFrom", "TokenPermissions"]);
    expect(signed.domain).toEqual({name: "Permit2", chainId: 8453, verifyingContract: PERMIT2_ADDRESS});
    expect(signed.message.spender).toBe(SETTLER);

    expect(log.sent.map((s) => s.to?.toLowerCase())).toEqual([USDC.toLowerCase(), SETTLER.toLowerCase()]);
    expect(log.sent[0]!.data).toBe(APPROVE(AMOUNT));
    const signedCall = `${DATA}${"0".repeat(62)}41${"cd".repeat(65)}`;
    expect(log.sent[1]).toMatchObject({to: SETTLER, data: signedCall, value: 0n});
    // the exact signed call was estimated by the account (no gas limit passed) before the broadcast…
    expect(log.estimated.at(-1)).toMatchObject({data: signedCall});
    expect(log.estimated.at(-1)!.gasLimit).toBeUndefined();
    // …and goes out with that estimate: the quoted gas limit is neither shown in the plan nor sent.
    expect(log.sent[1]!.gasLimit).toBeUndefined();
    expect((plan!.source as {gasLimit?: bigint}).gasLimit).toBeUndefined();
    expect(result.hash).toBe("0x2");
  });

  const ordered = (log: Log, over: Record<string, unknown> = {}) => account(log, {
    quoteSendTransaction: async (t: {data?: string; gasLimit?: bigint}) => { log.estimated.push(t); log.order!.push(`${t.gasLimit ? "fee-check" : "estimate"}:${t.data?.slice(0, 10)}${t.data && t.data.length > DATA.length ? "+sig" : ""}`); return {fee: 1n}; },
    ...over,
  });

  it("with an approval to send, signs only once it is mined and the provider's preflight passed, then dry-runs the signed call", async () => {
    const log: Log = {...fresh(), order: []};
    const phases: string[] = [];
    const p = provider(tx(), {preflightDeposit: async () => { log.order!.push("preflight"); }});
    class P extends SingleProviderSwap2 {
      protected readonly provider = p;
      protected chainSupported(): boolean { return true; }
    }
    await new P(ordered(log) as never, {fromChain: "eip155:8453", onExecutionPhase: (phase) => { phases.push(phase); }}).swap2(options);
    // The gas pre-check prices the approval and the unsigned call (at its quoted limit, so it is not estimated unsigned).
    expect(log.order).toEqual(["estimate:0x095ea7b3", "fee-check:0x1fff991f", "send:0x095ea7b3", "preflight", "sign", "estimate:0x1fff991f+sig", "send:0x1fff991f"]);
    // One "signing" phase covers the permit and the transaction (SDK-319).
    expect(phases).toEqual(["approving", "preflight", "signing", "broadcast"]);
  });

  it("with the Permit2 allowance already in place, signs first, as before", async () => {
    const log: Log = {...fresh(), order: []};
    await protocol(provider(tx()), ordered(log, {getAllowance: async () => AMOUNT})).swap2(options);
    expect(log.order).toEqual(["fee-check:0x1fff991f", "sign", "estimate:0x1fff991f+sig", "send:0x1fff991f"]);
    expect(log.signed).toHaveLength(1);
  });

  describe("an approval mined after the quote expired (2026-11-17, 0x on Ethereum: permit → approve → permit)", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("re-quotes and asks for the permit once: approve → sign → send", async () => {
      vi.useFakeTimers({toFake: ["Date"]});
      const log: Log = {...fresh(), order: []};
      let quotes = 0;
      const base = provider(tx());
      const p = provider(tx(), {getQuote: async (params) => { quotes++; log.order!.push("quote"); return base.getQuote(params); }});
      // The approval takes a minute to mine: the 30 s quote is gone by then.
      const acc = ordered(log, {waitForTransaction: async () => { vi.setSystemTime(Date.now() + 60_000); }});
      const result = await protocol(p, acc).swap2(options);
      expect(quotes).toBe(2);
      expect(log.signed).toHaveLength(1);
      expect(log.order!.filter((o) => !o.startsWith("estimate") && !o.startsWith("fee-check"))).toEqual(["quote", "send:0x095ea7b3", "quote", "sign", "send:0x1fff991f"]);
      expect(log.sent.map((s) => s.to?.toLowerCase())).toEqual([USDC.toLowerCase(), SETTLER.toLowerCase()]);
      expect(result.hash).toBe("0x2");
    });
  });

  it("a quoted gas limit far below what the call needs is not used: the broadcast carries the account's estimate", async () => {
    const log = fresh();
    await protocol(provider(tx({gasLimit: "21000"})), account(log)).swap2(options);
    expect(log.sent.at(-1)!.to).toBe(SETTLER);
    expect(log.sent.at(-1)!.gasLimit).toBeUndefined();
  });

  it("leaves a Permit2 allowance that already covers the input alone", async () => {
    const log = fresh();
    let plan: Swap2ExecutionPlan | undefined;
    await protocol(provider(tx()), account(log, {getAllowance: async () => (1n << 256n) - 1n}), (p) => { plan = p; }).swap2(options);
    expect(plan!.approvals).toEqual([]);
    expect(log.sent).toHaveLength(1);
    expect(log.sent[0]!.to).toBe(SETTLER);
  });

  it("a signed call that does not simulate is not sent, and the Permit2 allowance stays (signature transfer only)", async () => {
    const log = fresh();
    const acc = account(log, {quoteSendTransaction: async (t: {data?: string}) => { if (t.data?.endsWith("cd".repeat(65))) throw new Error("execution reverted"); return {fee: 1n}; }});
    const err = await protocol(provider(tx()), acc).swap2(options).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/signed swap does not simulate from this account \(execution reverted\) — nothing was sent/);
    expect(refusalOf(err)?.reason).toBe("simulation_failed");
    // The approval, then nothing: no approve(Permit2, 0).
    expect(log.sent.map((s) => s.data)).toEqual([APPROVE(AMOUNT)]);
  });

  it("an account without signTypedData cannot run it: nothing goes out, not even the approval", async () => {
    const log = fresh();
    await expect(protocol(provider(tx()), account(log, {signTypedData: undefined})).swap2(options)).rejects.toThrow(/needs an account with signTypedData/);
    expect(log.sent).toEqual([]);
  });

  it("a signature declined with the allowance already in place sends nothing", async () => {
    const log = fresh();
    await expect(protocol(provider(tx()), account(log, {getAllowance: async () => AMOUNT, signTypedData: async () => { throw new Error("User rejected the request"); }})).swap2(options)).rejects.toThrow(/User rejected the request/);
    expect(log.sent).toEqual([]);
  });

  it("a signature declined after the approval: the swap is not sent and the Permit2 allowance stays", async () => {
    const log = fresh();
    await expect(protocol(provider(tx()), account(log, {signTypedData: async () => { throw new Error("User rejected the request"); }})).swap2(options)).rejects.toThrow(/User rejected the request/);
    expect(log.sent.map((s) => s.data)).toEqual([APPROVE(AMOUNT)]);
  });

  it("a signature the account returns malformed is refused: nothing is sent but the approval", async () => {
    const standing = fresh();
    await expect(protocol(provider(tx()), account(standing, {getAllowance: async () => AMOUNT, signTypedData: async () => "0x1234"})).swap2(options)).rejects.toThrow(/no usable signature/);
    expect(standing.sent).toEqual([]);
    const approved = fresh();
    await expect(protocol(provider(tx()), account(approved, {signTypedData: async () => "0x1234"})).swap2(options)).rejects.toThrow(/no usable signature/);
    expect(approved.sent.map((s) => s.data)).toEqual([APPROVE(AMOUNT)]);
  });

  it("a deadline that passes between the quote and the signature is quote_expired, with nothing sent", async () => {
    const log = fresh();
    // The quote itself may not outlive the permit, so the clock is moved past the deadline right before signing.
    const deadline = now() + 120;
    const realNow = Date.now;
    const acc = account(log, {getAllowance: async () => AMOUNT, getBalance: async () => { Date.now = () => (deadline + 1) * 1000; return 10n ** 18n; }});
    try {
      const err = await protocol(provider(tx({permit2Transfer: typed((t) => { t.message.deadline = String(deadline); })})), acc).swap2(options).catch((e: unknown) => e);
      expect((err as Error).message).toBe("swap2: the Permit2 signature deadline passed before signing — nothing was sent");
      expect(refusalOf(err)?.reason).toBe("quote_expired");
    } finally {
      Date.now = realNow;
    }
    expect(log.sent).toEqual([]);
    expect(log.signed).toEqual([]);
  });

  it("a deadline that passes after the approval (during the provider's preflight) is quote_expired, and the Permit2 allowance stays", async () => {
    const log = fresh();
    const deadline = now() + 120;
    const realNow = Date.now;
    const p = provider(tx({permit2Transfer: typed((t) => { t.message.deadline = String(deadline); })}), {preflightDeposit: async () => { Date.now = () => (deadline + 1) * 1000; }});
    try {
      const err = await protocol(p, account(log)).swap2(options).catch((e: unknown) => e);
      expect((err as Error).message).toBe("swap2: the Permit2 signature deadline passed before signing — the swap was not sent and the Permit2 allowance was left in place (it moves nothing without a new signature)");
      expect(refusalOf(err)?.reason).toBe("quote_expired");
    } finally {
      Date.now = realNow;
    }
    expect(log.signed).toEqual([]);
    expect(log.sent.map((s) => s.data)).toEqual([APPROVE(AMOUNT)]);
  });

  // 2026-11-19, cp0x Swap web, 0x on Ethereum (DAI → ETH): the dry run right after the mined approval reverted, the
  // engine revoked Permit2 — two approval transactions paid, no swap.
  describe("a dry run that fails after the approval this execution mined", () => {
    const revertOnce = (log: Log, failures = 1) => {
      let left = failures;
      return account(log, {quoteSendTransaction: async (t: {data?: string; gasLimit?: bigint}) => {
        log.estimated.push(t);
        if (t.data?.endsWith("cd".repeat(65)) && left > 0) { left--; throw new Error("execution reverted"); }
        return {fee: 1n};
      }});
    };

    it("is quoted once more on the same allowance and goes out: one approval, no approve(0)", async () => {
      const log = fresh();
      const phases: string[] = [];
      let quotes = 0;
      const base = provider(tx());
      const p = provider(tx(), {getQuote: async (params) => { quotes++; return base.getQuote(params); }});
      class P extends SingleProviderSwap2 {
        protected readonly provider = p;
        protected chainSupported(): boolean { return true; }
      }
      const result = await new P(revertOnce(log) as never, {fromChain: "eip155:8453", onExecutionPhase: (phase) => { phases.push(phase); }}).swap2(options);
      expect(quotes).toBe(2);
      expect(log.sent.map((s) => s.data?.slice(0, 10))).toEqual(["0x095ea7b3", "0x1fff991f"]);
      expect(log.sent[0]!.data).toBe(APPROVE(AMOUNT));
      expect(phases).toEqual(["approving", "signing", "requoting", "signing", "broadcast"]);
      // The first permit went into the failed dry run only; the re-quote's permit is the one sent.
      expect(log.signed).toHaveLength(2);
      expect(result.hash).toBe("0x2");
    });

    it("re-quotes once only: when the second pass fails too, nothing more is sent (the Permit2 allowance stays)", async () => {
      const log = fresh();
      let quotes = 0;
      const base = provider(tx());
      const p = provider(tx(), {getQuote: async (params) => { quotes++; return base.getQuote(params); }});
      const err = await protocol(p, revertOnce(log, 5)).swap2(options).catch((e: unknown) => e);
      expect(refusalOf(err)?.reason).toBe("simulation_failed");
      expect(quotes).toBe(2);
      expect(log.sent.map((s) => s.data)).toEqual([APPROVE(AMOUNT)]);
    });

    it("the re-quote is reviewed again when it pays out less, flagged requoted", async () => {
      const log = fresh();
      const plans: Swap2ExecutionPlan[] = [];
      let quotes = 0;
      const base = provider(tx());
      const p = provider(tx(), {getQuote: async (params) => { quotes++; const q = await base.getQuote(params); return quotes === 1 ? q : {...q!, destAmount: "399000000000000"}; }});
      await protocol(p, revertOnce(log), (plan) => { plans.push(plan); }).swap2(options);
      expect(plans.map((x) => x.requoted)).toEqual([undefined, true]);
      expect(plans[1]!.destAmount).toBe(399_000_000_000_000n);
      expect(plans[1]!.minDestAmount).toBe(396_000_000_000_000n);
    });

    it("the re-quote is held to the caller's floor: below it, refused, and nothing more is sent", async () => {
      const log = fresh();
      let quotes = 0;
      const base = provider(tx());
      const p = provider(tx(), {getQuote: async (params) => { quotes++; const q = await base.getQuote(params); return quotes === 1 ? q : {...q!, destAmount: "390000000000000", minDestAmount: "386000000000000"}; }});
      await expect(protocol(p, revertOnce(log)).swap2(options)).rejects.toThrow();
      expect(log.sent.map((s) => s.data)).toEqual([APPROVE(AMOUNT)]);
    });

    it("with the Permit2 allowance already in place (nothing approved), a failed dry run is not re-quoted", async () => {
      const log = fresh();
      let quotes = 0;
      const base = provider(tx());
      const p = provider(tx(), {getQuote: async (params) => { quotes++; return base.getQuote(params); }});
      const acc = {...revertOnce(log), getAllowance: async () => AMOUNT};
      await expect(protocol(p, acc).swap2(options)).rejects.toThrow(/does not simulate/);
      expect(quotes).toBe(1);
      expect(log.sent).toEqual([]);
    });
  });

  describe("a spender other than Permit2 (a router allowance, ownGasEstimate)", () => {
    const ROUTER_APPROVE = (amount: bigint) => `0x095ea7b3${SETTLER.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
    const plain = (): TxRequest => ({to: SETTLER, data: DATA, value: "0", chainId: 8453, gasLimit: "400000", approvalAddress: SETTLER});
    const reverting = (log: Log, failures: number) => {
      let left = failures;
      return account(log, {quoteSendTransaction: async (t: {to?: string; data?: string; gasLimit?: bigint}) => {
        log.estimated.push(t);
        if (t.to === SETTLER && t.gasLimit === undefined && left > 0) { left--; throw new Error("execution reverted"); }
        return {fee: 1n};
      }});
    };

    it("a dry run that fails after its approval is re-quoted and goes out, with no revoke", async () => {
      const log = fresh();
      await protocol(provider(plain(), {ownGasEstimate: true}), reverting(log, 1)).swap2(options);
      expect(log.sent.map((s) => s.data)).toEqual([ROUTER_APPROVE(AMOUNT), DATA]);
    });

    it("when the re-quote fails too, the allowance is revoked exactly once", async () => {
      const log = fresh();
      const err = await protocol(provider(plain(), {ownGasEstimate: true}), reverting(log, 5)).swap2(options).catch((e: unknown) => e);
      expect(refusalOf(err)?.reason).toBe("simulation_failed");
      expect(log.sent.map((s) => s.data)).toEqual([ROUTER_APPROVE(AMOUNT), ROUTER_APPROVE(0n)]);
    });

    it("a declined review of the re-quote revokes it once", async () => {
      const log = fresh();
      let quotes = 0;
      const base = provider(plain(), {ownGasEstimate: true});
      const p = {...base, getQuote: async (params: QuoteParams) => { quotes++; const q = await base.getQuote(params); return quotes === 1 ? q : {...q!, destAmount: "399000000000000"}; }};
      let reviews = 0;
      await expect(protocol(p, reverting(log, 1), () => { if (++reviews === 2) throw new Error("declined"); }).swap2(options)).rejects.toThrow(/declined/);
      expect(log.sent.map((s) => s.data)).toEqual([ROUTER_APPROVE(AMOUNT), ROUTER_APPROVE(0n)]);
    });
  });

  describe("simulation_failed names the revert", () => {
    // viem's eth_estimateGas revert: EstimateGasExecutionError → ExecutionRevertedError → RpcRequestError {data}.
    const viemRevert = (data: string) => {
      const rpc = Object.assign(new Error("RPC Request failed."), {name: "RpcRequestError", code: 3, data});
      const node = Object.assign(new Error("Execution reverted for an unknown reason.", {cause: rpc}), {name: "ExecutionRevertedError", code: 3});
      return Object.assign(new Error(`Execution reverted for an unknown reason.\n\nRequest Arguments:\n  from: ${ME}\n  data: ${DATA}`, {cause: node}), {name: "EstimateGasExecutionError"});
    };
    const failWith = async (error: () => Error) => {
      const log = fresh();
      const acc = account(log, {getAllowance: async () => AMOUNT, quoteSendTransaction: async (t: {data?: string}) => { if (t.data?.endsWith("cd".repeat(65))) throw error(); return {fee: 1n}; }});
      return protocol(provider(tx()), acc).swap2(options).catch((e: unknown) => e) as Promise<Error>;
    };
    const word = (s: string) => `0x08c379a0${(32n).toString(16).padStart(64, "0")}${s.length.toString(16).padStart(64, "0")}${Buffer.from(s).toString("hex").padEnd(64, "0")}`;

    it("a known custom error: its selector and name, no arguments", async () => {
      const err = await failWith(() => viemRevert(`0x97a6f3b9${USDC.slice(2).toLowerCase().padStart(64, "0")}${(10n ** 18n).toString(16).padStart(64, "0")}${(9n * 10n ** 17n).toString(16).padStart(64, "0")}`));
      expect(err.message).toBe("swap2: the signed swap does not simulate from this account (reverted: 0x97a6f3b9 TooMuchSlippage) — nothing was sent");
      expect(refusalOf(err)?.reason).toBe("simulation_failed");
      expect(err.message).not.toMatch(new RegExp(USDC.slice(2), "i"));
    });

    it("an unknown custom error: the selector alone; viem's ContractFunctionRevertedError `raw` is read too", async () => {
      expect((await failWith(() => viemRevert("0xdeadbeef"))).message).toMatch(/\(reverted: 0xdeadbeef\)/);
      const contract = () => Object.assign(new Error("The contract function reverted."), {name: "ContractFunctionRevertedError", raw: "0x756688fe", data: {errorName: "InvalidNonce"}});
      expect((await failWith(contract)).message).toMatch(/\(reverted: 0x756688fe InvalidNonce\)/);
    });

    it("Error(string): the reason when it is plain words, the selector alone when it carries digits", async () => {
      expect((await failWith(() => viemRevert(word("TRANSFER_FROM_FAILED")))).message).toMatch(/\(reverted: 0x08c379a0 Error\("TRANSFER_FROM_FAILED"\)\)/);
      expect((await failWith(() => viemRevert(word("min out 12345")))).message).toMatch(/\(reverted: 0x08c379a0 Error\) —/);
    });

    it("without revert data: the node's message, as before", async () => {
      expect((await failWith(() => new Error("execution reverted"))).message).toMatch(/\(execution reverted\) — nothing was sent/);
    });
  });

  const refused: [string, TxRequest, RegExp, Swap2RefusalReason][] = [
    ["a spender other than Permit2 for the allowance", tx({approvalAddress: SETTLER}), /allowance it needs is not Permit2's/, "vault_mismatch"],
    ["no allowance target", without("approvalAddress"), /allowance it needs is not Permit2's/, "vault_mismatch"],
    ["a permit for another spender than the called contract", tx({permit2Transfer: typed((t) => { t.message.spender = "0x9999999999999999999999999999999999999999"; })}), /spender is not the contract the swap calls/, "vault_mismatch"],
    ["a permit for more than the input", tx({permit2Transfer: typed((t) => { t.message.permitted.amount = "1000001"; })}), /permitted amount is not the swap's 1000000/, "price_check_failed"],
    ["a permit for another token", tx({permit2Transfer: typed((t) => { t.message.permitted.token = "0x4200000000000000000000000000000000000006"; })}), /permitted token is not the source token/, "price_check_failed"],
    ["a permit on another chain", tx({permit2Transfer: typed((t) => { t.domain.chainId = 1; })}), /domain chainId is not the source chain/, "vault_mismatch"],
    ["an allowance permit (PermitSingle)", tx({permit2Transfer: typed((t) => { t.primaryType = "PermitSingle"; })}), /is not PermitTransferFrom/, "policy_refused"],
    ["a permit that expires before the quote does", tx({permit2Transfer: typed((t) => { t.message.deadline = String(now() + 5); })}), /quote is valid for longer than its signature deadline/, "policy_refused"],
    ["a permit riding in a token call", tx({to: USDC, data: `0xa9059cbb${ME.slice(2).padStart(64, "0")}${"0".repeat(63)}1`, permit2Transfer: typed((t) => { t.message.spender = USDC; })}), /spender is Permit2, the token itself or the zero address/, "vault_mismatch"],
    ["a permit whose spender is this account", tx({to: ME, permit2Transfer: typed((t) => { t.message.spender = ME; })}), /the spender is this account/, "vault_mismatch"],
  ];
  for (const [name, request, why, reason] of refused) {
    it(`refuses ${name} before anything is approved or signed (${reason})`, async () => {
      const log = fresh();
      const err = await protocol(provider(request), account(log)).swap2(options).catch((e: unknown) => e);
      expect((err as Error).message).toMatch(why);
      expect(refusalOf(err)?.reason).toBe(reason);
      expect(log).toEqual({sent: [], signed: [], estimated: []});
    });
  }

  it("refuses a native-coin input, a typed order next to it, and a build that changes the permit", async () => {
    const log = fresh();
    // A permit riding with native value is refused with the quote itself (policy_refused), before the engine's own
    // "nothing to permit" check could see it.
    const native = await protocol(provider(tx({value: AMOUNT.toString()})), account(log)).swap2({...options, fromToken: "ETH", toToken: USDC}).catch((e: unknown) => e);
    expect((native as Error).message).toMatch(/permit2: rejected by validation/);
    expect(refusalOf(native)?.reason).toBe("policy_refused");
    const ambiguous = await protocol(provider(tx(), {buildDeposit: async (q) => ({chain: "", to: SETTLER, value: "0", data: DATA, chainId: 8453, gasLimit: "400000", approvalAddress: PERMIT2_ADDRESS, permit2Transfer: q.txRequest!.permit2Transfer!, typedData: "{}"})}), account(log)).swap2(options).catch((e: unknown) => e);
    expect((ambiguous as Error).message).toBe("swap2: provider returned ambiguous execution payloads");
    expect(refusalOf(ambiguous)?.reason).toBe("policy_refused");
    await expect(protocol(provider(tx(), {buildDeposit: async () => ({chain: "", to: SETTLER, value: "0", data: DATA, chainId: 8453, gasLimit: "400000", approvalAddress: PERMIT2_ADDRESS, permit2Transfer: typed((t) => { t.message.nonce = "7"; })})}), account(log)).swap2(options))
      .rejects.toThrow(/build does not match the validated quote transaction/);
    await expect(protocol(provider(tx(), {buildDeposit: async () => ({chain: "", to: SETTLER, value: "0", data: DATA, chainId: 8453, gasLimit: "400000", approvalAddress: PERMIT2_ADDRESS})}), account(log)).swap2(options))
      .rejects.toThrow(/build does not match the validated quote transaction/);
    expect(log).toEqual({sent: [], signed: [], estimated: []});
  });

  it("a remote stub's Permit2 swap needs the app's pins and its own check of the calldata", async () => {
    const log = fresh();
    const base = provider(tx());
    const unpinned = {...base, remote: true as const};
    await expect(protocol(unpinned, account(log)).swap2(options)).rejects.toThrow(/did not pin as a spender/);
    const pinned = {...unpinned, spenders: () => [PERMIT2_ADDRESS], callTargets: () => [SETTLER]};
    await expect(protocol(pinned, account(log)).swap2(options)).rejects.toThrow(/calldata is not checked by the app/);
    expect(log.sent).toEqual([]);
    await protocol({...pinned, verifiesQuotes: true as const}, account(log)).swap2(options);
    expect(log.sent).toHaveLength(2);
  });

  it("without a quoted gas limit the unsigned call is not estimated before the signature exists", async () => {
    const log = fresh();
    const acc = account(log, {
      getAllowance: async () => AMOUNT,
      quoteSendTransaction: async (t: {data?: string}) => { log.estimated.push(t); if (t.data === DATA) throw new Error("execution reverted"); return {fee: 1n}; },
    });
    await protocol(provider(without("gasLimit")), acc).swap2(options);
    expect(log.sent).toHaveLength(1);
    expect(log.sent[0]!.gasLimit).toBeUndefined();
  });
});

describe("Permit2 transfer on the wire", () => {
  const PARAMS: QuoteParams = {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:8453", destToken: "0x0000000000000000000000000000000000000000", amountIn: AMOUNT.toString(), destAddress: ME, refundAddress: ME};

  it("validQuote wants a string", () => {
    const q: Quote = {provider: "permit2", intentId: "i", depositAddress: "", depositMemo: null, txRequest: tx(), sourceAmount: AMOUNT.toString(), destAmount: "400", minDestAmount: "399", feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 10_000};
    expect(validQuote(q, PARAMS, "permit2")).toBe(true);
    expect(validQuote({...q, txRequest: {...tx(), permit2Transfer: {} as never}}, PARAMS, "permit2")).toBe(false);
  });

  it("survives the server's seal and comes back in build and preflight", async () => {
    const request = tx();
    let preflight: UnsignedTx | undefined;
    const p = provider(request, {preflightDeposit: async (_q, t) => { preflight = t; }});
    const handle = createSwap2Handler({providers: [p], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}});
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "user");
      return new Response(JSON.stringify(res.body), {status: res.status});
    }) as unknown as typeof fetch;
    const client = remoteProvider({name: "permit2", baseUrl: "https://api.example.test/swap2", fetchImpl});
    const q = await client.getQuote(PARAMS);
    expect(q!.txRequest!.permit2Transfer).toBe(request.permit2Transfer);
    const built = await client.buildDeposit(q!);
    expect(built.permit2Transfer).toBe(request.permit2Transfer);
    await client.preflightDeposit!(q!, built);
    expect(preflight!.permit2Transfer).toBe(request.permit2Transfer);
    // a permit changed after sealing breaks the seal
    await expect(client.buildDeposit({...q!, txRequest: {...q!.txRequest!, permit2Transfer: typed((t) => { t.message.nonce = "9"; })}})).rejects.toThrow(/integrity/);
  });
});
