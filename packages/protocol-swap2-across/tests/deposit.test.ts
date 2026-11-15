import {describe, expect, it} from "vitest";
import {decodeFunctionData, encodeFunctionData, parseAbi, toFunctionSelector, type Hex} from "viem";
import {ACROSS_DEPOSIT} from "../src/config.js";
import {ACROSS_MAX_MESSAGE_BYTES, SPOKE_POOL_ABI, acrossAddressOf, acrossBytes32, decodeAcrossDeposit, encodeAcrossDeposit} from "../src/deposit.js";
import {ARB_USDC, BASE_USDC, RELAYER, USER, ZERO, apiQuote, refused, statusFixture, usdcArgs} from "./fixtures.js";

/** Across's toolkit appends these after the ABI arguments of every call its API hands out (SWAP_CALLDATA_MARKER). */
const SWAP_MARKER = "73c0de";

describe("deposit codec", () => {
  it("the selector is deposit(bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,bytes32,uint32,uint32,uint32,bytes)", () => {
    expect(toFunctionSelector("deposit(bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,bytes32,uint32,uint32,uint32,bytes)")).toBe("0xad5425c6");
    expect(ACROSS_DEPOSIT).toBe("0xad5425c6");
  });

  it("round-trips, empty and non-empty messages, and matches an independent encoding", () => {
    for (const message of ["0x", "0xdeadbeef", `0x${"ab".repeat(33)}`] as Hex[]) {
      const args = usdcArgs({message});
      const data = encodeAcrossDeposit(args);
      expect(data).toBe(data.toLowerCase());
      expect(decodeAcrossDeposit(data)).toEqual(args);
      // The same call encoded with an ABI written out a second time, addresses as bytes32 by hand.
      const abi = parseAbi(["function deposit(bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,bytes32,uint32,uint32,uint32,bytes)"]);
      const pad = (a: string) => `0x${a.slice(2).padStart(64, "0")}` as Hex;
      const other = encodeFunctionData({abi, functionName: "deposit", args: [pad(USER), pad(USER), pad(BASE_USDC), pad(ARB_USDC), 25_000_000n, 24_990_967n, 42161n, pad(ZERO), args.quoteTimestamp, args.fillDeadline, 0, message]});
      expect(data).toBe(other.toLowerCase());
    }
  });

  it("an empty-message deposit is exactly 420 bytes", () => {
    expect((encodeAcrossDeposit(usdcArgs()).length - 2) / 2).toBe(4 + 13 * 32);
  });

  it("bytes32 ↔ address", () => {
    expect(acrossBytes32(BASE_USDC.toUpperCase().replace("0X", "0x"))).toBe(`0x${"0".repeat(24)}${BASE_USDC.slice(2)}`);
    expect(acrossAddressOf(`0x${"0".repeat(24)}${BASE_USDC.slice(2)}`)).toBe(BASE_USDC);
    expect(acrossAddressOf(`0x${"0".repeat(23)}1${BASE_USDC.slice(2)}`)).toBeNull();
    expect(acrossAddressOf("0x1234")).toBeNull();
    refused(() => acrossBytes32("0x1234"), "request-invalid");
  });

  it("refuses to encode arguments of the wrong type (a caller's bug: no reason)", () => {
    refused(() => encodeAcrossDeposit(usdcArgs({depositor: "0x12"})), "request-invalid");
    refused(() => encodeAcrossDeposit(usdcArgs({inputAmount: -1n})), "request-invalid");
    refused(() => encodeAcrossDeposit(usdcArgs({outputAmount: 1n << 256n})), "request-invalid");
    refused(() => encodeAcrossDeposit(usdcArgs({quoteTimestamp: 2 ** 32})), "request-invalid");
    refused(() => encodeAcrossDeposit(usdcArgs({fillDeadline: 1.5})), "request-invalid");
    refused(() => encodeAcrossDeposit(usdcArgs({message: "0xabc" as Hex})), "request-invalid");
    refused(() => encodeAcrossDeposit(usdcArgs({message: `0x${"00".repeat(ACROSS_MAX_MESSAGE_BYTES + 1)}` as Hex})), "request-invalid");
  });
});

