/**
 * Byte-level checks of what `/build` returns. The swap instruction is Jupiter v6's Anchor `route_v2` /
 * `shared_accounts_route_v2` (ExactIn): its arguments carry the input amount, the quoted output, the slippage and the
 * platform-fee split that the program enforces on-chain — so they are read back here and must equal the request
 * before the transaction is assembled. Discriminators = sha256("global:<name>")[0..8] (verified 2026-10-23 against
 * live /build answers).
 */
import {base64} from "@scure/base";

/** `route_v2(in_amount u64, quoted_out_amount u64, slippage_bps u16, platform_fee_bps u16, positive_slippage_bps u16, route_plan Vec)` */
export const ROUTE_V2 = "bb64facc31c4af14";
/** `shared_accounts_route_v2(id u8, …the same arguments…)` */
export const SHARED_ACCOUNTS_ROUTE_V2 = "d19853937cfed8e9";

export interface JupiterSwapArgs {
  kind: "route_v2" | "shared_accounts_route_v2";
  inAmount: bigint;
  quotedOutAmount: bigint;
  slippageBps: number;
  platformFeeBps: number;
  positiveSlippageBps: number;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const u64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset + o, 8).getBigUint64(0, true);
const u16 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset + o, 2).getUint16(0, true);

export const fromBase64 = (s: string): Uint8Array => base64.decode(s);
export const toBase64 = (b: Uint8Array): string => base64.encode(b);

/** Decode the swap instruction's fixed arguments; throws for any other instruction (ExactOut, legacy v1 routes…). */
export function decodeSwapArgs(data: Uint8Array): JupiterSwapArgs {
  const disc = hex(data.subarray(0, 8));
  const at = disc === ROUTE_V2 ? 8 : disc === SHARED_ACCOUNTS_ROUTE_V2 ? 9 : -1;
  if (at < 0) throw new Error(`unsupported Jupiter instruction ${disc}`);
  if (data.length < at + 22 + 4) throw new Error("Jupiter swap instruction is truncated");
  return {
    kind: at === 8 ? "route_v2" : "shared_accounts_route_v2",
    inAmount: u64(data, at),
    quotedOutAmount: u64(data, at + 8),
    slippageBps: u16(data, at + 16),
    platformFeeBps: u16(data, at + 18),
    positiveSlippageBps: u16(data, at + 20),
  };
}

/** The worst output the program accepts: quoted · (10 000 − slippage) / 10 000, rounded down (never above the on-chain check). */
export function minOutOf(quotedOut: bigint, slippageBps: number): bigint {
  return (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** ComputeBudget instructions: 2 = SetComputeUnitLimit(u32), 3 = SetComputeUnitPrice(u64 micro-lamports). */
export function decodeComputeBudget(data: Uint8Array): {limit?: number; price?: bigint} {
  if (data[0] === 2 && data.length === 5) return {limit: new DataView(data.buffer, data.byteOffset + 1, 4).getUint32(0, true)};
  if (data[0] === 3 && data.length === 9) return {price: u64(data, 1)};
  throw new Error(`unexpected compute-budget instruction ${data[0]}`);
}

export function setComputeUnitLimit(units: number): Uint8Array {
  const d = new Uint8Array(5);
  d[0] = 2;
  new DataView(d.buffer).setUint32(1, units, true);
  return d;
}

export function setComputeUnitPrice(microLamports: bigint): Uint8Array {
  const d = new Uint8Array(9);
  d[0] = 3;
  new DataView(d.buffer).setBigUint64(1, microLamports, true);
  return d;
}
