/**
 * One network, several spellings: the wallet packages report genesis-hash CAIP-2 ids
 * (`solana:5eykt…`, `tron:0x2b6653dc`, `bip122:0000…`), apps and catalogs often use the short ones
 * (`solana:mainnet`, `tron:728126428`, `bitcoin:mainnet`). Short id → the id accounts report.
 */
const SHORT_IDS: Readonly<Record<string, string>> = Object.freeze({
  'solana:mainnet': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana:devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  'solana:testnet': 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
  'tron:mainnet': 'tron:0x2b6653dc',
  'tron:shasta': 'tron:0x94a9059e',
  'tron:nile': 'tron:0xcd8690dc',
  'ton:mainnet': 'ton:-239',
  'ton:testnet': 'ton:-3',
  'bitcoin:mainnet': 'bip122:000000000019d6689c085ae165831e93',
  'bitcoin:testnet': 'bip122:000000000933ea01ad0ee984209779ba',
  'bitcoin:regtest': 'bip122:0f9188f13cb7b2c71f2a335e3a4fc328',
})

/** Namespaces catalogs spell differently from the accounts: `bitcoin` (catalog ids) is `bip122`. */
const NAMESPACE_ALIASES: Readonly<Record<string, string>> = Object.freeze({ bitcoin: 'bip122' })

/** The namespace accounts report for `ns` (`bitcoin` → `bip122`). */
export function canonicalNamespace(ns: string): string {
  return NAMESPACE_ALIASES[ns] ?? ns
}

/** The id an account of this network reports (Tron and EVM references in one numeric form). */
function canonicalChainId(chain: string): string {
  const id = SHORT_IDS[chain] ?? SHORT_IDS[chain.toLowerCase()] ?? chain
  const i = id.indexOf(':')
  if (i < 0) return canonicalNamespace(id)
  const ns = canonicalNamespace(id.slice(0, i))
  const ref = id.slice(i + 1)
  if (ns === 'eip155' && /^(\d{1,30}|0x[0-9a-f]{1,30})$/i.test(ref)) return `eip155:${BigInt(ref)}`
  if (ns === 'tron' && /^\d{1,30}$/.test(ref)) return `tron:0x${BigInt(ref).toString(16).padStart(8, '0')}`
  if (ns === 'tron' && /^0x[0-9a-f]{1,30}$/i.test(ref)) return `tron:0x${BigInt(ref).toString(16).padStart(8, '0')}`
  return `${ns}:${ref}`
}

/** Do two CAIP-2 ids name the same network (`solana:mainnet` = `solana:5eykt…`, `tron:728126428` = `tron:0x2b6653dc`)? */
export function sameChain(a: string, b: string): boolean {
  return canonicalChainId(a) === canonicalChainId(b)
}

/**
 * Does the policy key `key` cover `chain`? A bare namespace (`eip155`, `bitcoin`) covers every
 * network of its family; a full id covers its network in any spelling (`solana:mainnet` covers
 * `solana:5eykt…`, `tron:728126428` covers `tron:0x2b6653dc`).
 */
export function ruleCovers(key: string, chain: string): boolean {
  if (!key.includes(':')) return canonicalNamespace(key) === canonicalNamespace(chain.split(':')[0]!)
  return chain.includes(':') && sameChain(key, chain)
}

/** Is `chain` a full CAIP-2 id with a known reference (not a bare namespace, not `…:unknown`)? */
export function isConcreteChain(chain: string | undefined): chain is string {
  return chain !== undefined && chain.includes(':') && !chain.endsWith(':unknown')
}
