import {describe, expect, it} from "vitest";
import {checksFor, decodeCall, type PreviewInput} from "../src/index.js";

// 2026-10-27 modules scan, G1: the review must see every approval and transfer the token contract will
// execute, read the way the EVM reads calldata, and warn about calldata it cannot read.

const ATTACKER = "0x9999999999999999999999999999999999999999";
const USER = "0x4444444444444444444444444444444444444444";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH9 = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const PERMIT2_ZKSYNC = "0x0000000000225e31d15943971f47ad3022f714fa";
const NFT = "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d";
const word = (v: bigint | string) => (typeof v === "bigint" ? v.toString(16) : v.replace(/^0x/, "").toLowerCase()).padStart(64, "0");
const MAX160 = (1n << 160n) - 1n;
const MAX256 = (1n << 256n) - 1n;

const input = (calls: PreviewInput["calls"]): PreviewInput => ({chainId: 1, from: USER, calls, rpc: async () => null, own: [USER]});
const warnings = (calls: PreviewInput["calls"]) => checksFor(input(calls), calls.map((c) => decodeCall(c)), {status: "unavailable", reason: "test"}).filter((c) => c.status === "warn").map((c) => c.code);

describe("scan 2026-10-27 modules G1 (F3): selectors are matched in any letter case", () => {
  it("an uppercase-hex Permit2 approve is an unlimited approval of the attacker", () => {
    const call = {to: PERMIT2, data: "0x87517C45" + word(USDC) + word(ATTACKER) + word(MAX160) + word(281474976710655n).toUpperCase()};
    expect(decodeCall(call).approval).toMatchObject({kind: "permit2", token: USDC, spender: ATTACKER, amount: null});
    expect(warnings([call])).toEqual(expect.arrayContaining(["approval-unknown-spender", "approval-unlimited"]));
  });
  it("an uppercase ERC-20 approve and transfer are read too", () => {
    expect(decodeCall({to: USDC, data: "0x095EA7B3" + word(ATTACKER).toUpperCase() + word(MAX256)}).approval).toMatchObject({kind: "erc20", spender: ATTACKER, amount: null});
    expect(decodeCall({to: USDC, data: "0xA9059CBB" + word(ATTACKER) + word(5n)}).transfer).toMatchObject({to: ATTACKER, amount: 5n});
  });
});

describe("scan 2026-10-27 modules G1 (F14, F17): calldata a legacy contract executes is read as it executes", () => {
  it("WETH9 approve one byte short is an approval (the EVM zero-pads the amount word)", () => {
    const call = {to: WETH9, data: "0x095ea7b3" + word(ATTACKER) + "ff".repeat(31)};
    const d = decodeCall(call);
    expect(d.approval).toMatchObject({kind: "erc20", spender: ATTACKER, amount: null});
    expect(warnings([call])).toEqual(expect.arrayContaining(["approval-unlimited"]));
  });
  it("setApprovalForAll(attacker, 2) is an operator approval (ABI coder v1 reads any non-zero bool as true)", () => {
    const d = decodeCall({to: NFT, data: "0xa22cb465" + word(ATTACKER) + word(2n)});
    expect(d.approval).toMatchObject({kind: "operator", spender: ATTACKER, amount: null});
    expect(decodeCall({to: NFT, data: "0xa22cb465" + word(ATTACKER) + word(0n)}).approval).toBeUndefined();
  });
  it("an address word with dirty high bits names its low 20 bytes", () => {
    const d = decodeCall({to: USDC, data: "0x095ea7b3" + "ff".repeat(12) + ATTACKER.slice(2) + word(1n)});
    expect(d.approval?.spender).toBe(ATTACKER);
  });
});

describe("scan 2026-10-27 modules G1 (F29): Permit2 approve is an approval at any address", () => {
  it("a Permit2 approve on zkSync Era's Permit2 (eip155:324) is flagged", () => {
    const call = {to: PERMIT2_ZKSYNC, data: "0x87517c45" + word(USDC) + word(ATTACKER) + word(MAX160) + word(1n)};
    expect(decodeCall(call).approval).toMatchObject({kind: "permit2", spender: ATTACKER, amount: null});
    expect(checksFor({...input([call]), chainId: 324}, [decodeCall(call)], {status: "unavailable", reason: "t"}).some((c) => c.code === "approval-unlimited")).toBe(true);
  });
});

describe("scan 2026-10-27 modules G1: calldata that is not hex bytes is a warning, never a plain call", () => {
  it("odd length, non-hex or a 1x prefix → calldata-undecodable", () => {
    for (const data of ["0x095ea7b" + word(ATTACKER), "0x095ea7b3zz", "1x095ea7b3" + word(ATTACKER) + word(1n)]) {
      expect([data.slice(0, 12), decodeCall({to: USDC, data}).undecodable]).toEqual([data.slice(0, 12), true]);
      expect(warnings([{to: USDC, data}])).toContain("calldata-undecodable");
    }
  });
});
