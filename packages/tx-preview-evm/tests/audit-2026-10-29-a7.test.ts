import {describe, expect, it} from "vitest";
import {decodeCall, previewEvmTx, type PreviewCall, type Rpc} from "../src/index.js";

// Audit 2026-10-29 A7: an EIP-2612 permit() call, Permit2 permit() (single and batch) and the old
// increaseApproval came back with no `approval` and no unlimited / spender warnings. They are
// decoded now; a malformed body of one of the permit selectors is an explicit "approval-unparsed"
// warning. Offline: the RPC is a stub (eth_simulateV1 "ok", no logs). Public dummy addresses only.

const ME = "0x8abe813577e47415a3cd0bbc68c7abca2c4c55ba";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const MAX256 = (1n << 256n) - 1n;
const MAX160 = (1n << 160n) - 1n;
const w = (v: bigint | string) => (typeof v === "bigint" ? v.toString(16) : v.replace(/^0x/, "")).toLowerCase().padStart(64, "0");
const SIG = w(65n) + "11".repeat(65) + "00".repeat(31);

const permit2612 = (value: bigint) => "0xd505accf" + w(ME) + w(ATTACKER) + w(value) + w(9999999999n) + w(27n) + w(1n) + w(2n);
const permit2Single = (amount: bigint) => "0x2b67b570" + w(ME) + w(USDC) + w(amount) + w(281474976710655n) + w(0n) + w(ATTACKER) + w(9999999999n) + w(0x100n) + SIG;
/** permit(owner, PermitBatch, signature): tuple at 0x60 → array at tuple+0x60, then the signature. */
function permit2Batch(entries: [string, bigint][]) {
  const tuple = w(0x60n) + w(ATTACKER) + w(9999999999n);
  const array = w(BigInt(entries.length)) + entries.map(([t, a]) => w(t) + w(a) + w(281474976710655n) + w(0n)).join("");
  const sigOffset = 0x60n + BigInt((tuple.length + array.length) / 2);
  return "0x2a2d80d1" + w(ME) + w(0x60n) + w(sigOffset) + tuple + array + SIG;
}

const rpc: Rpc = async (method, params) => {
  if (method === "eth_getBlockByNumber") return {number: "0x10", timestamp: "0x6543"};
  if (method === "eth_simulateV1") {
    const calls = ((params[0] as {blockStateCalls: {calls: unknown[]}[]}).blockStateCalls[0]!.calls);
    return [{calls: calls.map(() => ({status: "0x1", gasUsed: "0xb000", logs: []}))}];
  }
  if (method === "eth_call") return "0x";
  throw Object.assign(new Error(`the method ${method} does not exist`), {code: -32601});
};

async function warns(call: PreviewCall, known: Record<string, string> = {}) {
  const p = await previewEvmTx({chainId: 1, from: ME, calls: [call], rpc, own: [ME], known});
  return p.checks.filter((k) => k.status === "warn").map((k) => k.code);
}

