/**
 * ENSIP-9 / ENSIP-11 coin types for the chains we resolve, and the decoding of
 * the raw `addr(node, coinType)` bytes into each chain's address form.
 */
import { getAddress } from 'viem'
import { base58check, bech32, bech32m } from '@scure/base'
import { sha256 } from '@noble/hashes/sha256'
import { NameError } from '@anywalletkit/core'

export const BTC_CAIP2 = 'bip122:000000000019d6689c085ae165831e93'
export const SOL_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'

/** ENSIP-11: EVM chains other than mainnet use `0x80000000 | chainId`. */
export function coinTypeFor(chain: string): bigint | null {
  if (chain === 'eip155:1') return 60n
  if (chain.startsWith('eip155:')) {
    const id = Number(chain.slice('eip155:'.length))
    if (!Number.isSafeInteger(id) || id <= 0 || id >= 0x80000000) return null
    return BigInt(0x80000000 + id)
  }
  // Wallets spell these chains differently (`bitcoin:mainnet`, `solana:mainnet` in Vaulty; CAIP-2 genesis ids elsewhere): the namespace decides.
  if (chain === BTC_CAIP2 || chain.startsWith('bip122:') || chain.startsWith('bitcoin:')) return 0n
  if (chain === SOL_CAIP2 || chain.startsWith('solana:')) return 501n
  return null
}

const b58check = base58check(sha256)
const hex = (h: string) => {
  const s = h.startsWith('0x') ? h.slice(2) : h
  if (s.length % 2) throw new Error('odd hex')
  return Uint8Array.from(s.match(/.{2}/g) ?? [], (b) => parseInt(b, 16))
}

/** The address record's bytes → the chain's canonical address string. */
export function decodeAddressRecord(chain: string, raw: string, name: string): string {
  if (chain.startsWith('eip155:')) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new NameError('not-found', `${name}: malformed address record for ${chain}`, { name, chain })
    return getAddress(raw)
  }
  const bytes = hex(raw)
  if (coinTypeFor(chain) === 501n) {
    if (bytes.length !== 32) throw new NameError('not-found', `${name}: malformed Solana record`, { name, chain })
    return base58(bytes)
  }
  if (coinTypeFor(chain) === 0n) return decodeBtcScript(bytes, name)
  throw new NameError('unsupported', `${chain} is not a chain ENS can resolve here`, { name, chain })
}

/** Plain base58 (no checksum) — Solana public keys. */
function base58(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let out = ''
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = '1' + out
  }
  return out
}

/** ENSIP-9 stores Bitcoin addresses as the scriptPubKey. P2PKH / P2SH / P2WPKH / P2WSH / P2TR. */
export function decodeBtcScript(script: Uint8Array, name: string): string {
  const chain = BTC_CAIP2
  const at = (i: number) => script[i] ?? -1
  if (script.length === 25 && at(0) === 0x76 && at(1) === 0xa9 && at(2) === 0x14 && at(23) === 0x88 && at(24) === 0xac) {
    return b58check.encode(Uint8Array.from([0x00, ...script.subarray(3, 23)]))
  }
  if (script.length === 23 && at(0) === 0xa9 && at(1) === 0x14 && at(22) === 0x87) {
    return b58check.encode(Uint8Array.from([0x05, ...script.subarray(2, 22)]))
  }
  if (script.length >= 2 && at(0) === 0x00 && (at(1) === 0x14 || at(1) === 0x20) && script.length === 2 + at(1)) {
    return bech32.encode('bc', [0, ...bech32.toWords(script.subarray(2))], 90)
  }
  if (script.length === 34 && at(0) === 0x51 && at(1) === 0x20) {
    return bech32m.encode('bc', [1, ...bech32m.toWords(script.subarray(2))], 90)
  }
  throw new NameError('not-found', `${name}: Bitcoin record is not a standard script`, { name, chain })
}
