// A LI.FI route with a "LI.Fuel" gas step (GasZipPeriphery inside the source swaps) sends part of the input as native
// gas to a receiver written only in that step's own callData. Recorded live 2026-11-24 15:47Z: 1000 USDC Ethereum →
// Base via Across with fromAmountForGas. Does the Diamond check see — and bind — that receiver?
import {describe, expect, it} from "vitest";
import {diamondCallMismatch, type DiamondExpectation} from "../src/calldata.js";
import fixture from "./fixtures-live-2026-11-24-gaszip.json" with {type: "json"};

const ME = fixture.action.fromAddress;
const ATTACKER = "000000000000000000000000000000000000beef";
const expectation: DiamondExpectation = {
  fromToken: fixture.fromToken,
  toToken: fixture.toToken,
  amountIn: BigInt(fixture.action.fromAmount),
  receiver: ME,
  sender: ME,
  minOut: BigInt(fixture.toAmountMin),
  destChainId: 8453n,
  sameChain: false,
  evmDestination: true,
};

/** The GasZipPeriphery call's receiverAddress (bytes32, left-aligned) rewritten to `to`. */
function gasReceiverTo(data: string, to: string): string {
  const sel = data.toLowerCase().indexOf("8b71ae6c");
  expect(sel).toBeGreaterThan(0);
  // selector (8 hex) + word 0 (64 hex) = word 1, the receiver; its first 40 hex are the address.
  const at = sel + 8 + 64;
  expect(data.slice(at, at + 40).toLowerCase()).toBe(ME.slice(2).toLowerCase());
  return data.slice(0, at) + to + data.slice(at + 40);
}

describe("LI.FI gas step (GasZipPeriphery)", () => {
  it("refuses the route even as LI.FI built it: this wallet never asks for a gas step", () => {
    expect(diamondCallMismatch(fixture.transactionRequest.data, expectation)).toMatch(/gas to an address only its own call names/);
  });

  it("refuses the same route when the gas step pays someone else (the gap it closes: before, this passed)", () => {
    const tampered = gasReceiverTo(fixture.transactionRequest.data, ATTACKER);
    expect(diamondCallMismatch(tampered, expectation)).toMatch(/gas to an address only its own call names/);
  });
});
