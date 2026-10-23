import {afterEach, describe, expect, it, vi} from "vitest";
import {readFileSync} from "node:fs";
import {decompileTransactionMessage, getCompiledTransactionMessageDecoder, getTransactionDecoder, type Address} from "@solana/kit";
import {jupiterProvider} from "../src/provider.js";
import {COMPUTE_BUDGET_PROGRAM, JUPITER_PROGRAM, WSOL_MINT} from "../src/config.js";
import {decodeComputeBudget, fromBase64, toBase64} from "../src/codec.js";

type Recorded = {request: Record<string, string | number>; response: Record<string, unknown> & {swapInstruction: {programId: string; data: string; accounts: {pubkey: string; isSigner: boolean; isWritable: boolean}[]}}};
const file = JSON.parse(readFileSync(new URL("../fixtures/build-2026-10-23.json", import.meta.url), "utf8")) as {taker: string; responses: Record<string, Recorded>};
const T = file.taker;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const rec = (k: string) => structuredClone(file.responses[k]!.response);
const SOL_USDC = {sourceChain: "solana:mainnet", sourceToken: "SOL", destChain: "solana:mainnet", destToken: USDC, amountIn: "100000000", slippageBps: 50, destAddress: T, refundAddress: T, dry: false};

function stub(answer: Record<string, unknown> | Response, rpc?: (body: {method: string; params: unknown[]}) => unknown) {
  const seen: {url: string; headers?: Record<string, string>; body?: {method: string; params: unknown[]}}[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({url, headers: init?.headers as Record<string, string>, body});
    if (url.includes("/build?")) return answer instanceof Response ? answer : new Response(JSON.stringify(answer));
    if (rpc && body) return new Response(JSON.stringify({jsonrpc: "2.0", id: 1, result: rpc(body)}));
    return new Response("{}", {status: 404});
  }));
  return seen;
}
afterEach(() => vi.unstubAllGlobals());

const refusal = async (answer: Record<string, unknown>, params: Record<string, unknown> = SOL_USDC) => {
  stub(answer);
  const reasons: string[] = [];
  const q = await jupiterProvider().getQuote({...(params as typeof SOL_USDC), onRefusal: (r) => reasons.push(r)});
  return {q, reason: reasons.join(" ")};
};

function decode(wire: string, tables: Record<string, string[]>) {
  const tx = getTransactionDecoder().decode(fromBase64(wire));
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as {version: number; addressTableLookups?: unknown[]};
  const lookup = Object.fromEntries(Object.entries(tables)) as unknown as Record<Address, Address[]>;
  const message = decompileTransactionMessage(compiled as never, {addressesByLookupTableAddress: lookup}) as unknown as {instructions: {programAddress: string; data?: Uint8Array}[]};
  return {tx, compiled, message};
}

