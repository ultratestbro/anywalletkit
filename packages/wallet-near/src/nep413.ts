/**
 * NEP-413 "Sign Message" (https://github.com/near/NEPs/blob/master/neps/nep-0413.md):
 * the off-chain message standard NEAR wallets and NEAR Intents use. The signed
 * bytes are sha256( u32le(2^31 + 413) ‖ borsh(Payload) ), and the prefix keeps a
 * message from ever being a valid transaction.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { BorshWriter } from './borsh.js'

/** NEP-413 tag (2^31 + 413) that keeps a signed message from being a valid transaction. */
export const NEP413_PREFIX = 2 ** 31 + 413

/** A NEP-413 sign-in message, as a site asks for it. */
export interface Nep413Payload {
  message: string
  /** 32 random bytes chosen by the verifier (replay protection). */
  nonce: Uint8Array
  /** Who the message is for (e.g. "intents.near"). */
  recipient: string
  callbackUrl?: string
}

/** A NEP-413 signature and the key that made it. */
export interface Nep413Signed {
  /** Base64 of the 64-byte ed25519 signature — the encoding wallets return. */
  signature: string
  /** "ed25519:<base58>" */
  publicKey: string
  accountId: string
}

/** Borsh bytes of a NEP-413 payload, ready to hash and sign. */
export function nep413Bytes(p: Nep413Payload): Uint8Array {
  if (p.nonce.length !== 32) throw new RangeError('NEP-413 nonce must be 32 bytes')
  const w = new BorshWriter()
  w.u32(NEP413_PREFIX)
  w.string(p.message).bytes(p.nonce).string(p.recipient)
  w.option(p.callbackUrl, (u) => w.string(u))
  return w.toBytes()
}

/** The 32-byte digest an ed25519 signer signs for a NEP-413 message. */
export function nep413Hash(p: Nep413Payload): Uint8Array {
  return sha256(nep413Bytes(p))
}
