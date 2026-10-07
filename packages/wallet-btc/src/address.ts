import { Address, OutScript, p2tr, p2wpkh } from '@scure/btc-signer'
import type { BTC_NETWORK } from '@scure/btc-signer/utils.js'
import type { BtcAddressType } from './types.js'

/** Output-script families btc-signer recognises (`OutScript.decode(...).type`). */
export type ScriptKind = 'pk' | 'pkh' | 'sh' | 'wsh' | 'wpkh' | 'ms' | 'tr' | 'tr_ns' | 'tr_ms' | 'p2a' | 'unknown'

export interface DecodedAddress {
  script: Uint8Array
  kind: ScriptKind
}

/** Decode and validate an address for `network`; throws on a malformed address or a foreign network. */
export function decodeAddress(address: string, network: BTC_NETWORK): DecodedAddress {
  let decoded
  try { decoded = Address(network).decode(address) } catch (e) {
    throw new Error(`Invalid bitcoin address for this network: ${address}`, { cause: e })
  }
  return { script: OutScript.encode(decoded), kind: decoded.type as ScriptKind }
}

/** Address for an output script, or undefined when the script has no address form. */
export function addressFromScript(script: Uint8Array, network: BTC_NETWORK): string | undefined {
  try { return Address(network).encode(OutScript.decode(script)) } catch { return undefined }
}

export function scriptKind(script: Uint8Array): ScriptKind {
  try { return OutScript.decode(script).type as ScriptKind } catch { return 'unknown' }
}

/** Spend descriptor for OUR key: p2wpkh from the compressed key, p2tr from its x-only form (BIP-86 key-path, no script tree). */
export function spendInfo(publicKey: Uint8Array, network: BTC_NETWORK, type: BtcAddressType) {
  if (type === 'p2tr') return p2tr(publicKey.length === 33 ? publicKey.subarray(1) : publicKey, undefined, network)
  return p2wpkh(publicKey, network)
}

export function addressFromPublicKey(publicKey: Uint8Array, network: BTC_NETWORK, type: BtcAddressType = 'p2wpkh'): string {
  const { address } = spendInfo(publicKey, network, type)
  if (!address) throw new Error(`Could not derive a ${type} address`)
  return address
}

// ── Size + dust constants (Bitcoin Core policy) ─────────────────────────────

/** Weight units one of OUR inputs adds once signed (prevout 41 B × 4 + witness). p2wpkh assumes a 72-byte DER sig. */
export const INPUT_WEIGHT: Record<BtcAddressType, number> = { p2wpkh: 272, p2tr: 230 }

/** Virtual bytes an output of this script kind occupies (8 B value + 1 B len + script). */
export function outputVBytes(kind: ScriptKind, script?: Uint8Array): number {
  switch (kind) {
    case 'wpkh': return 31
    case 'tr': case 'wsh': return 43
    case 'pkh': return 34
    case 'sh': return 32
    default: return 9 + (script?.length ?? 34)
  }
}

/** Bitcoin Core dust threshold (3 sat/vB discard rate) per output type, in sats. */
export function dustLimit(kind: ScriptKind): bigint {
  switch (kind) {
    case 'wpkh': return 294n
    case 'tr': case 'wsh': return 330n
    case 'pkh': return 546n
    case 'sh': return 540n
    default: return 546n
  }
}

export const DUST_LIMIT_P2WPKH = dustLimit('wpkh')
export const DUST_LIMIT_P2TR = dustLimit('tr')

export const kindOfType = (type: BtcAddressType): ScriptKind => (type === 'p2tr' ? 'tr' : 'wpkh')
