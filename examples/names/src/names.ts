// The "Names" guide on docs.anywallet.tech renders the #region blocks of this file.

// #region imports
import { NameError, assertNameUnchanged, isNameLike, nameResolvers, type NameResolver, type ResolvedName } from '@anywalletkit/core'
import { ensResolver } from '@anywalletkit/names-ens'
// #endregion imports

// #region setup
export function names(): NameResolver {
  return nameResolvers([
    // More specific resolvers (.sol, .ton) go before ENS when they exist: ENS also serves DNS names.
    ensResolver({
      rpcUrl: 'https://ethereum-rpc.publicnode.com', // always Ethereum mainnet, whatever chain you send on
      cacheTtlMs: 5 * 60_000,
      ipfsGateway: 'https://ipfs.io/ipfs/', // point at your own proxy in production
    }),
  ])
}
// #endregion setup

// #region recipient
export type Recipient =
  | { kind: 'address'; address: string }
  | { kind: 'name'; resolved: ResolvedName }
  | { kind: 'error'; message: string }

/** The recipient field: an address passes through, a name is resolved for THIS chain. */
export async function readRecipient(resolver: NameResolver, input: string, chain: string): Promise<Recipient> {
  const text = input.trim()
  // On NEAR, `alice.near` IS the account address; elsewhere a dotted string is never an address.
  if (!isNameLike(text) || chain.startsWith('near:')) return { kind: 'address', address: text } // validate it as an address next
  // Not served: an invalid name, a lookalike-letter mixture (`vitаlik.eth` with a Cyrillic "а"), or a TLD with no resolver yet.
  if (!resolver.supports(text)) return { kind: 'error', message: 'This name is not valid, or names like it are not supported yet.' }
  try {
    return { kind: 'name', resolved: await resolver.resolve(text, chain) }
  } catch (e) {
    if (!(e instanceof NameError)) throw e
    const messages: Record<string, string> = {
      'invalid-name': 'This is not a valid name.',
      'not-found': 'No one owns this name.',
      'no-address-for-chain': 'This name has no address for this network.', // never send to its Ethereum address instead
      unsupported: 'Names like this are not supported yet.',
      'lookup-failed': 'Could not look the name up. Try again.',
    }
    return { kind: 'error', message: messages[e.code] ?? e.message }
  }
}
// #endregion recipient

// #region review
/** The review screen shows the address the name resolved to, and every warning. */
export function reviewLines(resolved: ResolvedName): string[] {
  return [`${resolved.name} → ${resolved.address}`, ...resolved.warnings.map((w) => `⚠ ${w.message}`)]
}

/** Right before signing: resolve again; refuse if the name now points elsewhere. */
export async function beforeSigning(resolver: NameResolver, resolved: ResolvedName): Promise<void> {
  await assertNameUnchanged(resolver, resolved.name, resolved.chain, resolved.address) // throws NameError 'changed'
}
// #endregion review

// #region profile
/** The account header: the verified primary name and its avatar URL, if any. */
export async function profile(resolver: NameResolver, address: string, chain: string) {
  const name = await resolver.reverse(address, chain) // counts only if it resolves back to this address
  const avatar = name ? await resolver.avatar(name) : null // a URL: fetch it through your proxy
  return { name, avatar }
}
// #endregion profile
