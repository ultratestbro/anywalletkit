import {describe, expect, it} from "vitest";
import {decodeCall} from "../src/index.js";

// Module watch 2026-11-04, permit2-zksync-gap: zkSync Era's own Permit2 (0x0000000000225e31…14Fa, the one Uniswap
// documents for eip155:324) was classified as a Permit2 call by selector already, but labelled
// "(Permit2 signature)" as if it were some other contract.

const ATTACKER = "0x9999999999999999999999999999999999999999";
const USDC = "0x1d17cbcf0d6d143135ae902365d2e5e2a16538d4";
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const PERMIT2_ZKSYNC = "0x0000000000225e31d15943971f47ad3022f714fa";
const OTHER = "0x00000000000000000000000000000000000000aa";
const word = (v: bigint | string) => (typeof v === "bigint" ? v.toString(16) : v.replace(/^0x/, "").toLowerCase()).padStart(64, "0");
const approve2 = "0x87517c45" + word(USDC) + word(ATTACKER) + word(5n) + word(1n);

describe("watch 2026-11-04 permit2-zksync: zkSync Era's Permit2 is labelled Permit2", () => {
  it("approve on either Permit2 is 'approve (Permit2)'; any other address stays '(Permit2 signature)'", () => {
    expect(decodeCall({to: PERMIT2_ZKSYNC, data: approve2})).toMatchObject({method: "approve (Permit2)", approval: {kind: "permit2", token: USDC, spender: ATTACKER, amount: 5n}});
    expect(decodeCall({to: PERMIT2_ZKSYNC.toUpperCase().replace("0X", "0x"), data: approve2}).method).toBe("approve (Permit2)");
    expect(decodeCall({to: PERMIT2, data: approve2}).method).toBe("approve (Permit2)");
    expect(decodeCall({to: OTHER, data: approve2})).toMatchObject({method: "approve (Permit2 signature)", approval: {kind: "permit2", spender: ATTACKER}});
  });

  it("a PermitSingle permit to zkSync Era's Permit2 is 'permit (Permit2)'", () => {
    // owner, (token, amount, expiration, nonce), spender, sigDeadline, signature offset, length 0
    const data = "0x2b67b570" + word(ATTACKER) + word(USDC) + word(5n) + word(1n) + word(0n) + word(ATTACKER) + word(1n) + word(0x100n) + word(0n);
    expect(decodeCall({to: PERMIT2_ZKSYNC, data})).toMatchObject({method: "permit (Permit2)", approval: {kind: "permit2", spender: ATTACKER}});
  });
});
