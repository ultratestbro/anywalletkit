import {describe, expect, it} from "vitest";
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

  const refusals: [string, (t: Typed) => void, RegExp][] = [
    ["another token", (t) => { t.message.permitted.token = "0x4200000000000000000000000000000000000006"; }, /permitted token is not the source token/],
    ["a larger amount", (t) => { t.message.permitted.amount = (AMOUNT + 1n).toString(); }, /permitted amount is not the swap's 1000000/],
    ["a smaller amount", (t) => { t.message.permitted.amount = (AMOUNT - 1n).toString(); }, /permitted amount is not the swap's/],
    ["an unlimited amount", (t) => { t.message.permitted.amount = ((1n << 256n) - 1n).toString(); }, /permitted amount is not the swap's/],
    ["another spender", (t) => { t.message.spender = "0x9999999999999999999999999999999999999999"; }, /spender is not the contract the swap calls/],
    ["another domain name", (t) => { t.domain.name = "Permit3"; }, /domain name is not Permit2/],
    ["another chain", (t) => { t.domain.chainId = 1; }, /domain chainId is not the source chain 8453/],
    ["another verifying contract", (t) => { t.domain.verifyingContract = "0x0000000000225e31D15943971F47aD3022F714Fa"; }, /verifying contract is not Permit2/],
    ["an extra domain field", (t) => { t.domain.salt = "0x00"; }, /domain is not \{name, chainId, verifyingContract\}/],
    ["a passed deadline", (t) => { t.message.deadline = String(now() - 1); }, /deadline has passed/],
    ["a far deadline", (t) => { t.message.deadline = String(now() + 3 * 3600); }, /deadline is more than 3600 s away/],
    ["a deadline that is not a number", (t) => { t.message.deadline = "soon"; }, /deadline has passed or is not a uint256/],
    ["a nonce that is not a uint256", (t) => { t.message.nonce = "-1"; }, /nonce is not a uint256/],
    ["a witness type", (t) => { t.types.Witness = [{name: "x", type: "uint256"}]; }, /unexpected type Witness/],
    ["a reordered PermitTransferFrom", (t) => { t.types.PermitTransferFrom = [...(t.types.PermitTransferFrom as unknown[])].reverse(); }, /types are not Permit2's/],
    ["an extra message field", (t) => { t.message.witness = "0x00"; }, /message is not \{permitted, spender, nonce, deadline\}/],
    ["an allowance permit", (t) => { t.primaryType = "PermitSingle"; }, /primaryType PermitSingle is not PermitTransferFrom/],
  ];
  for (const [name, tamper, why] of refusals) {
    it(`refuses ${name}`, () => expect(() => readPermit2Transfer(typed(tamper), expected)).toThrow(why));
  }

  it("refuses what is not JSON, and a spender that is Permit2 or the token", () => {
    expect(() => readPermit2Transfer("{", expected)).toThrow(/not JSON/);
    expect(() => readPermit2Transfer(typed((t) => { t.message.spender = PERMIT2_ADDRESS; }), {...expected, spender: PERMIT2_ADDRESS})).toThrow(/spender is Permit2, the token itself or the zero address/);
    expect(() => readPermit2Transfer(typed((t) => { t.message.spender = USDC; }), {...expected, spender: USDC})).toThrow(/spender is Permit2/);
  });
});

describe("appendPermit2Signature", () => {
  it("appends uint256(length) and the signature", () => {
    const sig = `0x${"ab".repeat(65)}`;
    expect(appendPermit2Signature("0x1fff991f", sig)).toBe(`0x1fff991f${"0".repeat(62)}41${"ab".repeat(65)}`);
  });
  it("refuses a missing, short or non-hex signature", () => {
    for (const bad of ["", "0x", "0xsig", `0x${"ab".repeat(63)}`, `0x${"ab".repeat(2049)}`]) expect(() => appendPermit2Signature("0x1fff991f", bad)).toThrow(/no usable signature/);
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

interface Log { sent: {to?: string; data?: string; value?: bigint; gasLimit?: bigint}[]; signed: unknown[]; estimated: {data?: string; gasLimit?: bigint}[] }
function account(log: Log, over: Record<string, unknown> = {}) {
  return {
    getAddress: async () => ME,
    getChainId: async () => 8453,
    getBalance: async () => 10n ** 18n,
    getAllowance: async () => 0n,
    quoteSendTransaction: async (t: {data?: string; gasLimit?: bigint}) => { log.estimated.push(t); return {fee: 1n}; },
    sendTransaction: async (t: {to?: string; data?: string; value?: bigint; gasLimit?: bigint}) => { log.sent.push(t); return {hash: `0x${log.sent.length}`}; },
    waitForTransaction: async () => {},
    signTypedData: async (args: unknown) => { log.signed.push(args); return SIG; },
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
    expect(log.sent[1]).toMatchObject({to: SETTLER, data: signedCall, value: 0n, gasLimit: 400_000n});
    // the exact signed call was estimated by the account (no gas limit passed) before the broadcast
    expect(log.estimated.at(-1)).toMatchObject({data: signedCall});
    expect(log.estimated.at(-1)!.gasLimit).toBeUndefined();
    expect(result.hash).toBe("0x2");
  });

  it("leaves a Permit2 allowance that already covers the input alone", async () => {
    const log = fresh();
    let plan: Swap2ExecutionPlan | undefined;
    await protocol(provider(tx()), account(log, {getAllowance: async () => (1n << 256n) - 1n}), (p) => { plan = p; }).swap2(options);
    expect(plan!.approvals).toEqual([]);
    expect(log.sent).toHaveLength(1);
    expect(log.sent[0]!.to).toBe(SETTLER);
  });

  it("a signed call that does not simulate is not sent, and the allowance is revoked", async () => {
    const log = fresh();
    const acc = account(log, {quoteSendTransaction: async (t: {data?: string}) => { if (t.data?.endsWith("cd".repeat(65))) throw new Error("execution reverted"); return {fee: 1n}; }});
    await expect(protocol(provider(tx()), acc).swap2(options)).rejects.toThrow(/signed swap does not simulate from this account \(execution reverted\) — nothing was sent/);
    expect(log.sent.map((s) => s.data)).toEqual([APPROVE(AMOUNT), APPROVE(0n)]);
  });

  it("an account without signTypedData cannot run it: nothing but the approval and its revocation goes out", async () => {
    const log = fresh();
    await expect(protocol(provider(tx()), account(log, {signTypedData: undefined})).swap2(options)).rejects.toThrow(/needs an account with signTypedData/);
    expect(log.sent.map((s) => s.data)).toEqual([APPROVE(AMOUNT), APPROVE(0n)]);
  });

  it("a signature the account returns malformed is refused before sending", async () => {
    const log = fresh();
    await expect(protocol(provider(tx()), account(log, {signTypedData: async () => "0x1234"})).swap2(options)).rejects.toThrow(/no usable signature/);
    expect(log.sent.map((s) => s.data)).toEqual([APPROVE(AMOUNT), APPROVE(0n)]);
  });

  const refused: [string, TxRequest, RegExp][] = [
    ["a spender other than Permit2 for the allowance", tx({approvalAddress: SETTLER}), /allowance it needs is not Permit2's/],
    ["no allowance target", without("approvalAddress"), /allowance it needs is not Permit2's/],
    ["a permit for another spender than the called contract", tx({permit2Transfer: typed((t) => { t.message.spender = "0x9999999999999999999999999999999999999999"; })}), /spender is not the contract the swap calls/],
    ["a permit for more than the input", tx({permit2Transfer: typed((t) => { t.message.permitted.amount = "1000001"; })}), /permitted amount is not the swap's 1000000/],
    ["a permit for another token", tx({permit2Transfer: typed((t) => { t.message.permitted.token = "0x4200000000000000000000000000000000000006"; })}), /permitted token is not the source token/],
    ["a permit on another chain", tx({permit2Transfer: typed((t) => { t.domain.chainId = 1; })}), /domain chainId is not the source chain/],
    ["an allowance permit (PermitSingle)", tx({permit2Transfer: typed((t) => { t.primaryType = "PermitSingle"; })}), /is not PermitTransferFrom/],
    ["a permit that expires before the quote does", tx({permit2Transfer: typed((t) => { t.message.deadline = String(now() + 5); })}), /quote is valid for longer than its signature deadline/],
    ["a permit riding in a token call", tx({to: USDC, data: `0xa9059cbb${ME.slice(2).padStart(64, "0")}${"0".repeat(63)}1`, permit2Transfer: typed((t) => { t.message.spender = USDC; })}), /spender is Permit2, the token itself or the zero address/],
  ];
  for (const [name, request, why] of refused) {
    it(`refuses ${name} before anything is approved or signed`, async () => {
      const log = fresh();
      await expect(protocol(provider(request), account(log)).swap2(options)).rejects.toThrow(why);
      expect(log).toEqual({sent: [], signed: [], estimated: []});
    });
  }

  it("refuses a native-coin input, a typed order next to it, and a build that changes the permit", async () => {
    const log = fresh();
    await expect(protocol(provider(tx({value: AMOUNT.toString()})), account(log)).swap2({...options, fromToken: "ETH", toToken: USDC})).rejects.toThrow(/native-coin input has nothing to permit/);
    await expect(protocol(provider(tx(), {buildDeposit: async (q) => ({chain: "", to: SETTLER, value: "0", data: DATA, chainId: 8453, gasLimit: "400000", approvalAddress: PERMIT2_ADDRESS, permit2Transfer: q.txRequest!.permit2Transfer!, typedData: "{}"})}), account(log)).swap2(options))
      .rejects.toThrow(/ambiguous execution payloads/);
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
