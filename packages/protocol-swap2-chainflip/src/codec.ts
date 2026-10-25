/**
 * Decoders for what Chainflip's encoder returns, so a vault swap is checked byte by byte before anyone signs it:
 *   - VersionedCfParameters (SCALE): retry window, refund address, minimum price (X128), oracle slippage, DCA, boost,
 *     broker + its fee, affiliates — the EVM vault call's `cfParameters` and the tail of the Tron note;
 *   - the Tron note: output asset id, encoded destination address, CCM option, then the length-prefixed parameters;
 *   - the EVM vault calls xSwapNative / xSwapToken.
 * Layouts were decoded from live encoder outputs (2026-10-20) and match the state chain's types.
 */
import {base58} from "@scure/base";
import {sha256} from "@noble/hashes/sha2.js";
import {decodeFunctionData, parseAbi, type Hex} from "viem";

export interface CfParameters {
  version: number;
  retryDurationBlocks: number;
  /** raw refund address bytes (20 for EVM / Tron, 32 for Solana) as 0x-hex */
  refundAddress: Hex;
  /** minimum output price × 2^128, scaled by 10^(destDecimals − srcDecimals) */
  minPriceX128: bigint;
  refundCcm: boolean;
  maxOraclePriceSlippageBps: number | null;
  dca: {chunks: number; intervalBlocks: number} | null;
  boostFeeBps: number;
  broker: {account: Hex; feeBps: number};
  affiliates: {account: number; feeBps: number}[];
}

class Reader {
  i = 0;
  constructor(readonly b: Uint8Array) {}
  need(n: number) { if (this.i + n > this.b.length) throw new Error(`chainflip codec: truncated at ${this.i} (+${n} of ${this.b.length})`); }
  u8() { this.need(1); return this.b[this.i++]!; }
  bytes(n: number) { this.need(n); const out = this.b.slice(this.i, this.i + n); this.i += n; return out; }
  uLE(n: number): bigint { const x = this.bytes(n); let v = 0n; for (let k = n - 1; k >= 0; k--) v = (v << 8n) | BigInt(x[k]!); return v; }
  /** Little-endian unsigned of up to 6 bytes as a number (exact: below 2^48). */
  uNum(n: number): number { if (n > 6) throw new Error("chainflip codec: uNum takes at most 6 bytes"); const x = this.bytes(n); let v = 0; for (let k = n - 1; k >= 0; k--) v = v * 256 + x[k]!; return v; }
  /** SCALE compact integer */
  compact(): number {
    const first = this.u8();
    const mode = first & 3;
    if (mode === 0) return first >> 2;
    if (mode === 1) return ((this.u8() << 8) | first) >> 2;
    if (mode === 2) { const rest = this.uNum(3); return ((rest << 8) | first) >>> 2; }
    throw new Error("chainflip codec: big compact integers are not used here");
  }
  done() { if (this.i !== this.b.length) throw new Error(`chainflip codec: ${this.b.length - this.i} trailing bytes`); }
}

export const toHex = (b: Uint8Array): Hex => `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}` as Hex;
export function fromHex(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error("chainflip codec: not hex");
  return Uint8Array.from(s.match(/../g) ?? [], (x) => Number.parseInt(x, 16));
}

/** VersionedCfParameters V1. `refundLen` = 20 for EVM / Tron sources, 32 for Solana. */
export function decodeCfParameters(bytes: Uint8Array, refundLen: 20 | 32): CfParameters {
  const r = new Reader(bytes);
  const p = readCfParameters(r, refundLen);
  r.done();
  return p;
}

function readCfParameters(r: Reader, refundLen: number): CfParameters {
  const version = r.u8();
  if (version !== 1) throw new Error(`chainflip codec: cf parameters version ${version}`);
  // ccm_additional_data is `()` for non-CCM swaps: zero bytes
  const retryDurationBlocks = r.uNum(4);
  const refundAddress = toHex(r.bytes(refundLen));
  const minPriceX128 = r.uLE(32);
  const refundCcm = r.u8() !== 0;
  if (refundCcm) throw new Error("chainflip codec: refund CCM metadata is not expected");
  const maxOraclePriceSlippageBps = r.u8() ? r.uNum(2) : null;
  const dca = r.u8() ? {chunks: r.uNum(4), intervalBlocks: r.uNum(4)} : null;
  const boostFeeBps = r.u8();
  const broker = {account: toHex(r.bytes(32)), feeBps: r.uNum(2)};
  const n = r.compact();
  const affiliates = Array.from({length: n}, () => ({account: r.u8(), feeBps: r.uNum(2)}));
  return {version, retryDurationBlocks, refundAddress, minPriceX128, refundCcm, maxOraclePriceSlippageBps, dca, boostFeeBps, broker, affiliates};
}

