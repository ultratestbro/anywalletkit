import { isAddress } from './address.js'

/** A validator the module may delegate to. */
export interface ValidatorConfig {
  /** The validator's vote account: what a stake account delegates to. */
  voteAccount: string
  /** Display name (falls back to `enrich`, then to the address). */
  name?: string
}

/**
 * Which validators the module delegates to. A list of vote accounts (or `{ voteAccount, name }`), or
 * `'any'` for a wallet that lets its users pick from the whole cluster. There is no default: a module
 * without this choice refuses to construct.
 */
export type ValidatorsOption = ReadonlyArray<string | ValidatorConfig> | 'any'

/** Extra data an app attaches to validators (an explorer's APY with MEV, a score, a logo). */
export interface ValidatorExtra {
  /** APR in percent (6.9 = 6.9 %); replaces the module's inflation-only estimate. */
  apr?: number
  name?: string
  [key: string]: unknown
}

/** Supplies {@link ValidatorExtra} per vote account, e.g. from Stakewiz or the app's backend. Called with the vote accounts a read needs. */
export type ValidatorEnricher = (voteAccounts: string[]) => Promise<Record<string, ValidatorExtra>> | Record<string, ValidatorExtra>

/** Why a validator cannot take new stake right now. */
export type ValidatorRefusal = 'not-listed' | 'not-found' | 'delinquent' | 'commission-above-max'

/** A validator as the chain reports it, with the module's verdict. */
export interface ValidatorInfo {
  voteAccount: string
  /** Identity (node) key. */
  nodePubkey: string | null
  name: string | null
  /** Inflation-reward commission, percent. */
  commission: number
  /** Stake active on the validator, lamports. */
  activatedStake: bigint
  /** Has not voted recently (the cluster stops paying rewards to its stake). */
  delinquent: boolean
  /** Last slot it voted on. */
  lastVote: bigint
  /** Vote credits earned in the latest epoch the node reports. */
  epochCredits: bigint | null
  /** In the configured list (always true in `'any'` mode for validators the cluster knows). */
  listed: boolean
  /** Can take new stake: listed, found, not delinquent, commission within `maxCommission`. */
  eligible: boolean
  /** Why it is not eligible (empty when it is). */
  refusals: ValidatorRefusal[]
  /** APR in percent: the `enrich` hook's figure when given, else the module's inflation estimate after commission. */
  apr: number | null
  /** Where `apr` came from. */
  aprSource: 'enrich' | 'estimate' | null
  /** Whatever `enrich` returned for it. */
  extra?: ValidatorExtra
}

/** Normalizes and validates the `validators` option. */
export function normalizeValidators(option: ValidatorsOption | undefined): ValidatorConfig[] | 'any' {
  if (option === 'any') return 'any'
  if (!Array.isArray(option) || option.length === 0) {
    throw new Error("NativeStakingProtocolSolana needs `validators`: the vote accounts it may delegate to (or 'any' to let users pick from the whole cluster).")
  }
  const seen = new Set<string>()
  const out: ValidatorConfig[] = []
  for (const v of option as ReadonlyArray<string | ValidatorConfig>) {
    const c: ValidatorConfig = typeof v === 'string' ? { voteAccount: v } : { ...v }
    if (!isAddress(c.voteAccount)) throw new Error(`validators: '${String(c.voteAccount)}' is not a vote account address.`)
    if (seen.has(c.voteAccount)) continue
    seen.add(c.voteAccount)
    out.push(c)
  }
  return out
}

/** One row of `getVoteAccounts`. */
export interface VoteAccountRow {
  votePubkey: string
  nodePubkey: string
  activatedStake: unknown
  commission: unknown
  lastVote: unknown
  epochCredits?: unknown[]
}