describe("jupiter provider — live quote", () => {
  it("assembles the vetted instructions into a v0 transaction: our compute budget, Jupiter's swap, the lookup tables, the taker pays", async () => {
    const r = rec("sol_usdc");
    const seen = stub(r);
    const q = await jupiterProvider().getQuote(SOL_USDC);
    expect(q).toMatchObject({provider: "jupiter", sourceAmount: "100000000", destAmount: r.outAmount, depositAddress: "", depositMemo: null, txRequest: {value: "100000000"}});
    // Floor from the swap instruction itself: quoted · (1 − 0.5 %), rounded down.
    expect(q!.minDestAmount).toBe(((BigInt(r.outAmount as string) * 9_950n) / 10_000n).toString());
    expect(seen[0]!.url).toContain(`inputMint=${WSOL_MINT}`);
    expect(seen[0]!.url).toContain("slippageBps=50");

    const {tx, compiled, message} = decode(q!.txRequest!.serializedTx!, r.addressesByLookupTableAddress as Record<string, string[]>);
    expect(compiled.version).toBe(0);
    expect(compiled.addressTableLookups?.length).toBe(Object.keys(r.addressesByLookupTableAddress as object).length);
    expect(Object.keys(tx.signatures)).toEqual([T]); // the taker is the fee payer and the only signer
    expect(Object.values(tx.signatures).every((s) => s === null)).toBe(true); // nothing signed here
    const ixs = message.instructions;
    expect(ixs.map((i) => i.programAddress)).toEqual([COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, ...(r.setupInstructions as {programId: string}[]).map((i) => i.programId), JUPITER_PROGRAM, (r.cleanupInstruction as {programId: string}).programId]);
    expect(decodeComputeBudget(ixs[0]!.data as Uint8Array)).toEqual({limit: 1_400_000}); // no RPC → the maximum
    expect(decodeComputeBudget(ixs[1]!.data as Uint8Array).price).toBe(decodeComputeBudget(fromBase64((r.computeBudgetInstructions as {data: string}[])[0]!.data)).price);
    expect(toBase64(ixs.find((i) => i.programAddress === JUPITER_PROGRAM)!.data as Uint8Array)).toBe(r.swapInstruction.data);
    expect(q!.providerData).toMatchObject({computeUnits: "1400000", route: expect.stringContaining("TesseraV")});
    // buildDeposit reproduces the quoted transaction exactly (the engine compares them).
    expect(await jupiterProvider().buildDeposit(q!)).toEqual({chain: "solana:mainnet", to: "", value: "100000000", serializedTx: q!.txRequest!.serializedTx});
  });

  it("a token source declares no native value; the shared-accounts route assembles too", async () => {
    stub(rec("usdc_sol"));
    const q = await jupiterProvider().getQuote({...SOL_USDC, sourceToken: "USDC", destToken: "0x0000000000000000000000000000000000000000", amountIn: "25000000", slippageBps: 75});
    expect(q?.txRequest).toMatchObject({value: "0"});
  });

  it("with an RPC: the unit limit is 1.2× the simulated use and the price is capped", async () => {
    const r = rec("sol_usdc");
    const sims: unknown[] = [];
    stub(r, (b) => { sims.push(b.params[1]); return {value: {err: null, unitsConsumed: 100_000, logs: []}}; });
    const q = await jupiterProvider({rpcUrls: ["https://rpc.example"], maxComputeUnitPrice: 1_000n}).getQuote(SOL_USDC);
    expect(sims).toEqual([{encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "processed"}]);
    const {message} = decode(q!.txRequest!.serializedTx!, r.addressesByLookupTableAddress as Record<string, string[]>);
    expect(decodeComputeBudget(message.instructions[0]!.data as Uint8Array)).toEqual({limit: 120_000});
    expect(decodeComputeBudget(message.instructions[1]!.data as Uint8Array)).toEqual({price: 1_000n});
    expect(q!.fees?.[0]).toMatchObject({type: "network", amount: String(5_000 + 120)}); // 5 000 base + ceil(1 000 µlamports × 120 000 CU)
  });

  it("a failing simulation refuses the quote with the program's reason", async () => {
    stub(rec("sol_usdc"), () => ({value: {err: {InstructionError: [3, {Custom: 1}]}, logs: ["Program log: Error: insufficient funds"]}}));
    const reasons: string[] = [];
    expect(await jupiterProvider({rpcUrls: ["https://rpc.example"]}).getQuote({...SOL_USDC, onRefusal: (x) => reasons.push(x)})).toBeNull();
    expect(reasons[0]).toMatch(/simulation fails.*insufficient funds/);
  });

  it("sends the API key as x-api-key", async () => {
    const seen = stub(rec("sol_usdc"));
    await jupiterProvider({apiKey: "k-test"}).getQuote({...SOL_USDC, dry: true});
    expect(seen[0]!.headers?.["x-api-key"]).toBe("k-test");
  });
});

