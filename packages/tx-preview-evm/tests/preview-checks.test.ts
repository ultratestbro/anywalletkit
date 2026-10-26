import {describe, expect, it} from "vitest";
import {encodeFunctionData, parseAbi} from "viem";
import {checksFor, decodeCall, type Simulation} from "../src/index.js";

// Audit 2026-10-25 round 3, M6: the review checks looked only at the LAST call of a batch, skipped
// the contract check for anything shaped like a token transfer, called approve(EVIL, 2^255 - 1)
// "approval-exact: ok" when the caller gave no expected amount (only ≥ 2^255 counted as unlimited),
// and rated the batch's whole native value by the last call's label.

const ME = "0x8abe813577e47415a3cd0bbc68c7abca2c4c55ba";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
const STRANGER = "0x91c4d2aa6e15f0a7b3c9d8e7f6a5b4c3d2e1e07a";
const EVIL = "0x00000000000000000000000000000000000e0b11";
const ERC20 = parseAbi(["function approve(address,uint256)", "function transfer(address,uint256)", "function swap(uint256)"]);
const known = {[DIAMOND]: "LI.FI Diamond", [USDC]: "USDC"};
const ok: Simulation = {status: "ok", changes: [], gasUsed: []};
const checks = (calls: Array<{to: string; data?: string; value?: bigint}>, extra: {expectedApproval?: bigint} = {}) =>
  checksFor({from: ME, own: [ME], calls: calls.map((c) => ({to: c.to, data: (c.data ?? "0x") as `0x${string}`, value: c.value ?? 0n})), ...extra} as never, calls.map((c) => decodeCall({to: c.to, data: (c.data ?? "0x") as `0x${string}`, value: c.value ?? 0n}, known)), ok);
const codes = (cs: ReturnType<typeof checks>) => cs.map((c) => `${c.code}:${c.status}`);

describe("checksFor looks at every call", () => {
  it("a transfer-shaped call to an unknown contract gets the contract check", () => {
    const cs = checks([{to: STRANGER, data: encodeFunctionData({abi: ERC20, functionName: "transfer", args: [ME, 1n]})}]);
    expect(codes(cs)).toContain("contract-unknown:warn");
    expect(cs.find((c) => c.code === "contract-unknown")?.detail?.address).toBe(STRANGER);
  });

  it("an unknown contract earlier in a batch is flagged although the last call is known", () => {
    const cs = checks([
      {to: STRANGER, data: encodeFunctionData({abi: ERC20, functionName: "swap", args: [1n]})},
      {to: DIAMOND, data: encodeFunctionData({abi: ERC20, functionName: "swap", args: [2n]})},
    ]);
    expect(codes(cs)).toEqual(expect.arrayContaining(["contract-unknown:warn", "contract-known:ok"]));
  });

  it("approve(EVIL, 2^255 - 1) is unlimited; any amount ≥ 2^128 - 1 is", () => {
    for (const amount of [2n ** 255n - 1n, 2n ** 128n - 1n, 2n ** 160n - 1n]) {
      const cs = checks([{to: USDC, data: encodeFunctionData({abi: ERC20, functionName: "approve", args: [EVIL, amount]})}]);
      expect(codes(cs), String(amount)).toContain("approval-unlimited:warn");
      expect(codes(cs)).not.toContain("approval-exact:ok");
    }
  });

  it("without an expected amount, a bounded approval is unknown, not 'exact'", () => {
    const data = encodeFunctionData({abi: ERC20, functionName: "approve", args: [DIAMOND, 1_000n]});
    expect(codes(checks([{to: USDC, data}]))).toContain("approval-unchecked:unknown");
    expect(codes(checks([{to: USDC, data}], {expectedApproval: 1_000n}))).toContain("approval-exact:ok");
    expect(codes(checks([{to: USDC, data}], {expectedApproval: 999n}))).toContain("approval-excess:warn");
  });

  it("native value is rated per call: value into an unknown contract warns even when the last call is known", () => {
    const cs = checks([
      {to: STRANGER, data: encodeFunctionData({abi: ERC20, functionName: "swap", args: [1n]}), value: 5n},
      {to: DIAMOND, data: encodeFunctionData({abi: ERC20, functionName: "swap", args: [2n]}), value: 0n},
    ]);
    const nv = cs.filter((c) => c.code === "native-value");
    expect(nv).toEqual([{code: "native-value", status: "warn", detail: {amount: "5", address: STRANGER}}]);
  });
});