describe("real calldata", () => {
  it("Across's API calldata decodes once its documented 3-byte marker is taken off — and not before", () => {
    const q = apiQuote("base-usdc-arb-usdc");
    const data = q.tx.data.toLowerCase();
    // What is taken off, and why it is not part of the call: the canonical encoding of a deposit with an empty message
    // is 420 bytes; these are 423, and the last three are Across's SWAP_CALLDATA_MARKER (across-protocol/toolkit,
    // packages/sdk/src/utils/hex.ts) — nothing else.
    expect((data.length - 2) / 2).toBe(423);
    expect(data.endsWith(SWAP_MARKER)).toBe(true);
    expect(refused(() => decodeAcrossDeposit(data), "tx-calldata", "policy_refused")).toMatch(/3 bytes after the encoded call/);
    const a = decodeAcrossDeposit(data.slice(0, -SWAP_MARKER.length));
    expect(a).toEqual({
      depositor: "0x000000000000000000000000000000000000dead", recipient: "0x000000000000000000000000000000000000dead",
      inputToken: BASE_USDC, outputToken: ARB_USDC, inputAmount: 25_000_000n, outputAmount: BigInt(q.minOutputAmount!),
      destinationChainId: 42161n, exclusiveRelayer: RELAYER, quoteTimestamp: 1_794_688_667, fillDeadline: 1_794_688_667 + 7200,
      exclusivityParameter: 3, message: "0x",
    });
    // viem, which tolerates trailing bytes, reads the same arguments.
    const loose = decodeFunctionData({abi: SPOKE_POOL_ABI, data: data as Hex});
    expect(loose.args[4]).toBe(a.inputAmount);
    expect(loose.args[5]).toBe(a.outputAmount);
  });

  it("an integrator-tagged calldata (1dc0de + id + marker) is refused as is, and decodes with exactly those 8 bytes off", () => {
    const data = apiQuote("base-usdc-arb-usdc-integrator").tx.data.toLowerCase();
    expect(data.endsWith(`1dc0dedead${SWAP_MARKER}`)).toBe(true);
    expect(refused(() => decodeAcrossDeposit(data), "tx-calldata", "policy_refused")).toMatch(/8 bytes after/);
    expect(decodeAcrossDeposit(data.slice(0, -16)).recipient).toBe("0x000000000000000000000000000000000000beef");
  });

  it("a deposit sent on Base (tx 0x6ff89815…) carries the same marker on chain; the call before it is canonical", () => {
    const f = statusFixture("base-arb-usdc-deposit");
    const input = f.source.input.toLowerCase();
    expect(input.slice(0, 10)).toBe(ACROSS_DEPOSIT);
    expect(input.endsWith(SWAP_MARKER)).toBe(true);
    refused(() => decodeAcrossDeposit(input), "tx-calldata", "policy_refused");
    const a = decodeAcrossDeposit(input.slice(0, -SWAP_MARKER.length));
    expect(a.inputToken).toBe(BASE_USDC);
    expect(a.outputToken).toBe(ARB_USDC);
    expect(a.destinationChainId).toBe(42161n);
    expect(a.message).toBe("0x");
  });

  it("the periphery's depositNative and swapAndBridge, and CCTP's depositForBurn, are not deposits", () => {
    expect(refused(() => decodeAcrossDeposit(apiQuote("eth-eth-base-eth").tx.data), "tx-selector", "policy_refused")).toMatch(/0x609ea081, not deposit/);
    expect(refused(() => decodeAcrossDeposit(apiQuote("arb-usdc-base-usdt").tx.data), "tx-selector", "policy_refused")).toMatch(/0x110560ad/);
    expect(refused(() => decodeAcrossDeposit(apiQuote("base-usdc-sol-usdc").tx.data), "tx-selector", "policy_refused")).toMatch(/0x8e0250ee/);
  });
});

