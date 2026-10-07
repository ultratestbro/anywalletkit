/**
 * The ONLY place a private key may exist. Accounts build transactions and talk
 * to the network; a Signer turns bytes into signatures and nothing else.
 *
 * `kind: 'seed'` — derived locally from a mnemonic (see {@link LocalSigner}).
 * `kind: 'external'` — a Safe, hardware wallet, MPC node or backend: the SDK
 * never sees the key and must tolerate `UserRejectedError`.
 *
 * Signature schemes (what the chain hands the signer, what comes back):
 *
 * | scheme               | curve     | payload            | result                          |
 * |----------------------|-----------|--------------------|---------------------------------|
 * | `ecdsa-recoverable`  | secp256k1 | 32-byte hash       | 65 bytes r‖s‖recovery (0 or 1)  |
 * | `ecdsa`              | secp256k1 | 32-byte hash       | 64 bytes r‖s, low-S             |
 * | `schnorr`            | secp256k1 | 32-byte message    | 64 bytes, BIP-340 (`tweak` → BIP-341 key-path) |
 * | `ed25519`            | ed25519   | message bytes      | 64 bytes, RFC 8032              |
 *
 * `context` is a free-form hint so a hardware/MPC signer can show the right
 * prompt or apply the right policy. Chains use:
 *
 * | context           | chain  | scheme              | payload                                   |
 * |-------------------|--------|---------------------|-------------------------------------------|
 * | `evm-tx`          | EVM    | ecdsa-recoverable   | keccak256 of the unsigned serialized tx   |
 * | `evm-191`         | EVM    | ecdsa-recoverable   | EIP-191 personal_sign hash                |
 * | `evm-712`         | EVM    | ecdsa-recoverable   | EIP-712 typed-data hash                   |
 * | `btc-sighash`     | BTC    | ecdsa               | BIP-143 p2wpkh sighash (SIGHASH_ALL)      |
 * | `btc-taproot-keypath` | BTC | schnorr + `tweak`  | BIP-341 p2tr key-path sighash (DEFAULT)   |
 * | `btc-message`     | BTC    | ecdsa-recoverable   | BIP-137 magic hash                        |
 * | `tron-tx`         | Tron   | ecdsa-recoverable   | sha256 of raw_data                        |
 * | `tron-message`    | Tron   | ecdsa-recoverable   | TIP-191 hash                              |
 * | `solana-message`  | Solana | ed25519             | compiled transaction message bytes        |
 * | `solana-offchain` | Solana | ed25519             | off-chain message bytes                   |
 * | `ton-external`    | TON    | ed25519             | hash of the V5R1 signing cell             |
 * | `ton-message`     | TON    | ed25519             | message bytes (ton_proof etc.)            |
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/utils.js'
import { deriveEd25519, deriveSecp256k1 } from './derive.js'
import { SignerError } from './errors.js'
import { zeroize } from './mnemonic.js'

export type SignerCurve = 'secp256k1' | 'ed25519'
export type SignScheme = 'ecdsa-recoverable' | 'ecdsa' | 'schnorr' | 'ed25519'

export interface SignOptions {
  /** Defaults to {@link defaultScheme} for the signer's curve. */
  scheme?: SignScheme
  /** What is being signed (see the table above). Informational for local signers. */
  context?: string
  /** BIP-340 auxiliary randomness (32 bytes) — deterministic tests only; omit for fresh randomness. */
  aux?: Uint8Array
  /**
   * BIP-341 key tweak (32 bytes), `schnorr` only: the signer signs with
   * `(even(priv) + tweak) mod n`, i.e. for the tweaked output key — taproot
   * key-path spends (BIP-86: `tweak = taggedHash('TapTweak', xonlyPub)`).
   * A hardware/MPC signer that tweaks internally may ignore it, but it must
   * still produce a signature valid under the tweaked key.
   */
  tweak?: Uint8Array
}