describe("jupiter provider — refuses what it did not ask for", () => {
  const swapData = (k: string, at: number, bytes: number[]) => {
    const r = rec(k);
    const d = fromBase64(r.swapInstruction.data);
    d.set(bytes, at);
    r.swapInstruction.data = toBase64(d);
    return r;
  };
  it("another input amount inside the swap instruction", async () => {
    expect((await refusal(swapData("sol_usdc", 8, [0x01]))).reason).toMatch(/swap instruction spends/);
  });
  it("a wider slippage inside the swap instruction", async () => {
    expect((await refusal(swapData("sol_usdc", 24, [0xe8, 0x03]))).reason).toMatch(/allows 1000 bps slippage, not 50/);
  });
  it("a platform fee or a positive-slippage cut", async () => {
    expect((await refusal(swapData("sol_usdc", 26, [0x32]))).reason).toMatch(/platform fee/);
    expect((await refusal(swapData("sol_usdc", 28, [0x32]))).reason).toMatch(/platform fee/);
  });
  it("a quoted output that differs from the answer", async () => {
    const r = rec("sol_usdc");
    r.outAmount = String(BigInt(r.outAmount as string) + 1n);
    expect((await refusal(r)).reason).toMatch(/quoted output differs/);
  });
  it("a foreign program, an extra signer or a tip", async () => {
    const foreign = rec("sol_usdc");
    (foreign.otherInstructions as unknown[]).push({programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", accounts: [], data: ""});
    expect((await refusal(foreign)).reason).toMatch(/instruction for program MemoSq4g/);
    const signer = rec("sol_usdc");
    signer.swapInstruction.accounts[1] = {...signer.swapInstruction.accounts[1]!, isSigner: true};
    expect((await refusal(signer)).reason).toMatch(/needs signer/);
    const tip = rec("sol_usdc");
    tip.tipInstruction = {programId: "11111111111111111111111111111111", accounts: [], data: ""};
    expect((await refusal(tip)).reason).toMatch(/tip/);
  });
  it("the swap aimed at another program, other mints, or a v1 transaction", async () => {
    const prog = rec("sol_usdc");
    prog.swapInstruction.programId = "11111111111111111111111111111111";
    expect((await refusal(prog)).reason).toMatch(/swap instruction targets/);
    const mint = rec("sol_usdc");
    mint.outputMint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
    expect((await refusal(mint)).reason).toMatch(/other mints/);
    const v1 = rec("sol_usdc");
    v1.transactionVersion = 1;
    expect((await refusal(v1)).reason).toMatch(/transaction version/);
  });
  it("a floor above what the instruction guarantees", async () => {
    expect((await refusal(rec("sol_usdc"), {...SOL_USDC, minAmountOut: "999999999"})).reason).toMatch(/below the floor/);
  });
  it("a recipient other than the signer, other chains, unknown tokens", async () => {
    expect((await refusal(rec("sol_usdc"), {...SOL_USDC, destAddress: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"})).reason).toMatch(/recipient must be the signing wallet/);
    expect((await refusal(rec("sol_usdc"), {...SOL_USDC, destChain: "eip155:1"})).reason).toMatch(/same-chain Solana only/);
    expect((await refusal(rec("sol_usdc"), {...SOL_USDC, sourceToken: "NOPE"})).reason).toMatch(/unknown token/);
  });
  it("an API error is a refusal with its message, not a throw", async () => {
    stub(new Response(JSON.stringify({error: "No routes found"}), {status: 400}));
    const reasons: string[] = [];
    expect(await jupiterProvider().getQuote({...SOL_USDC, onRefusal: (x) => reasons.push(x)})).toBeNull();
    expect(reasons[0]).toBe("jupiter: build 400: No routes found");
  });
});

describe("jupiter provider — dry quotes and status", () => {
  it("a dry quote carries no transaction and builds nothing", async () => {
    stub(rec("sol_usdc"));
    const q = await jupiterProvider().getQuote({...SOL_USDC, dry: true, destAddress: "", refundAddress: undefined as unknown as string});
    expect(q?.txRequest).toBeUndefined();
    await expect(jupiterProvider().buildDeposit(q!)).rejects.toThrow(/not a live quote/);
  });
  it("status from getSignatureStatuses; pending without an RPC", async () => {
    stub({}, (b) => (b.method === "getSignatureStatuses" ? {value: [{err: null, confirmationStatus: "confirmed"}]} : null));
    expect(await jupiterProvider({rpcUrls: ["https://rpc.example"]}).trackIntent({intentId: "jup:1", sourceTxHash: "sig"})).toEqual({state: "completed", destTxHash: "sig"});
    expect(await jupiterProvider().trackIntent({intentId: "jup:1", sourceTxHash: "sig"})).toEqual({state: "pending"});
    stub({}, () => ({value: [{err: {InstructionError: [2, {Custom: 6001}]}, confirmationStatus: "confirmed"}]}));
    expect(await jupiterProvider({rpcUrls: ["https://rpc.example"]}).trackIntent({intentId: "jup:1", sourceTxHash: "sig"})).toEqual({state: "failed"});
  });
});
