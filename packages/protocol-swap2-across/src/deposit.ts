/**
 * SpokePool `deposit` — built and read here, strictly.
 *
 * `deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount,
 * uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp,
 * uint32 fillDeadline, uint32 exclusivityParameter, bytes message)`, selector 0xad5425c6 (SpokePool.sol at
 * across-protocol/contracts d652689f). Every party and token is a `bytes32`; on an EVM chain it holds a 20-byte address
 * left-padded with zeros, and `depositor` is required to be one on chain (`checkAddress`).
 *
 * The reader accepts exactly the canonical ABI encoding of that call: the selector, eleven static words with clean
 * padding, the one offset the encoding allows (0x180), the message length and the message padded to a word, and
 * nothing after it. Across's own API appends a marker to the calldata it hands out (`73c0de`, and `1dc0de` + an
 * integrator id before it); such bytes are not part of the call and are refused here — this module signs the calldata
 * it builds, which carries none.
 */
import {encodeFunctionData, parseAbi, type Hex} from "viem";
import {ACROSS_DEPOSIT, ACROSS_REFUSED_SELECTORS} from "./config.js";
import {AcrossRefusal} from "./refusal.js";

export const SPOKE_POOL_ABI = parseAbi([
  "function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) payable",
]);

/** The arguments of a deposit. Addresses are 20 bytes, lowercase; the zero address as `exclusiveRelayer` is "none". */
export interface AcrossDepositArgs {
  depositor: string;
  recipient: string;
  inputToken: string;
  outputToken: string;
  inputAmount: bigint;
  outputAmount: bigint;
  destinationChainId: bigint;
  exclusiveRelayer: string;
  /** Unix seconds. */
  quoteTimestamp: number;
  /** Unix seconds, on the destination chain. */
  fillDeadline: number;
  /** 0 (no exclusivity), an offset up to one year, or a unix timestamp above that. */
  exclusivityParameter: number;
  /** Lowercase hex, `0x` when empty. */
  message: Hex;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const U256_MAX = (1n << 256n) - 1n;
const U32_MAX = 0xffff_ffff;
/** Static words before the message: eleven arguments and the message's offset. */
const HEAD_WORDS = 12;
/** The only offset a canonical encoding gives the message: right after the head. */
const MESSAGE_OFFSET = HEAD_WORDS * 32;
/** Longest message read (64 KiB): this module refuses every non-empty message anyway, this only bounds the work. */
export const ACROSS_MAX_MESSAGE_BYTES = 65_536;

/** An address as the bytes32 a deposit carries. */
export function acrossBytes32(address: string): Hex {
  if (typeof address !== "string" || !ADDRESS.test(address)) throw new AcrossRefusal("request-invalid", `${String(address)} is not an EVM address`);
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

/** The address a bytes32 word holds, or null when its upper twelve bytes are not zero (not an EVM address). */
export function acrossAddressOf(word: string): string | null {
  const w = word.startsWith("0x") ? word.slice(2) : word;
  if (!/^[0-9a-fA-F]{64}$/.test(w) || !/^0{24}/.test(w)) return null;
  return `0x${w.slice(24).toLowerCase()}`;
}

function checkArgs(a: AcrossDepositArgs): void {
  const bad = (what: string): never => { throw new AcrossRefusal("request-invalid", `the deposit's ${what}`); };
  if (a === null || typeof a !== "object") bad("arguments are missing");
  for (const [k, v] of [["depositor", a.depositor], ["recipient", a.recipient], ["inputToken", a.inputToken], ["outputToken", a.outputToken], ["exclusiveRelayer", a.exclusiveRelayer]] as const) {
    if (typeof v !== "string" || !ADDRESS.test(v)) bad(`${k} is not an EVM address`);
  }
  for (const [k, v] of [["inputAmount", a.inputAmount], ["outputAmount", a.outputAmount], ["destinationChainId", a.destinationChainId]] as const) {
    if (typeof v !== "bigint" || v < 0n || v > U256_MAX) bad(`${k} is not a uint256`);
  }
  for (const [k, v] of [["quoteTimestamp", a.quoteTimestamp], ["fillDeadline", a.fillDeadline], ["exclusivityParameter", a.exclusivityParameter]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > U32_MAX) bad(`${k} is not a uint32`);
  }
  if (typeof a.message !== "string" || !HEX.test(a.message) || (a.message.length - 2) / 2 > ACROSS_MAX_MESSAGE_BYTES) bad("message is not bytes");
}

/** The calldata of `deposit(...)` for these arguments: lowercase hex, canonical ABI encoding, nothing appended. */
export function encodeAcrossDeposit(a: AcrossDepositArgs): Hex {
  checkArgs(a);
  return encodeFunctionData({
    abi: SPOKE_POOL_ABI,
    functionName: "deposit",
    args: [
      acrossBytes32(a.depositor), acrossBytes32(a.recipient), acrossBytes32(a.inputToken), acrossBytes32(a.outputToken),
      a.inputAmount, a.outputAmount, a.destinationChainId, acrossBytes32(a.exclusiveRelayer),
      a.quoteTimestamp, a.fillDeadline, a.exclusivityParameter, a.message.toLowerCase() as Hex,
    ],
  }).toLowerCase() as Hex;
}

/** A word's value when it fits 32 bits (its upper 28 bytes zero), else null. */
function word32(word: string): number | null {
  return /^0{56}[0-9a-f]{8}$/.test(word) ? parseInt(word.slice(56), 16) : null;
}

/**
 * The arguments of a `deposit` calldata, read strictly; throws {@link AcrossRefusal} (`tx-selector`, `tx-calldata`,
 * classified `policy_refused`) for anything but the canonical encoding of that one call.
 */
export function decodeAcrossDeposit(data: unknown): AcrossDepositArgs {
  const malformed = (what: string): never => { throw new AcrossRefusal("tx-calldata", `the deposit calldata ${what}`, "policy_refused"); };
  if (typeof data !== "string" || !HEX.test(data) || data.length < 10) malformed("is not hex calldata");
  const hex = (data as string).toLowerCase();
  const selector = hex.slice(0, 10);
  if (selector !== ACROSS_DEPOSIT) {
    const name = Object.prototype.hasOwnProperty.call(ACROSS_REFUSED_SELECTORS, selector) ? ACROSS_REFUSED_SELECTORS[selector] : undefined;
    throw new AcrossRefusal("tx-selector", name ? `the call is ${name} (${selector}), which this module never signs` : `the call is ${selector}, not deposit (${ACROSS_DEPOSIT})`, "policy_refused");
  }
  const body = hex.slice(10);
  if (body.length < (HEAD_WORDS + 1) * 64) malformed(`is ${(hex.length - 2) / 2} bytes, shorter than a deposit`);
  const word = (i: number): string => body.slice(64 * i, 64 * i + 64);
  const addr = (i: number, what: string): string => acrossAddressOf(word(i)) ?? malformed(`carries a ${what} that is not an EVM address`);
  const u32 = (i: number, what: string): number => word32(word(i)) ?? malformed(`carries a ${what} wider than 32 bits`);
  const offset = BigInt(`0x${word(11)}`);
  if (offset !== BigInt(MESSAGE_OFFSET)) malformed(`puts the message at offset ${offset}, not ${MESSAGE_OFFSET}`);
  const lengthWord = word(HEAD_WORDS);
  if (!/^0{56}/.test(lengthWord)) malformed("states an impossible message length");
  const length = parseInt(lengthWord.slice(56), 16);
  if (length > ACROSS_MAX_MESSAGE_BYTES) malformed(`carries a ${length}-byte message, over ${ACROSS_MAX_MESSAGE_BYTES}`);
  const padded = Math.ceil(length / 32) * 64;
  const expected = (HEAD_WORDS + 1) * 64 + padded;
  if (body.length !== expected) {
    malformed(body.length > expected
      ? `has ${(body.length - expected) / 2} bytes after the encoded call`
      : `is ${(hex.length - 2) / 2} bytes, the encoding needs ${4 + expected / 2}`);
  }
  const tail = body.slice((HEAD_WORDS + 1) * 64);
  if (!/^0*$/.test(tail.slice(length * 2))) malformed("pads the message with non-zero bytes");
  const args: AcrossDepositArgs = {
    depositor: addr(0, "depositor"),
    recipient: addr(1, "recipient"),
    inputToken: addr(2, "input token"),
    outputToken: addr(3, "output token"),
    inputAmount: BigInt(`0x${word(4)}`),
    outputAmount: BigInt(`0x${word(5)}`),
    destinationChainId: BigInt(`0x${word(6)}`),
    exclusiveRelayer: addr(7, "exclusive relayer"),
    quoteTimestamp: u32(8, "quote timestamp"),
    fillDeadline: u32(9, "fill deadline"),
    exclusivityParameter: u32(10, "exclusivity parameter"),
    message: `0x${tail.slice(0, length * 2)}`,
  };
  // Whatever the reads above let through, the bytes are the canonical encoding of what was read.
  if (encodeAcrossDeposit(args) !== hex) malformed("is not the canonical encoding of its arguments");
  return args;
}