export interface Signer {
  readonly kind: 'seed' | 'external'
  /** The curve this signer signs with. Chain packages assert the one they need. */
  readonly curve: SignerCurve
  /** Schemes this signer can produce; asking for another throws `SignerError`. */
  readonly schemes: readonly SignScheme[]
  getPublicKey(): Promise<Uint8Array>
  /** Sign an already-hashed or already-serialised payload. Chains decide what the bytes are. */
  sign(payload: Uint8Array, options?: SignOptions): Promise<Uint8Array>
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

/** The scheme a chain gets when it asks for none: recoverable ECDSA on secp256k1, EdDSA on ed25519. */
export function defaultScheme(curve: SignerCurve): SignScheme {
  return curve === 'secp256k1' ? 'ecdsa-recoverable' : 'ed25519'
}

/** Every scheme a local key on `curve` can produce. */
export function schemesFor(curve: SignerCurve): readonly SignScheme[] {
  return curve === 'secp256k1' ? ['ecdsa-recoverable', 'ecdsa', 'schnorr'] : ['ed25519']
}

/** Throws unless `signer` signs on `curve` — chain managers call this before building accounts. */
export function requireCurve(signer: Signer, curve: SignerCurve): Signer {
  if (signer.curve !== curve) throw new SignerError(`This chain needs a ${curve} signer; got ${signer.curve}.`)
  return signer
}

function resolveScheme(signer: Pick<Signer, 'curve' | 'schemes'>, requested: SignScheme | undefined): SignScheme {
  const scheme = requested ?? defaultScheme(signer.curve)
  if (!signer.schemes.includes(scheme)) throw new SignerError(`Signer does not support the '${scheme}' scheme (has: ${signer.schemes.join(', ')}).`)
  return scheme
}

function assert32(payload: Uint8Array, scheme: SignScheme): void {
  if (payload.length !== 32) throw new SignerError(`'${scheme}' signs a 32-byte digest; got ${payload.length} bytes.`)
}

function assertTweak(options: SignOptions, scheme: SignScheme): void {
  if (options.tweak === undefined) return
  if (scheme !== 'schnorr') throw new SignerError(`'tweak' applies to the 'schnorr' scheme only (asked for '${scheme}').`)
  if (options.tweak.length !== 32) throw new SignerError(`'tweak' must be 32 bytes; got ${options.tweak.length}.`)
}

/**
 * BIP-341 private-key tweak: negate `privateKey` when its public key has an odd
 * Y (so the internal key is the even lift of its x-only form), then add `tweak`
 * mod n. Returns a fresh buffer — the caller zeroizes it after signing.
 */
export function tweakSecp256k1PrivateKey(privateKey: Uint8Array, tweak: Uint8Array): Uint8Array {
  const n = secp256k1.Point.CURVE().n
  let d = bytesToNumberBE(privateKey)
  if (d <= 0n || d >= n) throw new SignerError('Invalid secp256k1 private key.')
  const P = secp256k1.Point.BASE.multiply(d)
  if (P.toAffine().y % 2n === 1n) d = n - d
  const t = bytesToNumberBE(tweak)
  if (t >= n) throw new SignerError('Invalid BIP-341 tweak (not below the curve order).')
  const tweaked = (d + t) % n
  if (tweaked === 0n) throw new SignerError('Invalid BIP-341 tweak (zero key).')
  return numberToBytesBE(tweaked, 32)
}

/**
 * Local key signer: the key lives in one `Uint8Array`, zeroized by `dispose()`.
 * Built from a seed (derivable) or from a raw derived key (leaf only).
 */
export class LocalSigner implements SeedSigner {
  readonly kind = 'seed' as const
  readonly curve: SignerCurve
  readonly path: string
  readonly publicKey: Uint8Array
  readonly schemes: readonly SignScheme[]
  private _privateKey: Uint8Array | undefined
  private _seed: Uint8Array | undefined

  private constructor(curve: SignerCurve, privateKey: Uint8Array, publicKey: Uint8Array, path: string, seed?: Uint8Array) {
    this.curve = curve
    this._privateKey = privateKey
    this.publicKey = publicKey
    this.path = path
    this._seed = seed
    this.schemes = schemesFor(curve)
  }

  /** Derive the key at `path` from the 64-byte BIP-39 seed. Keeps a COPY of the seed so it can derive children. */
  static fromSeed(seed: Uint8Array, curve: SignerCurve, path: string): LocalSigner {
    const { privateKey, publicKey } = curve === 'secp256k1' ? deriveSecp256k1(seed, path) : deriveEd25519(seed, path)
    return new LocalSigner(curve, privateKey, publicKey, path, seed.slice())
  }

  /** Wrap an already-derived key. Cannot derive children. Takes ownership of `privateKey` (zeroized on dispose). */
  static fromPrivateKey(curve: SignerCurve, privateKey: Uint8Array, publicKey: Uint8Array, path: string): LocalSigner {
    return new LocalSigner(curve, privateKey, publicKey, path)
  }

