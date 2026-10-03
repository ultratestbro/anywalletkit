/**
 * The ONLY place a private key may exist. Accounts build transactions and talk
 * to the network; a Signer turns bytes into signatures and nothing else.
 *
 * `kind: 'seed'` — derived locally from a mnemonic (see `SeedSigner`).
 * `kind: 'external'` — a Safe, hardware wallet, MPC node or backend: the SDK
 * never sees the key and must tolerate `UserRejectedError`.
 */
export interface Signer {
  readonly kind: 'seed' | 'external'
  /** The curve this signer signs with. Chain packages assert the one they need. */
  readonly curve: 'secp256k1' | 'ed25519'
  getPublicKey(): Promise<Uint8Array>
  /** Sign an already-hashed or already-serialised payload. Chains decide what the bytes are. */
  sign(payload: Uint8Array): Promise<Uint8Array>
  /** Zeroize key material. Idempotent; the signer is unusable afterwards. */
  dispose(): void
}

/** A signer whose key came from a seed and that can derive children. */
export interface SeedSigner extends Signer {
  readonly kind: 'seed'
  /** The BIP-32 / SLIP-10 path this signer sits at (e.g. "m/44'/60'/0'/0/0"). */
  readonly path: string
  /** Derive a child along `relativePath` (e.g. "0/1"). Hardened-only for ed25519. */
  derive(relativePath: string): Promise<SeedSigner>
}

/** Narrowing helper. */
export function isSeedSigner(s: Signer): s is SeedSigner {
  return s.kind === 'seed'
}
