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

export function decodeUint(hex: string): bigint {
  const h = hex.replace(/^0x/, '')
  return h ? BigInt('0x' + h) : 0n
}
