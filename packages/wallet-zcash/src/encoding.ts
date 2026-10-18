/** Byte helpers for the Zcash wire format (little-endian integers, Bitcoin CompactSize). */
export { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'

export function compactSize(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new Error(`CompactSize: ${n} is not a non-negative integer`)
  if (n < 0xfd) return Uint8Array.of(n)
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >>> 8)
  if (n <= 0xffffffff) return Uint8Array.of(0xfe, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24)
  throw new Error('CompactSize: value too large')
}

export function u32le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`u32: ${n} out of range`)
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24)
}

/** Signed 64-bit little-endian (two's complement). Amounts are never negative here, but ZIP-244 types the field as signed. */
export function i64le(v: bigint): Uint8Array {
  if (v < -(1n << 63n) || v >= 1n << 63n) throw new Error(`i64: ${v} out of range`)
  let x = v < 0n ? v + (1n << 64n) : v
  const out = new Uint8Array(8)
  for (let i = 0; i < 8; i++) { out[i] = Number(x & 0xffn); x >>= 8n }
  return out
}

export class Writer {
  private readonly parts: Uint8Array[] = []
  u8(n: number): this { this.parts.push(Uint8Array.of(n & 0xff)); return this }
  u32(n: number): this { this.parts.push(u32le(n)); return this }
  i64(v: bigint): this { this.parts.push(i64le(v)); return this }
  bytes(b: Uint8Array): this { this.parts.push(b); return this }
  compact(n: number): this { this.parts.push(compactSize(n)); return this }
  /** CompactSize length prefix + bytes (the "field encoding" of a script). */
  varBytes(b: Uint8Array): this { return this.compact(b.length).bytes(b) }
  finish(): Uint8Array {
    const len = this.parts.reduce((s, p) => s + p.length, 0)
    const out = new Uint8Array(len)
    let o = 0
    for (const p of this.parts) { out.set(p, o); o += p.length }
    return out
  }
}

export class Reader {
  offset = 0
  constructor(private readonly buf: Uint8Array) {}
  get remaining(): number { return this.buf.length - this.offset }
  private need(n: number): void {
    if (this.offset + n > this.buf.length) throw new Error('Transaction truncated')
  }
  u8(): number { this.need(1); return this.buf[this.offset++]! }
  u32(): number {
    this.need(4)
    const b = this.buf
    const o = this.offset
    this.offset += 4
    return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) + b[o + 3]! * 0x1000000
  }
  i64(): bigint {
    this.need(8)
    let v = 0n
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(this.buf[this.offset + i]!)
    this.offset += 8
    return v >= 1n << 63n ? v - (1n << 64n) : v
  }
  bytes(n: number): Uint8Array { this.need(n); const out = this.buf.slice(this.offset, this.offset + n); this.offset += n; return out }
  compact(): number {
    const first = this.u8()
    if (first < 0xfd) return first
    if (first === 0xfd) { this.need(2); const v = this.buf[this.offset]! | (this.buf[this.offset + 1]! << 8); this.offset += 2; return v }
    if (first === 0xfe) return this.u32()
    throw new Error('CompactSize: 64-bit lengths are not supported')
  }
  varBytes(): Uint8Array { return this.bytes(this.compact()) }
}

/** Display ↔ internal byte order of a 32-byte hash (Bitcoin convention: hex is shown reversed). */
export function reverseBytes(b: Uint8Array): Uint8Array {
  return Uint8Array.from(b).reverse()
}
