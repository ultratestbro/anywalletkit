/**
 * Human-readable names for addresses — ENS today (`vitalik.eth`, `name.base.eth`,
 * `alice.cb.id`), SNS / TON DNS / NEAR accounts on the same interface later.
 *
 * A resolver turns a name into the address for ONE chain (CAIP-2) and never
 * falls back to another chain's address: a name without a Base address is an
 * error, not vitalik's mainnet address sent to Base. Reverse lookups count only
 * when the name resolves forward to the same address. Every resolution carries
 * the warnings a wallet should show next to the name (mixed scripts, lookalike
 * letters, punycode).
 */

/** Why a name lookup failed. Each code maps to one message a wallet can show. */
export type NameErrorCode =
  /** Not a valid name for this resolver (normalization failed, bad labels). */
  | 'invalid-name'
  /** No such name (unregistered, expired, no resolver). */
  | 'not-found'
  /** The name exists but records no address for the requested chain. */
  | 'no-address-for-chain'
  /** This resolver does not serve the chain / name shape. */
  | 'unsupported'
  /** The lookup itself failed (RPC, gateway); the name may well exist. */
  | 'lookup-failed'
  /** Re-resolution right before signing returned a different address. */
  | 'changed'

/** Thrown by name resolvers with a machine-readable {@link NameErrorCode}. */
export class NameError extends Error {
  override readonly name = 'NameError'
  constructor(
    readonly code: NameErrorCode,
    message: string,
    readonly detail: { name?: string; chain?: string; cause?: unknown } = {},
  ) {
    super(message)
  }
}

/** Something about a name the user should see before sending to it. */
export interface NameWarning {
  /**
   * `mixed-script`: letters from several scripts; `confusable`: letters that look like others
   * (Cyrillic а for Latin a); `punycode`: an `xn--` label.
   */
  code: 'mixed-script' | 'confusable' | 'punycode'
  /** The label the warning is about. */
  label: string
  /** One sentence a wallet can show as-is. */
  message: string
}

/** A name resolved for one chain, with the warnings to show next to it. */
export interface ResolvedName {
  /** The normalized name that was resolved. */
  name: string
  /** CAIP-2 chain the address is for. */
  chain: string
  /** The address, in the chain's canonical form (checksummed for EVM). */
  address: string
  /** Which resolver answered (`ens`, `sns`, …). */
  resolver: string
  /** Warnings to show; empty when none. */
  warnings: NameWarning[]
}

/**
 * Turns names into addresses for one chain and back. `names-ens` implements it; {@link
 * nameResolvers} combines several.
 */
export interface NameResolver {
  /** Resolver id, e.g. `ens`. */
  readonly id: string
  /** Cheap shape check: does this resolver serve names like this one? No I/O. */
  supports(name: string): boolean
  /** Name → address for `chain`. Throws `NameError`; never falls back to another chain's record. */
  resolve(name: string, chain: string): Promise<ResolvedName>
  /** Address → primary name, verified by forward resolution; `null` when there is none or it does not match. */
  reverse(address: string, chain: string): Promise<string | null>
  /** Avatar URL (https / ipfs / resolved NFT image) or `null`. Wallets should fetch it through their own proxy. */
  avatar(name: string): Promise<string | null>
}

/** Does the input look like a name rather than an address: two or more labels, no whitespace, not hex. */
export function isNameLike(input: string): boolean {
  const s = input.trim()
  if (!s || /\s/.test(s) || /^0x[0-9a-fA-F]*$/.test(s)) return false
  const labels = s.split('.')
  return labels.length >= 2 && labels.every((l) => l.length > 0)
}

/**
 * Several resolvers behind one: the first whose `supports(name)` is true answers.
 * Order them specific → generic (SNS `.sol`, TON `.ton` before ENS, which also
 * serves DNS names).
 */
export function nameResolvers(resolvers: readonly NameResolver[]): NameResolver {
  const pick = (name: string) => resolvers.find((r) => r.supports(name))
  return {
    id: 'registry',
    supports: (name) => pick(name) !== undefined,
    async resolve(name, chain) {
      const r = pick(name)
      if (!r) throw new NameError('unsupported', `No resolver serves ${name}`, { name, chain })
      return r.resolve(name, chain)
    },
    async reverse(address, chain) {
      for (const r of resolvers) {
        const found = await r.reverse(address, chain).catch(() => null)
        if (found) return found
      }
      return null
    },
    async avatar(name) {
      const r = pick(name)
      return r ? r.avatar(name) : null
    },
  }
}

/**
 * The signing-time check: resolve again and refuse when the address moved.
 * Returns the fresh resolution so the wallet can show it.
 */
export async function assertNameUnchanged(resolver: NameResolver, name: string, chain: string, expected: string): Promise<ResolvedName> {
  const fresh = await resolver.resolve(name, chain)
  // EVM hex is case-insensitive (the checksum is only casing); base58 / base32 / bech32 forms of other chains are compared exactly.
  const same = chain.startsWith('eip155:') ? fresh.address.toLowerCase() === expected.toLowerCase() : fresh.address === expected
  if (!same) {
    throw new NameError('changed', `${name} now resolves to ${fresh.address}, not ${expected} — refusing to sign`, { name, chain })
  }
  return fresh
}
