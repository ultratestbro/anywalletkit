// Scan 2026-10-27 (modules), F32/F33: /build's setup, cleanup and other instructions were accepted on their program and
// signer alone — a System transfer of 0.018 SOL to a third party, or a TransferChecked out of the destination ATA, rode
// along within the balance proof's slack. Now every one must be an exact shape. Recorded live builds (2026-10-23), edited.
import {afterEach, describe, expect, it, vi} from "vitest";
import {readFileSync} from "node:fs";
import {jupiterProvider} from "../src/provider.js";
import {toBase64} from "../src/codec.js";

type Ix = {programId: string; accounts: {pubkey: string; isSigner: boolean; isWritable: boolean}[]; data: string};
const file = JSON.parse(readFileSync(new URL("../fixtures/build-2026-10-23.json", import.meta.url), "utf8")) as {taker: string; responses: Record<string, {request: Record<string, string | number>; response: Record<string, unknown>}>};
const T = file.taker;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ATTACKER = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS";
const SYSTEM = "11111111111111111111111111111111", TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const rec = (k: string) => structuredClone(file.responses[k]!.response) as Record<string, unknown> & {setupInstructions: Ix[]; cleanupInstruction?: Ix; otherInstructions?: Ix[]; swapInstruction: Ix};
const SOL_USDC = {sourceChain: "solana:mainnet", sourceToken: "SOL", destChain: "solana:mainnet", destToken: USDC, amountIn: "100000000", slippageBps: 50, destAddress: T, refundAddress: T, dry: false};
const USDC_SOL = {...SOL_USDC, sourceToken: USDC, destToken: "SOL", amountIn: (rec("usdc_sol").inAmount as string), slippageBps: Number(file.responses["usdc_sol"]!.request.slippageBps)};
/** The taker's wSOL account, as the recorded SOL-source build funds it. */
const WSOL_ATA = rec("sol_usdc").setupInstructions.find((ix) => ix.programId === SYSTEM)!.accounts[1]!.pubkey;
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const transfer = (to: string, lamports: bigint): Ix => ({programId: SYSTEM, accounts: [{pubkey: T, isSigner: true, isWritable: true}, {pubkey: to, isSigner: false, isWritable: true}], data: toBase64(Uint8Array.from([2, 0, 0, 0, ...u64(lamports)]))});

async function refusal(answer: Record<string, unknown>, params: Record<string, unknown> = SOL_USDC) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).includes("/build?") ? new Response(JSON.stringify(answer)) : new Response("{}", {status: 404}))));
  const reasons: string[] = [];
  const q = await jupiterProvider().getQuote({...(params as typeof SOL_USDC), onRefusal: (r: string) => reasons.push(r)});
  return {q, reason: reasons.join(" ")};
}
afterEach(() => vi.unstubAllGlobals());

describe("Jupiter /build: every non-swap instruction is an exact shape (scan 2026-10-27 modules, F32/F33)", () => {
  it("the recorded builds pass as they are", async () => {
    for (const [k, params] of [["sol_usdc", SOL_USDC], ["usdc_sol", USDC_SOL]] as const) {
      const {q, reason} = await refusal(rec(k), params);
      expect(reason, k).toBe("");
      expect(q, k).not.toBeNull();
    }
  });

  it("an extra System transfer of 0.018 SOL to a third party is refused", async () => {
    const r = rec("sol_usdc");
    r.otherInstructions = [...(r.otherInstructions ?? []), transfer(ATTACKER, 18_000_000n)];
    expect((await refusal(r)).reason).toMatch(/jupiter: a SOL transfer to Fg6Pa.*, not the taker's wSOL account/);
  });

  it("a TransferChecked out of the destination ATA is refused", async () => {
    const r = rec("sol_usdc");
    const destAta = r.setupInstructions.find((ix) => ix.programId === ATA && ix.accounts[3]?.pubkey === USDC)!.accounts[1]!.pubkey;
    r.cleanupInstruction = {programId: TOKEN, accounts: [{pubkey: destAta, isSigner: false, isWritable: true}, {pubkey: USDC, isSigner: false, isWritable: false}, {pubkey: ATTACKER, isSigner: false, isWritable: true}, {pubkey: T, isSigner: true, isWritable: false}],
      data: toBase64(Uint8Array.from([12, ...u64(500_000n), 6]))};
    expect((await refusal(r)).reason).toMatch(/a Token instruction \(tag 12\) the swap does not need/);
  });

  it("the other ways out: an ATA for someone else, closing to someone else, a second funding or Jupiter call, the wrong amount, SOL on a token swap", async () => {
    const cases: Array<[string, (r: ReturnType<typeof rec>) => void, RegExp, Record<string, unknown>?]> = [
      ["ATA for another owner", (r) => { r.setupInstructions[0]!.accounts[2]!.pubkey = ATTACKER; }, /an associated token account for someone else/],
      ["close to the attacker", (r) => { r.cleanupInstruction!.accounts[1]!.pubkey = ATTACKER; }, /a CloseAccount that is not the taker's wSOL account back to the taker/],
      ["funding twice", (r) => { r.otherInstructions = [transfer(WSOL_ATA, 100_000_000n)]; }, /a second SOL transfer/],
      ["funding another amount", (r) => { const ix = r.setupInstructions.find((i) => i.programId === SYSTEM)!; ix.data = transfer(WSOL_ATA, 100_000_001n).data; }, /a SOL transfer of 100000001, not the 100000000 input/],
      ["a second Jupiter call", (r) => { r.otherInstructions = [structuredClone(r.swapInstruction)]; }, /a second Jupiter instruction/],
      ["SyncNative elsewhere", (r) => { r.setupInstructions.find((i) => i.programId === TOKEN)!.accounts[0]!.pubkey = ATTACKER; }, /SyncNative on another account/],
      ["System Assign", (r) => { r.otherInstructions = [{programId: SYSTEM, accounts: [{pubkey: T, isSigner: true, isWritable: true}], data: toBase64(Uint8Array.from([1, 0, 0, 0, ...new Uint8Array(32)]))}]; }, /a System instruction other than Transfer/],
      ["SOL on a token-source swap", (r) => { r.otherInstructions = [transfer(WSOL_ATA, 1n)]; }, /a SOL transfer on a token-source swap/, USDC_SOL],
    ];
    for (const [what, edit, why, params] of cases) {
      const r = rec(params === USDC_SOL ? "usdc_sol" : "sol_usdc");
      edit(r);
      expect((await refusal(r, params ?? SOL_USDC)).reason, what).toMatch(why);
    }
  });
});
