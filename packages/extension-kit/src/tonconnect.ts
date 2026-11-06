/**
 * TON Connect protocol v2 for the extension's JS bridge. Request parsing, error codes and the
 * signature digests live in one place, `@anywalletkit/wallet-ton/tonconnect`, shared with the
 * WalletConnect transport (`@anywalletkit/walletconnect-ton`); this module re-exports them and
 * keeps the bridge-side helpers (the page origin as the proof domain, relay errors as TON Connect
 * codes). The wallet side (keys, sheet, broadcast) lives in the extension; nothing here touches a key.
 *
 * To SIGN, use `WalletAccountTon.signTonProof` / `signTonConnectData` (wallet-ton): they build the
 * same digests from the request and the account's own address. `account.sign()` refuses these
 * 32-byte digests — 32 raw bytes may as well be the hash of a transfer — so the digest functions
 * here are for checking a proof, not for feeding `sign()`.
 */
import { TONCONNECT_ERRORS, TonConnectError, tonAddressParts, tonProofDigest, tonSignDataDigest, type TonSignDataPayload } from '@anywalletkit/wallet-ton/tonconnect'

export {
  TONCONNECT_ERRORS, TONCONNECT_MAX_MESSAGES, TONCONNECT_NETWORKS, TONCONNECT_SIGN_DATA_MAX, TonConnectError,
  parseConnectRequest, parseSendTransaction, parseSignData, tonConnectRawAddress, tonConnectFriendlyAddress, sameTonConnectAddress,
  type TonConnectRequest, type TonConnectMessage, type TonConnectSendTransaction, type TonConnectParseOptions, type TonConnectSendOptions, type TonSignDataPayload,
} from '@anywalletkit/wallet-ton/tonconnect'

/** Workchain and 32-byte account hash of a TON address. */
export interface TonAddressParts { workchain: number; hash: Uint8Array }

const parts = (a: TonAddressParts) => {
  if (a.hash.length !== 32) throw new TonConnectError(TONCONNECT_ERRORS.unknown, 'address hash must be 32 bytes')
  return { workChain: a.workchain, hash: a.hash }
}

/** The 32-byte digest a wallet signs for `ton_proof` — to verify a proof; sign with `WalletAccountTon.signTonProof`. */
export function tonProofMessage(input: { address: TonAddressParts; domain: string; timestamp: number; payload: string }): Uint8Array {
  return tonProofDigest(parts(input.address), { domain: input.domain, timestamp: input.timestamp, payload: input.payload })
}

/** The 32-byte digest a wallet signs for `signData` (text / binary) — to verify; sign with `WalletAccountTon.signTonConnectData`. */
export function tonSignDataMessage(input: { address: TonAddressParts; domain: string; timestamp: number; payload: TonSignDataPayload }): Uint8Array {
  return tonSignDataDigest(parts(input.address), { domain: input.domain, timestamp: input.timestamp, payload: input.payload })
}

/** `0:abcd…` → parts. Friendly addresses are the wallet package's job (it hands us the raw form). */
export function parseRawAddress(raw: string): TonAddressParts {
  if (!/^-?\d+:[0-9a-fA-F]{64}$/.test(raw)) throw new TonConnectError(TONCONNECT_ERRORS.unknown, `not a raw TON address: ${raw}`)
  try {
    const p = tonAddressParts(raw)
    return { workchain: p.workChain, hash: p.hash }
  } catch {
    throw new TonConnectError(TONCONNECT_ERRORS.unknown, `not a raw TON address: ${raw}`)
  }
}

/** The dApp's domain for proofs, from the page origin (host only, as the spec's `domain.value`). */
export function proofDomain(origin: string): string {
  try { return new URL(origin).host } catch { throw new TonConnectError(TONCONNECT_ERRORS.badRequest, `bad origin ${origin}`) }
}

/** Our relay errors → TON Connect error codes. */
export function tonConnectErrorCode(e: unknown): number {
  if (e instanceof TonConnectError || (e as { name?: unknown } | null)?.name === 'TonConnectError') return (e as TonConnectError).code
  const code = (e as { code?: unknown })?.code
  if (code === 4001) return TONCONNECT_ERRORS.userDeclined
  if (code === 4100) return TONCONNECT_ERRORS.unknownApp
  if (code === 4200) return TONCONNECT_ERRORS.methodNotSupported
  if (code === -32602) return TONCONNECT_ERRORS.badRequest
  return TONCONNECT_ERRORS.unknown
}
