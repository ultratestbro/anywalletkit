import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { toEvmHex } from './address.js'

/** 4-byte selector of "name(type,…)". */
export function selector(signature: string): string {
  return bytesToHex(keccak_256(new TextEncoder().encode(signature))).slice(0, 8)
}

/** `uintN` / `intN` → [signed, bits]; `uint` / `int` are 256. Undefined for any other type or a width that is not 8..256 in steps of 8. */
function intType(type: string): [signed: boolean, bits: number] | undefined {
  const m = /^(u?)int(\d*)$/.exec(type)
  if (!m) return undefined
  const bits = m[2] === '' ? 256 : Number(m[2])
  if (!/^(|[1-9]\d*)$/.test(m[2]!) || bits < 8 || bits > 256 || bits % 8 !== 0) return undefined
  return [m[1] === '', bits]
}

/** An integer argument as the caller wrote it: a bigint, a safe integer, or a decimal / 0x string (no whitespace, no 0b / 0o). */
function intValue(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^(-?\d{1,78}|0x[0-9a-fA-F]{1,64})$/.test(value)) return BigInt(value)
  throw new Error(`encodeParameters: ${String(value)} is not an integer argument`)
}

/** The canonical type name the selector hashes: `uint` → `uint256`, `int` → `int256`. */
function canonicalType(type: string): string {
  return type === 'uint' ? 'uint256' : type === 'int' ? 'int256' : type
}

/**
 * Minimal static ABI encoder: address, uintN/intN, bool, bytes32. Enough for TRC-20 calls. Every
 * argument encodes to exactly one 32-byte word: a bytes32 longer than 32 bytes or a uint past its
 * width would spill into the next words and shift every argument after it (scan 2026-10-27 F14, F15).
 */
export function encodeParameters(params: Array<{ type: string; value: unknown }>): string {
  return params.map(({ type, value }) => {
    let word: string
    const int = intType(type)
    if (type === 'address') {
      if (typeof value !== 'string') throw new Error('encodeParameters: an address argument must be a string')
      word = toEvmHex(value).padStart(64, '0')
    } else if (int) {
      const [signed, bits] = int
      const v = intValue(value)
      const min = signed ? -(1n << BigInt(bits - 1)) : 0n
      const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n
      if (v < min || v > max) throw new Error(`encodeParameters: ${v} does not fit ${type}`)
      word = (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, '0')
    } else if (type === 'bool') {
      if (typeof value !== 'boolean') throw new Error('encodeParameters: a bool argument must be true or false')
      word = (value ? '1' : '0').padStart(64, '0')
    } else if (type === 'bytes32') {
      if (typeof value !== 'string' || !/^(0x)?([0-9a-fA-F]{2}){0,32}$/.test(value)) throw new Error('encodeParameters: a bytes32 argument must be at most 32 bytes of hex')
      word = value.replace(/^0x/, '').toLowerCase().padEnd(64, '0')
    } else {
      throw new Error(`encodeParameters: unsupported type ${type}`)
    }
    if (word.length !== 64) throw new Error(`encodeParameters: ${type} argument does not encode to one word`)
    return word
  }).join('')
}

/**
 * Calldata words for `functionSelector` ("name(type,…)", no spaces): the parameters must match the
 * signature in count and type, so the contract decodes exactly the arguments the caller named.
 */
export function encodeCall(functionSelector: string, params: Array<{ type: string; value: unknown }>): string {
  const m = /^[A-Za-z_$][A-Za-z0-9_$]*\(([A-Za-z0-9,]*)\)$/.exec(functionSelector)
  if (!m) throw new Error(`encodeCall: "${functionSelector}" is not a function signature name(type,…)`)
  const types = m[1] === '' ? [] : m[1]!.split(',')
  if (types.length !== params.length) throw new Error(`encodeCall: ${functionSelector} takes ${types.length} parameter(s), ${params.length} given`)
  types.forEach((t, i) => {
    if (canonicalType(t) !== canonicalType(params[i]!.type)) throw new Error(`encodeCall: parameter ${i} of ${functionSelector} has type ${t}, not ${params[i]!.type}`)
  })
  return selector(functionSelector) + encodeParameters(params)
}

/** A hex word as a bigint (empty hex is 0). */
export function decodeUint(hex: string): bigint {
  const h = hex.replace(/^0x/, '')
  return h ? BigInt('0x' + h) : 0n
}

/** 32-byte ABI word → 21-byte Tron hex address ("41" + last 20 bytes). */
export function decodeAddressWord(word: string): string {
  return '41' + word.replace(/^0x/, '').padStart(64, '0').slice(24)
}

/** Split calldata hex into selector + 32-byte words (partial trailing word dropped). */
export function splitCalldata(data: string): { selector: string; words: string[] } {
  const h = data.replace(/^0x/, '').toLowerCase()
  const selector = h.slice(0, 8)
  const words: string[] = []
  for (let i = 8; i + 64 <= h.length; i += 64) words.push(h.slice(i, i + 64))
  return { selector, words }
}

/** ABI-decode `Error(string)` / `Panic(uint256)` revert data; falls back to the hex itself. */
export function decodeRevertReason(hex: string | undefined): string | undefined {
  if (!hex) return undefined
  const h = hex.replace(/^0x/, '')
  if (!h) return undefined
  const { selector, words } = splitCalldata(h)
  if (selector === '08c379a0' && words.length >= 2) {
    const length = decodeUint(words[1]!)
    if (length > BigInt(h.length)) return undefined // a length past the data: not an Error(string)
    const len = Number(length.toString())
    const start = 8 + 64 * 2
    const bytes = h.slice(start, start + len * 2)
    try { return new TextDecoder().decode(Uint8Array.from(bytes.match(/.{2}/g) ?? [], (b) => parseInt(b, 16))) } catch { /* fall through */ }
  }
  if (selector === '4e487b71' && words.length >= 1) return `Panic(0x${decodeUint(words[0]!).toString(16)})`
  return h
}

/** Hex → UTF-8 text when it decodes cleanly, else the hex. */
export function hexToText(hex: string): string {
  const h = hex.replace(/^0x/, '')
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2) return hex
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(h.match(/.{2}/g) ?? [], (b) => parseInt(b, 16))) } catch { return hex }
}
