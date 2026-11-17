/**
 * Just enough RLP to read back a signed EIP-1559 transaction: the encrypted transaction must be exactly the one the
 * wallet was asked to sign (nonce, gas limit, chain), or the keypers' validators skip it and the fee is lost.
 */
import { ShutterError } from './errors.js'

export type RlpItem = Uint8Array | RlpItem[]

function length(bytes: Uint8Array, at: number, size: number): number {
  if (size > 4 || at + size > bytes.length) throw new ShutterError('malformed RLP')
  let n = 0
  for (let i = 0; i < size; i++) n = n * 256 + bytes[at + i]!
  return n
}

function item(bytes: Uint8Array, at: number): { value: RlpItem; end: number } {
  const b = bytes[at]
  if (b === undefined) throw new ShutterError('malformed RLP')
  if (b < 0x80) return { value: bytes.subarray(at, at + 1), end: at + 1 }
  if (b < 0xc0) {
    const long = b > 0xb7
    const size = long ? length(bytes, at + 1, b - 0xb7) : b - 0x80
    const start = at + 1 + (long ? b - 0xb7 : 0)
    if (start + size > bytes.length) throw new ShutterError('malformed RLP')
    return { value: bytes.subarray(start, start + size), end: start + size }
  }
  const long = b > 0xf7
  const size = long ? length(bytes, at + 1, b - 0xf7) : b - 0xc0
  const start = at + 1 + (long ? b - 0xf7 : 0)
  const end = start + size
  if (end > bytes.length) throw new ShutterError('malformed RLP')
  const list: RlpItem[] = []
  for (let p = start; p < end;) {
    const next = item(bytes, p)
    list.push(next.value)
    p = next.end
  }
  return { value: list, end }
}

/** Decode one RLP item that spans all of `bytes`. */
export function rlpDecode(bytes: Uint8Array): RlpItem {
  const { value, end } = item(bytes, 0)
  if (end !== bytes.length) throw new ShutterError('malformed RLP (trailing bytes)')
  return value
}

export function rlpUint(value: RlpItem | undefined): bigint {
  if (!(value instanceof Uint8Array)) throw new ShutterError('malformed RLP (expected a number)')
  if (value.length > 0 && value[0] === 0) throw new ShutterError('malformed RLP (leading zero)')
  let n = 0n
  for (const b of value) n = (n << 8n) | BigInt(b)
  return n
}
