/**
 * Zcash transparent addresses: Base58Check with a two-byte version prefix.
 *   mainnet  t1… P2PKH 0x1CB8   t3… P2SH 0x1CBD
 *   testnet  tm… P2PKH 0x1D25   t2… P2SH 0x1CBA
 * Shielded (zs…, u1…) and Sprout (zc…) addresses are recognised and refused
 * with a message — this package sends transparent value only.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { base58check } from '@scure/base'
import type { ZcashNetwork } from './types.js'

const b58 = base58check(sha256)

/** Transparent address type: pay-to-pubkey-hash (`t1…`) or pay-to-script-hash (`t3…`). */
export type ScriptKind = 'p2pkh' | 'p2sh'

/** A transparent address decoded to its type and 20-byte hash. */
export interface DecodedAddress {
  kind: ScriptKind
  /** 20-byte hash (pubkey hash or script hash). */
  hash: Uint8Array
  /** The scriptPubKey. */
  script: Uint8Array
}

const PREFIX: Record<ZcashNetwork, Record<ScriptKind, readonly [number, number]>> = {
  mainnet: { p2pkh: [0x1c, 0xb8], p2sh: [0x1c, 0xbd] },
  testnet: { p2pkh: [0x1d, 0x25], p2sh: [0x1c, 0xba] },
}

/** Base58Check version prefix for a transparent address kind on a network (exported for tests / tooling). */
export function addressPrefix(network: ZcashNetwork, kind: ScriptKind): readonly [number, number] {
  return PREFIX[network][kind]
}

/** RIPEMD-160 of SHA-256, the hash inside a transparent address. */
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data))
}

/** OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG, or OP_HASH160 <20> OP_EQUAL. */
export function scriptFor(kind: ScriptKind, hash: Uint8Array): Uint8Array {
  if (hash.length !== 20) throw new Error('A transparent script needs a 20-byte hash')
  if (kind === 'p2pkh') return Uint8Array.of(0x76, 0xa9, 0x14, ...hash, 0x88, 0xac)
  return Uint8Array.of(0xa9, 0x14, ...hash, 0x87)
}

/** Type of an output script; `unknown` for anything but p2pkh and p2sh. */
export function scriptKind(script: Uint8Array): ScriptKind | 'unknown' {
  if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 && script[23] === 0x88 && script[24] === 0xac) return 'p2pkh'
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) return 'p2sh'
  return 'unknown'
}

/** Transparent address of a 20-byte hash. */
export function encodeAddress(kind: ScriptKind, hash: Uint8Array, network: ZcashNetwork): string {
  if (hash.length !== 20) throw new Error('A transparent address needs a 20-byte hash')
  const [a, b] = PREFIX[network][kind]
  return b58.encode(Uint8Array.of(a, b, ...hash))
}

/** Decode and validate a transparent address for `network`; throws a message that names the problem. */
export function decodeAddress(address: string, network: ZcashNetwork): DecodedAddress {
  // Never trimmed: a policy reads the string as given, so ' t1…' or 't1…\uFEFF' must not quietly become
  // the address it compared against (scan 2026-10-27 F19).
  if (typeof address !== 'string' || /\s/.test(address)) throw new Error(`Invalid Zcash address: it carries whitespace or an invisible character (${JSON.stringify(address)}).`)
  const a = address
  if (/^u1|^utest/i.test(a)) throw new Error(`Unified address (${a.slice(0, 6)}…) — shielded receivers are not supported; use a transparent t-address.`)
  if (/^zs1|^ztestsapling/i.test(a)) throw new Error('Sapling shielded address (zs1…) — this wallet sends to transparent t-addresses only.')
  if (/^zc/i.test(a) && a.length > 90) throw new Error('Sprout address (zc…) — the Sprout pool is deprecated; use a transparent t-address.')
  let payload: Uint8Array
  try { payload = b58.decode(a) } catch (e) {
    throw new Error(`Invalid Zcash address: ${a}`, { cause: e })
  }
  if (payload.length !== 22) throw new Error(`Invalid Zcash address: ${a}`)
  const p0 = payload[0]!, p1 = payload[1]!
  for (const net of ['mainnet', 'testnet'] as const) {
    for (const kind of ['p2pkh', 'p2sh'] as const) {
      const [a0, a1] = PREFIX[net][kind]
      if (p0 === a0 && p1 === a1) {
        if (net !== network) throw new Error(`${a} is a Zcash ${net} address; this wallet is on ${network}.`)
        const hash = payload.slice(2)
        return { kind, hash, script: scriptFor(kind, hash) }
      }
    }
  }
  throw new Error(`Invalid Zcash address: ${a} (unknown version prefix)`)
}

/** Address for an output script, or undefined when the script has no address form. */
export function addressFromScript(script: Uint8Array, network: ZcashNetwork): string | undefined {
  const kind = scriptKind(script)
  if (kind === 'unknown') return undefined
  return encodeAddress(kind, kind === 'p2pkh' ? script.slice(3, 23) : script.slice(2, 22), network)
}

/** P2PKH address of a compressed secp256k1 public key (what `m/44'/133'/0'/0/i` yields). */
export function addressFromPublicKey(publicKey: Uint8Array, network: ZcashNetwork = 'mainnet'): string {
  if (publicKey.length !== 33) throw new Error('Expected a 33-byte compressed public key')
  return encodeAddress('p2pkh', hash160(publicKey), network)
}

/** Output size in bytes: 8 (value) + CompactSize + script. */
export function outputSize(script: Uint8Array): number {
  return 8 + (script.length < 0xfd ? 1 : 3) + script.length
}

/** Below this an output is uneconomic to spend (Bitcoin Core's P2PKH dust floor; zatoshis). */
export const DUST_LIMIT = 546n