export interface TronNote {
  outputAsset: number;
  /** EncodedAddress variant of the destination (Eth 0, Dot 1, Btc 2, Arb 3, Sol 4, Hub 5, Tron 6) and its raw bytes */
  destTag: number;
  destAddress: Uint8Array;
  ccm: boolean;
  params: CfParameters;
}

/** Address byte length per encoded-address tag (EncodedAddress enum: Eth, Dot, Btc, Arb, Sol, Hub, Tron …). */
const TAG_LEN: Record<number, number | "vec"> = {0: 20, 1: 32, 2: "vec", 3: 20, 4: 32, 5: 32, 6: 20};

/** The note a Tron vault swap carries in raw_data.data. */
export function decodeTronNote(note: string): TronNote {
  const r = new Reader(fromHex(note));
  const outputAsset = r.u8();
  const destTag = r.u8();
  const len = TAG_LEN[destTag];
  if (len === undefined) throw new Error(`chainflip codec: unknown address tag ${destTag}`);
  const destAddress = len === "vec" ? r.bytes(r.compact()) : r.bytes(len);
  const ccm = r.u8() !== 0;
  if (ccm) throw new Error("chainflip codec: CCM swaps are not expected");
  const paramsLen = r.compact();
  const start = r.i;
  const params = readCfParameters(r, 20);
  if (r.i - start !== paramsLen) throw new Error(`chainflip codec: cf parameters length ${r.i - start} ≠ declared ${paramsLen}`);
  r.done();
  return {outputAsset, destTag, destAddress, ccm, params};
}

const VAULT_ABI = parseAbi([
  "function xSwapNative(uint32 dstChain, bytes dstAddress, uint32 dstToken, bytes cfParameters) payable",
  "function xSwapToken(uint32 dstChain, bytes dstAddress, uint32 dstToken, address srcToken, uint256 amount, bytes cfParameters)",
]);

export interface EvmVaultCall {
  native: boolean;
  dstChain: number;
  dstAddress: Uint8Array;
  dstToken: number;
  srcToken: string | null;
  amount: bigint | null;
  params: CfParameters;
}

export function decodeEvmVaultCall(data: string): EvmVaultCall {
  const d = decodeFunctionData({abi: VAULT_ABI, data: data as Hex});
  if (d.functionName === "xSwapNative") {
    const [dstChain, dstAddress, dstToken, cf] = d.args;
    return {native: true, dstChain, dstAddress: fromHex(dstAddress), dstToken, srcToken: null, amount: null, params: decodeCfParameters(fromHex(cf), 20)};
  }
  const [dstChain, dstAddress, dstToken, srcToken, amount, cf] = d.args;
  return {native: false, dstChain, dstAddress: fromHex(dstAddress), dstToken, srcToken, amount, params: decodeCfParameters(fromHex(cf), 20)};
}

/** Tron base58check `T…` ↔ the 20 raw bytes Chainflip encodes (0x41 prefix dropped). */
export function tronToBytes(address: string): Uint8Array {
  const b = base58.decode(address);
  if (b.length !== 25 || b[0] !== 0x41) throw new Error(`not a Tron address: ${address}`);
  const check = sha256(sha256(b.subarray(0, 21))).subarray(0, 4);
  if (toHex(check) !== toHex(b.subarray(21))) throw new Error(`bad Tron checksum: ${address}`);
  return b.subarray(1, 21);
}

/** The raw bytes a destination address is encoded with, per destination chain (EVM / Tron 20, Solana 32, BTC ASCII). */
export function destAddressBytes(chain: string, address: string): Uint8Array {
  if (chain.startsWith("eip155:")) return fromHex(address);
  if (chain.startsWith("tron:")) return tronToBytes(address);
  if (chain.startsWith("solana:")) { const b = base58.decode(address); if (b.length !== 32) throw new Error(`not a Solana address: ${address}`); return b; }
  if (chain.startsWith("bitcoin:")) return new TextEncoder().encode(address);
  throw new Error(`chainflip: no address encoding for ${chain}`);
}

export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** minPriceX128 for a guaranteed output: ceil(minOut × 2^128 / amountIn) (base units on both sides carry the decimals). */
export function minPriceX128For(amountIn: bigint, minOut: bigint): bigint {
  return (minOut * 2n ** 128n + amountIn - 1n) / amountIn;
}
/** The output a min price guarantees for `amountIn` (floor). */
export function minOutOf(amountIn: bigint, minPriceX128: bigint): bigint {
  return (amountIn * minPriceX128) / 2n ** 128n;
}
