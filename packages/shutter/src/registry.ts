/**
 * The ShutterRegistry contract: `register(uint64 eon, bytes32 identityPrefix, uint64 timestamp)` derives the identity
 * as keccak256(identityPrefix ‖ msg.sender), so an identity registered from the user's own account depends on no API.
 * Calldata is built here (no ABI library); sending it is the wallet's job.
 */
import { keccak_256 } from '@noble/hashes/sha3.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { bytesOf, toHex, type BytesLike } from './bytes.js'
import { ShutterCryptoError } from './errors.js'

const REGISTER_SELECTOR = 'eaac3573' // register(uint64,bytes32,uint64)
const REGISTRATIONS_SELECTOR = 'da7c6a42' // registrations(bytes32)
const MAX_U64 = (1n << 64n) - 1n

function word(value: bigint): string {
  if (value < 0n || value > MAX_U64) throw new ShutterCryptoError('value does not fit uint64')
  return value.toString(16).padStart(64, '0')
}

function address20(address: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new ShutterCryptoError(`not an EVM address: ${address}`)
  return bytesOf(address, 'address')
}

function prefix32(identityPrefix: BytesLike): Uint8Array {
  const p = bytesOf(identityPrefix, 'identity prefix')
  if (p.length !== 32) throw new ShutterCryptoError('identity prefix must be 32 bytes')
  if (p.every((b) => b === 0)) throw new ShutterCryptoError('identity prefix must not be zero') // the registry refuses it
  return p
}

/** The identity the registry derives for a prefix registered by `registrant`: keccak256(prefix ‖ registrant). */
export function deriveIdentity(identityPrefix: BytesLike, registrant: string): `0x${string}` {
  return toHex(keccak_256(concatBytes(prefix32(identityPrefix), address20(registrant))))
}

/** Calldata of `register(eon, identityPrefix, timestamp)`; send it from the account that will own the identity. */
export function registerCalldata(input: { eon: number | bigint; identityPrefix: BytesLike; revealAt: number | bigint }): `0x${string}` {
  return `0x${REGISTER_SELECTOR}${word(BigInt(input.eon))}${toHex(prefix32(input.identityPrefix)).slice(2)}${word(BigInt(input.revealAt))}`
}

/** Calldata of `registrations(identity)`. */
export function registrationsCalldata(identity: BytesLike): `0x${string}` {
  const id = bytesOf(identity, 'identity')
  if (id.length !== 32) throw new ShutterCryptoError('identity must be 32 bytes')
  return `0x${REGISTRATIONS_SELECTOR}${toHex(id).slice(2)}`
}

/** Decode `registrations(identity)`'s answer: `null` when the identity is not registered (timestamp 0). */
export function decodeRegistration(result: string): { eon: bigint; revealAt: bigint } | null {
  const hex = result.startsWith('0x') ? result.slice(2) : result
  if (!/^[0-9a-fA-F]{128}$/.test(hex)) throw new ShutterCryptoError('unexpected registrations() answer')
  const eon = BigInt(`0x${hex.slice(0, 64)}`)
  const revealAt = BigInt(`0x${hex.slice(64, 128)}`)
  if (eon > MAX_U64 || revealAt > MAX_U64) throw new ShutterCryptoError('unexpected registrations() answer')
  return revealAt === 0n ? null : { eon, revealAt }
}