describe("strict reading", () => {
  const good = encodeAcrossDeposit(usdcArgs());
  const body = good.slice(10);
  const word = (i: number) => body.slice(64 * i, 64 * i + 64);
  const withWord = (i: number, w: string) => `${ACROSS_DEPOSIT}${body.slice(0, 64 * i)}${w}${body.slice(64 * i + 64)}`;

  it("refused selectors are named", () => {
    const sel = (s: string) => `${s}${body}`;
    expect(refused(() => decodeAcrossDeposit(sel("0x8b15788e")), "tx-selector", "policy_refused")).toMatch(/unsafeDeposit/);
    expect(refused(() => decodeAcrossDeposit(sel("0xea86bd46")), "tx-selector", "policy_refused")).toMatch(/depositNow/);
    expect(refused(() => decodeAcrossDeposit(sel("0x7aef642c")), "tx-selector", "policy_refused")).toMatch(/depositV3Now/);
    expect(refused(() => decodeAcrossDeposit(sel("0xbabb6aac")), "tx-selector", "policy_refused")).toMatch(/speedUpDeposit/);
    expect(refused(() => decodeAcrossDeposit(sel("0x577f51f8")), "tx-selector", "policy_refused")).toMatch(/speedUpV3Deposit/);
    expect(refused(() => decodeAcrossDeposit(sel("0xac9650d8")), "tx-selector", "policy_refused")).toMatch(/multicall/);
    // depositV3 (address-typed) is read in history but never signed.
    expect(refused(() => decodeAcrossDeposit(sel("0x7b939232")), "tx-selector", "policy_refused")).toMatch(/0x7b939232, not deposit/);
  });

  it("not hex, too short, trailing bytes", () => {
    for (const bad of [undefined, 42, "", "0x", "0xad5425", "ad5425c6", `${good}0`, `${good.slice(0, -2)}zz`]) refused(() => decodeAcrossDeposit(bad), "tx-calldata", "policy_refused");
    refused(() => decodeAcrossDeposit(good.slice(0, -64)), "tx-calldata", "policy_refused");
    expect(refused(() => decodeAcrossDeposit(`${good}00`), "tx-calldata", "policy_refused")).toMatch(/1 bytes after/);
    expect(refused(() => decodeAcrossDeposit(`${good}${"00".repeat(32)}`), "tx-calldata", "policy_refused")).toMatch(/32 bytes after/);
  });

  it("dirty address words (a bytes32 that is not an EVM address)", () => {
    for (const i of [0, 1, 2, 3, 7]) {
      refused(() => decodeAcrossDeposit(withWord(i, `1${word(i).slice(1)}`)), "tx-calldata", "policy_refused");
    }
  });

  it("uint32 words wider than 32 bits", () => {
    for (const i of [8, 9, 10]) refused(() => decodeAcrossDeposit(withWord(i, `1${word(i).slice(1)}`)), "tx-calldata", "policy_refused");
  });

  it("the message at another offset, an impossible length, a short or dirty tail", () => {
    expect(refused(() => decodeAcrossDeposit(withWord(11, (0x1a0).toString(16).padStart(64, "0"))), "tx-calldata", "policy_refused")).toMatch(/offset/);
    refused(() => decodeAcrossDeposit(withWord(12, `f${"0".repeat(63)}`)), "tx-calldata", "policy_refused");
    refused(() => decodeAcrossDeposit(withWord(12, (ACROSS_MAX_MESSAGE_BYTES + 1).toString(16).padStart(64, "0"))), "tx-calldata", "policy_refused");
    // A 4-byte message whose padding is not zero.
    const four = encodeAcrossDeposit(usdcArgs({message: "0xdeadbeef"}));
    expect(refused(() => decodeAcrossDeposit(`${four.slice(0, -2)}01`), "tx-calldata", "policy_refused")).toMatch(/pads the message/);
    // A length that claims more than is there.
    refused(() => decodeAcrossDeposit(withWord(12, (40).toString(16).padStart(64, "0"))), "tx-calldata", "policy_refused");
  });

  it("casing does not matter, the canonical bytes do", () => {
    expect(decodeAcrossDeposit(good.toUpperCase().replace("0X", "0x"))).toEqual(usdcArgs());
  });
});
