import { SignerError } from '@anywalletkit/core'
import { getAddressDecoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit'

/**
 * Off-chain message signing must never produce a signature that is also valid
 * on-chain. A Solana transaction signature is a plain ed25519 signature over
 * the compiled message bytes, so a "message" whose bytes ARE a compiled
 * transaction message (legacy, v0 or v1) naming this key as a required signer
 * would be a transaction approved without any transaction review.
 *
 * The rule is deliberately narrow so existing off-chain verifiers keep working
 * (messages are still signed raw, never wrapped): only bytes that decode
 * EXACTLY — every byte consumed, no trailing data — as a compiled message, or
 * as a full wire transaction carrying one, AND list the signer in one of the
 * `header.numSignerAccounts` required-signer slots are refused. The smallest
 * legacy message is 69 bytes, so 32/64-byte nonces can never match.
 */

/** `\xffsolana offchain` — the signing-domain header of the Solana off-chain message format. */
export const SOLANA_OFFCHAIN_MESSAGE_PREFIX: Uint8Array = Uint8Array.from([0xff, ...Array.from('solana offchain', (c) => c.charCodeAt(0))])

/** Refused before signing: the "message" is a Solana transaction this account would sign for. */
export class MessageIsTransactionError extends SignerError {
  /** Machine-readable code. */
  readonly code = 'message-is-transaction'
  constructor(message = 'This message is a Solana transaction; use signTransaction so it can be reviewed.') {
    super(message)
    this.name = 'MessageIsTransactionError'
  }
}

const toAddress = (signer: string | Uint8Array): string => (typeof signer === 'string' ? signer : getAddressDecoder().decode(signer))

/** Required-signer addresses of `bytes` when they decode exactly as a compiled message; otherwise null. */
function exactMessageSigners(bytes: Uint8Array): readonly string[] | null {
  if (bytes.length === 0) return null
  try {
    const [msg, end] = getCompiledTransactionMessageDecoder().read(bytes, 0)
    if (end !== bytes.length) return null
    return (msg.staticAccounts as readonly string[]).slice(0, msg.header.numSignerAccounts)
  } catch {
    return null
  }
}

/** Required-signer addresses when `bytes` are a full wire transaction (signatures + exact message); otherwise null. */
function wireTransactionSigners(bytes: Uint8Array): readonly string[] | null {
  if (bytes.length === 0) return null
  try {
    const tx = getTransactionDecoder().decode(bytes)
    return exactMessageSigners(tx.messageBytes as unknown as Uint8Array)
  } catch {
    return null
  }
}

/**
 * True when `bytes` are a legacy / v0 / v1 compiled transaction message, or a
 * wire transaction, that decodes exactly and lists `signer` (32-byte public key
 * or base58 address) among its required signers. Such bytes must never be
 * signed as an off-chain message.
 */
export function isSolanaTransactionPayload(bytes: Uint8Array, signer: string | Uint8Array): boolean {
  const me = toAddress(signer)
  for (const signers of [exactMessageSigners(bytes), wireTransactionSigners(bytes)]) {
    if (signers?.includes(me)) return true
  }
  return false
}

/** True when the bytes start with the Solana off-chain message header (`\xffsolana offchain`). */
export function hasSolanaOffchainHeader(bytes: Uint8Array): boolean {
  if (bytes.length < SOLANA_OFFCHAIN_MESSAGE_PREFIX.length) return false
  return SOLANA_OFFCHAIN_MESSAGE_PREFIX.every((b, i) => bytes[i] === b)
}

/** Strict UTF-8 check (no overlongs, surrogates or > U+10FFFF); no TextDecoder, so it runs on Hermes. */
function isValidUtf8(b: Uint8Array): boolean {
  let i = 0
  while (i < b.length) {
    const c = b[i]!
    if (c < 0x80) { i++; continue }
    let n: number, min: number, cp: number
    if (c >= 0xc2 && c <= 0xdf) { n = 1; min = 0x80; cp = c & 0x1f }
    else if (c >= 0xe0 && c <= 0xef) { n = 2; min = 0x800; cp = c & 0x0f }
    else if (c >= 0xf0 && c <= 0xf4) { n = 3; min = 0x10000; cp = c & 0x07 }
    else return false
    for (let k = 1; k <= n; k++) {
      const d = b[i + k]
      if (d === undefined || (d & 0xc0) !== 0x80) return false
      cp = (cp << 6) | (d & 0x3f)
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false
    i += n + 1
  }
  return true
}

/** Readable text: valid UTF-8 with no control characters other than tab, LF and CR. */
export function isReadableText(bytes: Uint8Array): boolean {
  if (!isValidUtf8(bytes)) return false
  for (const c of bytes) if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return false
  return true
}

/**
 * What an off-chain "sign message" payload is, for the approval UI:
 * - `transaction` — refuse (see {@link isSolanaTransactionPayload});
 * - `offchain` — Solana off-chain message format (header-prefixed);
 * - `text` — readable UTF-8;
 * - `binary` — anything else: allowed, but the user cannot see what it commits to.
 */
export type SolanaMessageKind = 'transaction' | 'offchain' | 'text' | 'binary'

/**
 * Classify bytes a site asks the wallet to sign as a message. Refuse `transaction`; show `text` and
 * `offchain` content; warn on `binary`.
 */
export function classifySolanaMessage(bytes: Uint8Array, signer: string | Uint8Array): SolanaMessageKind {
  if (isSolanaTransactionPayload(bytes, signer)) return 'transaction'
  if (hasSolanaOffchainHeader(bytes)) return 'offchain'
  if (isReadableText(bytes)) return 'text'
  return 'binary'
}