  private key(): Uint8Array {
    if (!this._privateKey) throw new SignerError('This signer has been disposed.')
    return this._privateKey
  }

  async getPublicKey(): Promise<Uint8Array> {
    this.key()
    return this.publicKey
  }

  async sign(payload: Uint8Array, options: SignOptions = {}): Promise<Uint8Array> {
    const key = this.key()
    const scheme = resolveScheme(this, options.scheme)
    switch (scheme) {
      case 'ecdsa-recoverable': {
        assert32(payload, scheme)
        assertTweak(options, scheme)
        // noble's 'recovered' format is recovery‖r‖s; the SDK contract is r‖s‖recovery.
        const sig = secp256k1.sign(payload, key, { prehash: false, format: 'recovered' })
        const out = new Uint8Array(65)
        out.set(sig.subarray(1), 0)
        out[64] = sig[0]!
        return out
      }
      case 'ecdsa':
        assert32(payload, scheme)
        assertTweak(options, scheme)
        return secp256k1.sign(payload, key, { prehash: false, format: 'compact', lowS: true })
      case 'schnorr': {
        assert32(payload, scheme)
        assertTweak(options, scheme)
        if (!options.tweak) return options.aux ? schnorr.sign(payload, key, options.aux) : schnorr.sign(payload, key)
        const tweaked = tweakSecp256k1PrivateKey(key, options.tweak)
        try {
          return options.aux ? schnorr.sign(payload, tweaked, options.aux) : schnorr.sign(payload, tweaked)
        } finally {
          zeroize(tweaked)
        }
      }
      case 'ed25519':
        return ed25519.sign(payload, key)
    }
  }

  async derive(relativePath: string): Promise<LocalSigner> {
    this.key()
    if (!this._seed) throw new SignerError('This signer was built from a bare key and cannot derive children.')
    const rel = relativePath.replace(/^\/+/, '')
    return LocalSigner.fromSeed(this._seed, this.curve, rel ? `${this.path}/${rel}` : this.path)
  }

  dispose(): void {
    zeroize(this._privateKey, this._seed)
    this._privateKey = undefined
    this._seed = undefined
  }
}

export interface ExternalSignerOptions {
  curve: SignerCurve
  publicKey: Uint8Array
  /** Schemes the backend can produce. Defaults to the curve's default scheme only. */
  schemes?: readonly SignScheme[]
  /** Called with the resolved scheme (never undefined). Throw `UserRejectedError` when the user declines. */
  sign: (payload: Uint8Array, options: SignOptions & { scheme: SignScheme }) => Promise<Uint8Array>
  dispose?: () => void
}

/**
 * Wrap a signing callback (hardware wallet, Safe, MPC, backend) as a Signer.
 * The SDK validates the scheme against `schemes` and the result length; the
 * callback owns everything else.
 */
export function externalSigner(options: ExternalSignerOptions): Signer {
  const schemes = options.schemes ?? [defaultScheme(options.curve)]
  for (const s of schemes) {
    if (!schemesFor(options.curve).includes(s)) throw new SignerError(`Scheme '${s}' is not available on ${options.curve}.`)
  }
  let disposed = false
  const self: Signer = {
    kind: 'external',
    curve: options.curve,
    schemes,
    async getPublicKey() {
      if (disposed) throw new SignerError('This signer has been disposed.')
      return options.publicKey
    },
    async sign(payload, opts = {}) {
      if (disposed) throw new SignerError('This signer has been disposed.')
      const scheme = resolveScheme(self, opts.scheme)
      if (scheme !== 'ed25519') assert32(payload, scheme)
      assertTweak(opts, scheme)
      const sig = await options.sign(payload, { ...opts, scheme })
      const expected = scheme === 'ecdsa-recoverable' ? 65 : 64
      if (sig.length !== expected) throw new SignerError(`External signer returned ${sig.length} bytes for '${scheme}'; expected ${expected}.`)
      if (scheme === 'ecdsa-recoverable' && sig[64]! > 1) throw new SignerError(`External signer returned recovery id ${sig[64]}; expected 0 or 1.`)
      return sig
    },
    dispose() {
      if (disposed) return
      disposed = true
      options.dispose?.()
    },
  }
  return self
}
