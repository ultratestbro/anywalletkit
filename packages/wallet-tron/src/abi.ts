import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { toEvmHex } from './address.js'

/** 4-byte selector of "name(type,…)". */
export function selector(signature: string): string {
  return bytesToHex(keccak_256(new TextEncoder().encode(signature))).slice(0, 8)
}

/** Minimal static ABI encoder: address, uintN/intN, bool, bytes32. Enough for TRC-20 calls. */
export function encodeParameters(params: Array<{ type: string; value: unknown }>): string {
  return params.map(({ type, value }) => {
    if (type === 'address') return toEvmHex(String(value)).padStart(64, '0')
    if (/^u?int\d*$/.test(type)) {
      let v = BigInt(value as bigint | number | string)
      if (v < 0n) v = (1n << 256n) + v
      return v.toString(16).padStart(64, '0')
    }
    if (type === 'bool') return (value ? '1' : '0').padStart(64, '0')
    if (type === 'bytes32') return String(value).replace(/^0x/, '').padEnd(64, '0')
    throw new Error(`encodeParameters: unsupported type ${type}`)
  }).join('')
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
    const len = Number(decodeUint(words[1]!))
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
