import { toValidatorId } from './encode.js'

/** A validator the module may delegate to. */
export interface ValidatorConfig {
  /** The validator id on the staking precompile. */
  id: bigint | number
  /** Display name. */
  name?: string
}

/**
 * Which validators the module delegates to: a list of ids (or `{ id, name }`), or `'any'` for a wallet
 * that lets its users pick from the whole active set. There is no default: without it the module
 * refuses to construct.
 */
export type ValidatorsOption = 'any' | ReadonlyArray<bigint | number | ValidatorConfig>

/** Extra data an app attaches to validators (an explorer's APY, a name, a logo). */
export interface ValidatorExtra {
  /** APR in percent; replaces the module's estimate. */
  apr?: number
  name?: string
  [key: string]: unknown
}

/** Supplies {@link ValidatorExtra} per validator id (keys are decimal strings). */
export type ValidatorEnricher = (ids: bigint[]) => Promise<Record<string, ValidatorExtra>> | Record<string, ValidatorExtra>

/** Why a validator cannot take new stake right now. */
export type ValidatorRefusal = 'not-listed' | 'not-found' | 'inactive' | 'commission-above-max'

/** A validator as the precompile reports it, with the module's verdict. Amounts in wei. */
export interface ValidatorInfo {
  id: bigint
  name: string | null
  /** The validator's own delegator account (zero address when the id does not exist). */
  authAddress: string
  /** Precompile status flags; 0 = in good standing. */
  flags: bigint
  /** Execution view: the stake the next snapshot will see. */
  stake: bigint
  /** Stake in the current consensus set (0 when not producing blocks this epoch). */
  consensusStake: bigint
  /** Commission now in force (consensus view), percent. */
  consensusCommission: number
  /** Commission set for the coming epochs (execution view), percent. */
  commission: number
  /** In the consensus set this epoch and in good standing. */
  active: boolean
  listed: boolean
  /** Can take new stake: listed, exists, active (unless allowInactive), commission within maxCommission. */
  eligible: boolean
  refusals: ValidatorRefusal[]
  /** APR in percent: `enrich`'s when given, else the network estimate after commission. */
  apr: number | null
  aprSource: 'enrich' | 'estimate' | null
  extra?: ValidatorExtra
}

/** Normalized `validators` option. */
export type NormalizedValidators = 'any' | Array<{ id: bigint; name?: string }>

/** Validates the `validators` option: required, ids valid, duplicates dropped. */
export function normalizeValidators(option: ValidatorsOption | undefined): NormalizedValidators {
  if (option === 'any') return 'any'
  if (!Array.isArray(option) || option.length === 0) {
    throw new Error("NativeStakingProtocolMonad needs `validators`: the validator ids it may delegate to (or 'any' to let users pick from the active set).")
  }
  const seen = new Set<bigint>()
  const out: Array<{ id: bigint; name?: string }> = []
  for (const v of option as ReadonlyArray<bigint | number | ValidatorConfig>) {
    const raw = typeof v === 'object' && v !== null ? v : { id: v }
    const id = toValidatorId(raw.id, 'validators')
    if (seen.has(id)) continue
    seen.add(id)
    out.push(typeof raw.name === 'string' ? { id, name: raw.name } : { id })
  }
  return out
}