describe("audit 2026-10-29 A7: permit-style approvals are decoded", () => {
  it("EIP-2612 permit(): the target is the token, spender and value from the call, unlimited warned (known token too)", async () => {
    const call = {to: USDC, data: permit2612(MAX256)};
    expect(decodeCall(call).approval).toEqual({token: USDC, spender: ATTACKER, spenderLabel: null, amount: null, kind: "erc20"});
    expect(decodeCall(call).method).toBe("permit (EIP-2612)");
    expect(await warns(call)).toEqual(expect.arrayContaining(["approval-unknown-spender", "approval-unlimited"]));
    expect(await warns(call, {[USDC]: "USD Coin"})).toEqual(expect.arrayContaining(["approval-unknown-spender", "approval-unlimited"]));
    expect(decodeCall({to: USDC, data: permit2612(5n)}).approval?.amount).toBe(5n);
  });

  it("Permit2 permit() single: the token is inside the struct", async () => {
    const call = {to: PERMIT2, data: permit2Single(MAX160)};
    expect(decodeCall(call)).toMatchObject({method: "permit (Permit2)", approval: {token: USDC, spender: ATTACKER, amount: null, kind: "permit2"}});
    expect(await warns(call)).toEqual(expect.arrayContaining(["approval-unknown-spender", "approval-unlimited"]));
    expect(decodeCall({to: PERMIT2, data: permit2Single(1000n)}).approval?.amount).toBe(1000n);
  });

  it("Permit2 permit() batch: every entry is an approval, each one warned", async () => {
    const call = {to: PERMIT2, data: permit2Batch([[USDC, MAX160], [WETH, 7n]])};
    const d = decodeCall(call, {[ATTACKER]: "Router"});
    expect(d.method).toBe("permit batch (Permit2)");
    expect(d.approvals).toEqual([
      {token: USDC, spender: ATTACKER, spenderLabel: "Router", amount: null, kind: "permit2"},
      {token: WETH, spender: ATTACKER, spenderLabel: "Router", amount: 7n, kind: "permit2"},
    ]);
    expect(d.approval).toEqual(d.approvals![0]);
    const p = await previewEvmTx({chainId: 1, from: ME, calls: [call], rpc, own: [ME], known: {}});
    expect(p.checks.filter((k) => k.code === "approval-unknown-spender")).toHaveLength(2);
    expect(p.checks.filter((k) => k.code === "approval-unlimited")).toHaveLength(1);
    expect(p.checks.filter((k) => k.code === "approval-unchecked").map((k) => k.detail?.token)).toEqual([WETH]);
  });

  it("increaseApproval (0xd73dd623) is read like increaseAllowance", async () => {
    const call = {to: USDC, data: "0xd73dd623" + w(ATTACKER) + w(MAX256)};
    expect(decodeCall(call)).toMatchObject({method: "increaseApproval", approval: {token: USDC, spender: ATTACKER, amount: null, kind: "erc20"}});
    expect(await warns(call)).toEqual(expect.arrayContaining(["approval-unknown-spender", "approval-unlimited"]));
  });

  it("a malformed permit body is an explicit approval-unparsed warning, never a plain call", async () => {
    const bad: [string, string][] = [
      [USDC, permit2612(MAX256).slice(0, 10 + 64 * 6)], // EIP-2612 missing `s`
      [PERMIT2, permit2Single(MAX160).slice(0, 10 + 64 * 7)], // no signature offset
      [PERMIT2, "0x2b67b570" + permit2Single(MAX160).slice(10, 10 + 64 * 7) + w(0x10000n)], // signature offset out of range
      [PERMIT2, "0x2a2d80d1" + w(ME) + w(0x60n) + w(0x60n)], // batch tuple out of range
      [PERMIT2, permit2Batch([[USDC, MAX160]]).slice(0, 10 + 64 * 8)], // batch entry cut short
      [PERMIT2, "0x2a2d80d1" + w(ME) + w(0x60n) + w(0x60n) + w(0x60n) + w(ATTACKER) + w(1n) + w(MAX256)], // absurd batch length
    ];
    for (const [to, data] of bad) {
      const d = decodeCall({to, data});
      expect(d.unparsedApproval, data.slice(0, 40)).toBe(true);
      expect(d.approval).toBeUndefined();
      expect(d.method).toMatch(/\(unparsed\)$/);
      const ws = await warns({to, data});
      expect(ws).toContain("approval-unparsed");
    }
  });

  it("uppercase spelling of a permit decodes the same (the earlier F17 fix covers the new selectors too)", () => {
    const lower = permit2612(MAX256);
    expect(decodeCall({to: USDC, data: "0x" + lower.slice(2).toUpperCase()}).approval).toEqual(decodeCall({to: USDC, data: lower}).approval);
  });

  it("every spelling the audit probed carries an approval with its warnings", async () => {
    const NFT = "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d";
    const approve = "0x095ea7b3" + w(ATTACKER) + w(MAX256);
    const variants: PreviewCall[] = [
      {to: USDC, data: approve},
      {to: USDC, data: "0x" + approve.slice(2).toUpperCase()},
      {to: USDC, data: "0X" + approve.slice(2)},
      {to: USDC, data: "0x095Ea7B3" + approve.slice(10)},
      {to: USDC, data: approve + "00".repeat(32)},
      {to: USDC, data: "0x" + ("39509351" + w(ATTACKER) + w(MAX256)).toUpperCase()},
      {to: NFT, data: "0x" + ("a22cb465" + w(ATTACKER) + w(1n)).toUpperCase()},
      {to: NFT, data: "0xa22cb465" + w(ATTACKER) + w(2n)},
      {to: PERMIT2, data: "0x" + ("87517c45" + w(USDC) + w(ATTACKER) + w(MAX160) + w(281474976710655n)).toUpperCase()},
      {to: USDC, data: permit2612(MAX256)},
      {to: PERMIT2, data: permit2Single(MAX160)},
      {to: USDC, data: "0xd73dd623" + w(ATTACKER) + w(MAX256)},
    ];
    for (const call of variants) {
      expect(decodeCall(call).approval, call.data).toBeDefined();
      expect(await warns(call, {[USDC]: "USD Coin"}), call.data).toEqual(expect.arrayContaining(["approval-unknown-spender", "approval-unlimited"]));
    }
  });
});
