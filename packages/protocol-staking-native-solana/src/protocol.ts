import {
  StakingProtocol, bigintToNumber,
  type ActivityItem, type ChainTx, type ClaimWithdrawalsOptions, type DescribeActivityContext, type IWalletAccount, type IWalletAccountReadOnly,
  type StakedBalance, type StakeOptions, type WithdrawalRequest, type WithdrawalRequestOptions, type WithdrawalRequestsView,
} from '@anywalletkit/core'
import { activationStatus, settlesAt, statusOf, type StakeHistory, type StakeStatus } from './activation.js'
import { describeNativeStakeActivity } from './activity.js'
import { base58Decode, createWithSeed, isAddress } from './address.js'
import {
  decodeStakeAccount, decodeStakeHistory, ixAllocateWithSeed, ixCreateAccountWithSeed, ixDeactivate, ixDelegate, ixInitialize, ixMerge, ixSetComputeUnitLimit,
  ixSetComputeUnitPrice, ixSplit, ixTransfer, ixWithdraw, lockupInForce, type Instruction, type StakeAccountData, type StakeAccountKind,
} from './codec.js'
import { MAX_SEED_LENGTH, RATE_CHANGE_EPOCH, STAKE_ACCOUNT_SPACE, STAKE_PROGRAM, SYSTEM_PROGRAM, SYSVAR_STAKE_HISTORY, U64_MAX } from './constants.js'
import { RpcClient, big, fromBase64, type SolanaRpcSource } from './rpc.js'
import {
  normalizeValidators, type ValidatorConfig, type ValidatorEnricher, type ValidatorExtra, type ValidatorInfo, type ValidatorRefusal,
  type ValidatorsOption, type VoteAccountRow,
} from './validators.js'

/** Default seed prefix: stake accounts live at `create_with_seed(wallet, "stake:<i>", Stake program)`. */
export const DEFAULT_SEED_PREFIX = 'stake:'
/** Seed slots scanned per wallet (one `getMultipleAccounts`). */
export const DEFAULT_MAX_ACCOUNTS = 32
/** Lamports a stake leaves on the wallet for the fees of later transactions (unstake, claim): 0.005 SOL. */
export const DEFAULT_FEE_RESERVE = 5_000_000n
/** Highest validator commission (percent) the module delegates to unless configured otherwise. */
export const DEFAULT_MAX_COMMISSION = 10
/** Slot time used to project epoch boundaries. */
export const SLOT_MS = 400
/** How long the stake parameters and the inflation figures are reused, ms. */
const CACHE_MS = 10 * 60_000
/** Addresses per `getInflationReward` call (the RPC's limit). */
const REWARD_BATCH = 32
/** Withdrawals per claim transaction (keeps it well under the 1232-byte limit). */
export const MAX_CLAIMS_PER_TX = 10
/** Deactivations per unstake transaction. */
export const MAX_DEACTIVATIONS_PER_TX = 10

/** Configuration of {@link NativeStakingProtocolSolana}. Only `validators` is required. */
export interface NativeStakingConfig {
  /** The validators to delegate to (vote accounts), or `'any'`. Required: there is no default list. */
  validators: ValidatorsOption
  /** Vote account `stake` uses when the call names none. Without it: the first eligible validator of the list (no default in `'any'` mode). */
  defaultValidator?: string
  /** Refuse to delegate to a validator whose commission is above this, percent (default 10). Checked live at every delegation. */
  maxCommission?: number
  /** Allow delegating to a delinquent validator (default false: its stake earns nothing). */
  allowDelinquent?: boolean
  /** Where reads go: a URL, a list (tried in order), a `@solana/rpc` client or `{ request(method, params) }`. Defaults to the account's own RPC. */
  provider?: SolanaRpcSource | SolanaRpcSource[]
  /** Read commitment (default `confirmed`). */
  commitment?: 'processed' | 'confirmed' | 'finalized'
  /** Per-request timeout for reads through a URL or a @solana/rpc client, ms (default 15 000). A `{ request }` provider keeps its own. */
  timeoutMs?: number
  /** `fetch` for URL providers (default the global one). */
  fetch?: typeof fetch
  /** Seed prefix of the wallet's stake accounts (default `stake:`). Changing it hides accounts made under the old prefix unless `discover` is on. */
  seedPrefix?: string
  /** Seed slots scanned (default 32, at most 100). */
  maxAccounts?: number
  /** Also find stake accounts other wallets created for this address (`getProgramAccounts` by staker and withdrawer). Needs an RPC that serves it. Default false. */
  discover?: boolean
  /** Lamports `stake` leaves on the wallet for later fees (default 0.005 SOL). */
  feeReserve?: bigint | number
  /** Explicit compute-unit limit. Without it the wallet sets one from simulation. */
  computeUnitLimit?: number
  /** Explicit priority fee, micro-lamports per unit. Without it the wallet picks one from recent fees. */
  computeUnitPrice?: bigint | number
  /** Adds data to validators (APR with MEV, names, scores) from an explorer or the app's backend. */
  enrich?: ValidatorEnricher
}

/** One of the wallet's stake accounts. Amounts in lamports. */
export interface StakeAccountInfo {
  address: string
  /** Stable id for `claimWithdrawals({ ids })`: the address's first 8 bytes as a u64. */
  id: bigint
  /** Seed and slot index for the module's own accounts; null for discovered ones. */
  seed: string | null
  seedIndex: number | null
  kind: Extract<StakeAccountKind, 'initialized' | 'delegated'>
  lamports: bigint
  /** Vote account it is delegated to (null when never delegated). */
  validator: string | null
  validatorName: string | null
  /** The validator is in the configured list (true in `'any'` mode). */
  validatorListed: boolean
  /** `delegation.stake` while delegated or cooling down: principal plus compounded rewards. 0 once inactive (the field goes stale). */
  delegated: bigint
  effective: bigint
  activating: bigint
  deactivating: bigint
  status: StakeStatus
  activationEpoch: bigint | null
  deactivationEpoch: bigint | null
  /** What a withdraw could take now; equals `lamports` once fully inactive (the account closes). */
  withdrawable: bigint
  /** Epoch at which the current warm-up or cool-down completes (null when settled). */
  readyEpoch: bigint | null
  /** Projected unix ms of `readyEpoch`'s start. */
  readyAt: number | null
  staker: string | null
  withdrawer: string | null
  /**
   * The wallet is the withdraw authority: the SOL is the wallet's. Accounts `discover` finds where the
   * wallet is only the stake authority are listed with `owned: false` and left out of the position
   * and of every write.
   */
  owned: boolean
  /** The wallet is the stake authority (may delegate, deactivate, split, merge). */
  canManage: boolean
  /** The wallet is the withdraw authority and no lockup is in force. */
  canWithdraw: boolean
  /** Lockup still in force, if any. */
  lockup: { epoch: bigint; unixTimestamp: bigint; custodian: string } | null
}

/** The epoch clock. */
export interface EpochClock { epoch: bigint; slotIndex: number; slotsInEpoch: number; progress: number; endsAt: number }

export interface NativeStakeOptions extends StakeOptions {
  /** Vote account to delegate to; must be listed and eligible. */
  validator?: string
}
export interface NativeStakeQuote {
  fee: bigint
  /** Lamports delegated. */
  amount: bigint
  /** Rent the new stake account holds (returned on withdraw). */
  rentExempt: bigint
  /** What leaves the wallet besides the fee: amount + rent. */
  total: bigint
  stakeAccount: string
  seed: string
  validator: ValidatorInfo
  /** Epoch the stake becomes active (projection). */
  readyEpoch: bigint
}
export interface NativeStakeResult extends NativeStakeQuote { hash: string }

export interface NativeUnstakeOptions extends WithdrawalRequestOptions {
  /** Unstake from this stake account only. */
  account?: string
  /** Unstake only stake delegated to this vote account. */
  validator?: string
}
/** One step of an unstake: deactivate a whole account, or split part of it into a new account and deactivate that. */
export interface UnstakeStep { kind: 'deactivate' | 'split'; account: string; amount: bigint; splitInto?: string }
export interface NativeUnstakeQuote {
  fee: bigint
  amount: bigint
  steps: UnstakeStep[]
  /** Epoch from which the unstaked SOL can be claimed (projection; the current one when it is immediate; null when the cluster is moving so much stake that it cannot be projected). */
  readyEpoch: bigint | null
  readyAt: number | null
}
export interface NativeUnstakeResult extends NativeUnstakeQuote { hash: string; approveHash: null }

export interface NativeClaimOptions extends ClaimWithdrawalsOptions {
  /** Stake accounts to withdraw from, by address (alternative to `ids`). */
  accounts?: string[]
}
export interface NativeClaimQuote {
  fee: bigint
  /** Lamports that return to the wallet. */
  amount: bigint
  accounts: string[]
  /** Requested (or, without ids, claimable) accounts left for another call: one transaction takes at most {@link MAX_CLAIMS_PER_TX}. */
  remaining: number
}
export interface NativeClaimResult extends NativeClaimQuote { hash: string }

export interface DelegateOptions {
  /** The stake account. */
  account: string
  /** Vote account; defaults like `stake`. For `reactivate` it must be the current one (or omitted). */
  validator?: string
}
export interface DelegateQuote {
  fee: bigint
  account: string
  validator: string
  /** `delegate`: an inactive account starts warming up; `reactivate`: undoes a deactivation made this epoch. */
  mode: 'delegate' | 'reactivate'
}
export interface DelegateResult extends DelegateQuote { hash: string }

export interface MergeOptions {
  /** Account that receives everything. */
  destination: string
  /** Account that is drained and closed. */
  source: string
}
export interface MergeQuote { fee: bigint; destination: string; source: string }
export interface MergeResult extends MergeQuote { hash: string }

/** A withdrawal request as this module reports it: one stake account that is cooling down or ready. */
export interface NativeWithdrawalRequest extends WithdrawalRequest {
  address: string
  status: StakeStatus
  readyEpoch: bigint | null
  readyAt: number | null
}

/** {@link WithdrawalRequestsView} with this module's request rows. */
export type NativeWithdrawalRequestsView = Omit<WithdrawalRequestsView, 'requests'> & { requests: NativeWithdrawalRequest[] }

/** Rewards the stake accounts earned per epoch. */
export interface NativeRewards {
  /** Sum over the epochs that answered, lamports. */
  total: bigint
  epochs: Array<{ epoch: bigint; amount: bigint; accounts: Array<{ address: string; amount: bigint; postBalance: bigint; commission: number | null }> } | { epoch: bigint; error: string }>
}

interface ChainState {
  clock: EpochClock
  history: StakeHistory
  rentExempt: bigint
  minimumDelegation: bigint
}

interface RawAccount { lamports: unknown; owner: string; data: [string, string] | string[] }
/** A seed slot a new stake account can go to: empty, or a System account someone already funded (`existing` lamports). */
interface FreeSlot { index: number; address: string; existing: bigint | null }

const lamportsText = (v: bigint): string => {
  const whole = v / 1_000_000_000n
  const frac = (v % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '')
  return `${whole}${frac ? `.${frac}` : ''} SOL`
}

function toLamports(amount: unknown, what = 'amount'): bigint {
  if (typeof amount !== 'bigint' && !(typeof amount === 'number' && Number.isSafeInteger(amount))) {
    throw new Error(`'${what}' must be a bigint or a safe integer (lamports).`)
  }
  const v = BigInt(amount)
  if (v <= 0n) throw new Error(`'${what}' must be greater than zero.`)
  return v
}

const num = (v: unknown): number => (typeof v === 'bigint' ? bigintToNumber(v) : Number(v))
const max0 = (v: bigint): bigint => (v > 0n ? v : 0n)

const SYSTEM_ALLOCATE_WITH_SEED = 9
/**
 * A wallet that refuses to sign `AllocateWithSeed` (wallet-solana does by default: the base signs for
 * an account it controls) cannot take over a pre-funded slot. Say so instead of passing on a bare
 * guard refusal. Any other error goes through unchanged.
 */
function explainTakeover(e: unknown, instructions: readonly Instruction[], maxAccounts: number): unknown {
  const takeover = instructions.some((ix) => ix.programAddress === SYSTEM_PROGRAM && ix.data.length >= 4
    && new DataView(ix.data.buffer, ix.data.byteOffset, 4).getUint32(0, true) === SYSTEM_ALLOCATE_WITH_SEED)
  if (!takeover || !/AllocateWithSeed/.test(e instanceof Error ? e.message : String(e))) return e
  return Object.assign(new Error(
    `No empty stake-account slot is left: the free ones (of ${maxAccounts}) hold SOL someone sent there, and taking one over needs `
    + 'AllocateWithSeed, which this wallet refuses to sign. Raise maxAccounts for new slots, claim or merge accounts to free some, '
    + 'or allow the wallet to sign it (wallet-solana: allowAuthorityChanges).',
  ), { cause: e })
}

/** Stable u64 id of an account: its first 8 address bytes, big-endian. */
export function accountId(address: string): bigint {
  let id = 0n
  for (const b of base58Decode(address).subarray(0, 8)) id = (id << 8n) | BigInt(b)
  return id
}

/**
 * Native staking on Solana: SOL delegated straight to validators the app chooses, through the Stake
 * program. No pool, no token, no third-party program: each position is a stake account owned by the
 * wallet (staker and withdrawer are always the wallet's address).
 *
 * - `stake` creates a stake account at a seed-derived address (`create_with_seed(wallet, "stake:<i>")`,
 *   so only the wallet signs and the position can be rebuilt from the wallet alone), initializes it
 *   and delegates it, in one transaction. It becomes active at the next epoch boundary (~2 days).
 * - `requestWithdrawal` deactivates whole accounts and, for a partial amount, splits it into a new
 *   account first. The SOL can be withdrawn once the cool-down ends (next epoch boundary).
 * - `claimWithdrawals` withdraws every lamport of fully inactive accounts back to the wallet.
 * - `delegate` re-delegates an inactive account, or undoes a deactivation made in the same epoch;
 *   `merge` joins two compatible accounts.
 *
 * Fail-closed before anything is signed: the validator must be in the configured list (or the app
 * chose `'any'`), voting, and within `maxCommission`; amounts respect the minimum delegation and the
 * rent; the wallet keeps `feeReserve` for later fees. Statuses (activating / active / deactivating /
 * inactive) are computed from the StakeHistory sysvar exactly as the program does.
 */
export class NativeStakingProtocolSolana extends StakingProtocol<NativeStakingConfig> {
  /** The configured validators, or `'any'`. */
  readonly validators: ReadonlyArray<ValidatorConfig> | 'any'
  readonly defaultValidator: string | undefined
  readonly maxCommission: number
  readonly seedPrefix: string
  readonly maxAccounts: number
  readonly feeReserve: bigint
  private readonly rpc: RpcClient
  private readonly commitment: 'processed' | 'confirmed' | 'finalized'
  private paramsCache: { at: number; value: Promise<{ rentExempt: bigint; minimumDelegation: bigint }> } | undefined
  private historyCache: { epoch: bigint; value: Promise<StakeHistory> } | undefined
  private inflationCache: { at: number; value: Promise<{ validator: number; supply: number }> } | undefined

  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: NativeStakingConfig) {
    super(account, config)
    if (!config || typeof config !== 'object') throw new Error('NativeStakingProtocolSolana needs a config with `validators`.')
    this.validators = normalizeValidators(config.validators)

    if (config.defaultValidator !== undefined) {
      if (!isAddress(config.defaultValidator)) throw new Error(`defaultValidator '${String(config.defaultValidator)}' is not a vote account address.`)
      if (this.validators !== 'any' && !this.validators.some((v) => v.voteAccount === config.defaultValidator)) {
        throw new Error('defaultValidator must be one of `validators`.')
      }
    }
    this.defaultValidator = config.defaultValidator

    const maxCommission = config.maxCommission ?? DEFAULT_MAX_COMMISSION
    if (typeof maxCommission !== 'number' || !(maxCommission >= 0 && maxCommission <= 100)) throw new Error('maxCommission must be a percentage between 0 and 100.')
    this.maxCommission = maxCommission

    this.seedPrefix = config.seedPrefix ?? DEFAULT_SEED_PREFIX
    this.maxAccounts = config.maxAccounts ?? DEFAULT_MAX_ACCOUNTS
    if (!Number.isInteger(this.maxAccounts) || this.maxAccounts < 1 || this.maxAccounts > 100) throw new Error('maxAccounts must be an integer from 1 to 100.')
    if (new TextEncoder().encode(`${this.seedPrefix}${this.maxAccounts - 1}`).length > MAX_SEED_LENGTH) throw new Error(`seedPrefix is too long: seeds are at most ${MAX_SEED_LENGTH} bytes.`)

    this.feeReserve = BigInt(config.feeReserve ?? DEFAULT_FEE_RESERVE)
    if (this.feeReserve < 0n) throw new Error('feeReserve must not be negative.')

    const own = account as unknown as { _rpc?: unknown; _config?: { provider?: unknown } }
    const source = config.provider ?? own._rpc ?? own._config?.provider
    const sources = (Array.isArray(source) ? source : source !== undefined && source !== null ? [source] : []) as SolanaRpcSource[]
    this.rpc = new RpcClient(sources, { ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}), ...(config.fetch ? { fetch: config.fetch } : {}) })
    this.commitment = config.commitment ?? 'confirmed'
  }

  // ── Chain reads ──────────────────────────────────────────────────────────────

  private requireSolana(): void {
    if (!String(this._account.chain ?? '').startsWith('solana:')) throw new Error(`NativeStakingProtocolSolana needs a Solana account, got ${this._account.chain}.`)
  }

  private async wallet(): Promise<string> {
    this.requireSolana()
    return await this._account.getAddress()
  }

  /** The epoch clock, with a projected end of the current epoch. */
  async getEpochInfo(): Promise<EpochClock> {
    const e = await this.rpc.call<Record<string, unknown>>('getEpochInfo', [{ commitment: this.commitment }])
    const slotIndex = num(e.slotIndex)
    const slotsInEpoch = num(e.slotsInEpoch)
    return { epoch: big(e.epoch), slotIndex, slotsInEpoch, progress: slotsInEpoch > 0 ? slotIndex / slotsInEpoch : 0, endsAt: Date.now() + Math.max(0, slotsInEpoch - slotIndex) * SLOT_MS }
  }

  /** Rent of a stake account and the minimum delegation, lamports (cached for 10 minutes). */
  async getStakeParams(): Promise<{ rentExempt: bigint; minimumDelegation: bigint }> {
    if (!this.paramsCache || Date.now() - this.paramsCache.at > CACHE_MS) {
      const value = Promise.all([
        this.rpc.call('getMinimumBalanceForRentExemption', [STAKE_ACCOUNT_SPACE, { commitment: this.commitment }]),
        this.rpc.call<{ value: unknown }>('getStakeMinimumDelegation', [{ commitment: this.commitment }]),
      ]).then(([rent, min]) => ({ rentExempt: big(rent), minimumDelegation: big(min.value) }))
      this.paramsCache = { at: Date.now(), value }
      value.catch(() => { if (this.paramsCache?.value === value) this.paramsCache = undefined })
    }
    return await this.paramsCache.value
  }

  /** The StakeHistory sysvar (cached per epoch: it changes only at the boundary). */
  private async stakeHistory(epoch: bigint): Promise<StakeHistory> {
    if (!this.historyCache || this.historyCache.epoch !== epoch) {
      const value = this.rpc.call<{ value: RawAccount | null }>('getAccountInfo', [SYSVAR_STAKE_HISTORY, { encoding: 'base64', commitment: this.commitment }]).then((r) => {
        if (!r.value) throw new Error('StakeHistory sysvar not found.')
        const history = decodeStakeHistory(fromBase64(r.value.data[0]!)) as StakeHistory
        // A load-balanced RPC can answer the epoch from a fresh node and the sysvar from a lagging one:
        // without the previous epoch's entry, statuses would come out wrong (and be cached for the epoch).
        if (epoch > 0n && !history.has(epoch - 1n)) throw new Error(`The RPC's StakeHistory has no entry for epoch ${epoch - 1n} yet: retry in a moment.`)
        return history
      })
      this.historyCache = { epoch, value }
      value.catch(() => { if (this.historyCache?.value === value) this.historyCache = undefined })
    }
    return await this.historyCache.value
  }

  private async chainState(): Promise<ChainState> {
    const [clock, params] = await Promise.all([this.getEpochInfo(), this.getStakeParams()])
    return { clock, history: await this.stakeHistory(clock.epoch), ...params }
  }

  private seedOf(index: number): string {
    return `${this.seedPrefix}${index}`
  }

  /** Address of the wallet's stake account in seed slot `index`. */
  async getStakeAccountAddress(index: number): Promise<string> {
    if (!Number.isInteger(index) || index < 0 || index >= this.maxAccounts) throw new Error(`Seed slot must be 0..${this.maxAccounts - 1}.`)
    return createWithSeed(await this.wallet(), this.seedOf(index), STAKE_PROGRAM)
  }

  private toInfo(address: string, raw: RawAccount, seedIndex: number | null, wallet: string, chain: ChainState): StakeAccountInfo | null {
    if (raw.owner !== STAKE_PROGRAM) return null
    let data: StakeAccountData
    try {
      data = decodeStakeAccount(fromBase64(raw.data[0]!))
    } catch {
      return null
    }
    if (data.kind !== 'initialized' && data.kind !== 'delegated') return null
    const lamports = big(raw.lamports)
    const epoch = chain.clock.epoch
    const d = data.delegation
    const s = d ? activationStatus(d, epoch, chain.history, RATE_CHANGE_EPOCH) : null
    const staked = !d ? 0n : epoch >= d.deactivationEpoch ? s!.effective : d.stake
    const withdrawable = staked === 0n ? lamports : max0(lamports - staked - chain.rentExempt)
    const status = statusOf(s)
    const ready = d && (status === 'activating' || status === 'deactivating') ? settlesAt(d, epoch, chain.history, RATE_CHANGE_EPOCH) : null
    const locked = lockupInForce(data.lockup, epoch, BigInt(Math.floor(Date.now() / 1000)))
    const listed = this.validators === 'any' || (d !== null && this.validators.some((v) => v.voteAccount === d.voter))
    const name = d && this.validators !== 'any' ? this.validators.find((v) => v.voteAccount === d.voter)?.name ?? null : null
    return {
      address,
      id: accountId(address),
      seed: seedIndex === null ? null : this.seedOf(seedIndex),
      seedIndex,
      kind: data.kind,
      lamports,
      validator: d?.voter ?? null,
      validatorName: name,
      validatorListed: d !== null && listed,
      delegated: d && status !== 'inactive' ? d.stake : 0n,
      effective: s?.effective ?? 0n,
      activating: s?.activating ?? 0n,
      deactivating: s?.deactivating ?? 0n,
      status,
      activationEpoch: d && d.activationEpoch !== U64_MAX ? d.activationEpoch : null,
      deactivationEpoch: d && d.deactivationEpoch !== U64_MAX ? d.deactivationEpoch : null,
      withdrawable,
      readyEpoch: ready !== null && ready > epoch ? ready : null,
      readyAt: ready !== null && ready > epoch ? this.epochStart(ready, chain.clock) : null,
      staker: data.staker,
      withdrawer: data.withdrawer,
      owned: data.withdrawer === wallet,
      canManage: data.staker === wallet,
      canWithdraw: data.withdrawer === wallet && !locked,
      lockup: locked && data.lockup ? data.lockup : null,
    }
  }

  private epochStart(epoch: bigint, clock: EpochClock): number {
    const later = epoch - clock.epoch - 1n
    return clock.endsAt + (later > 0n ? bigintToNumber(later) * clock.slotsInEpoch * SLOT_MS : 0)
  }

  private async scan(wallet: string, chain: ChainState): Promise<{ accounts: StakeAccountInfo[]; freeIndex: number | null; freeIndexes: number[]; free: FreeSlot | null }> {
    const addresses = Array.from({ length: this.maxAccounts }, (_, i) => createWithSeed(wallet, this.seedOf(i), STAKE_PROGRAM))
    const [multiple, discovered] = await Promise.all([
      this.rpc.call<{ value: Array<RawAccount | null> }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: this.commitment }]),
      this._config.discover ? this.discover(wallet) : Promise.resolve([] as Array<{ pubkey: string; account: RawAccount }>),
    ])
    const accounts: StakeAccountInfo[] = []
    const freeIndexes: number[] = []
    const reclaimable: FreeSlot[] = []
    multiple.value.forEach((raw, i) => {
      if (!raw) { freeIndexes.push(i); return }
      // SOL someone sent to a seed address before the wallet used it: still the wallet's slot
      // (System-owned, no data), taken over with AllocateWithSeed instead of CreateAccountWithSeed.
      if (raw.owner === SYSTEM_PROGRAM && fromBase64(raw.data[0] ?? '').length === 0) { reclaimable.push({ index: i, address: addresses[i]!, existing: big(raw.lamports) }); return }
      const info = this.toInfo(addresses[i]!, raw, i, wallet, chain)
      if (info) accounts.push(info)
    })
    const seen = new Set(addresses)
    for (const { pubkey, account } of discovered.sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1))) {
      if (seen.has(pubkey)) continue
      seen.add(pubkey)
      const info = this.toInfo(pubkey, account, null, wallet, chain)
      if (info) accounts.push(info)
    }
    const first = freeIndexes[0]
    const free: FreeSlot | null = first !== undefined ? { index: first, address: addresses[first]!, existing: null } : reclaimable[0] ?? null
    return { accounts, freeIndex: first ?? null, freeIndexes, free }
  }

  /** Instructions that leave a stake-program-owned, 200-byte account holding `lamports` at a free seed slot. */
  private fundSlot(slot: FreeSlot, wallet: string, lamports: bigint): Instruction[] {
    const seed = this.seedOf(slot.index)
    if (slot.existing === null) {
      return [ixCreateAccountWithSeed({ payer: wallet, newAccount: slot.address, base: wallet, seed, lamports, space: STAKE_ACCOUNT_SPACE, owner: STAKE_PROGRAM })]
    }
    const topUp = lamports - slot.existing
    return [
      ...(topUp > 0n ? [ixTransfer({ from: wallet, to: slot.address, lamports: topUp })] : []),
      ixAllocateWithSeed({ account: slot.address, base: wallet, seed, space: STAKE_ACCOUNT_SPACE, owner: STAKE_PROGRAM }),
    ]
  }

  private async discover(wallet: string): Promise<Array<{ pubkey: string; account: RawAccount }>> {
    const by = (offset: number) => this.rpc.call<Array<{ pubkey: string; account: RawAccount }>>('getProgramAccounts', [STAKE_PROGRAM, {
      encoding: 'base64', commitment: this.commitment,
      filters: [{ dataSize: STAKE_ACCOUNT_SPACE }, { memcmp: { offset, bytes: wallet, encoding: 'base58' } }],
    }])
    const [asStaker, asWithdrawer] = await Promise.all([by(12), by(44)])
    return [...asStaker, ...asWithdrawer]
  }

  /**
   * The wallet's stake accounts: its seed slots, plus (with `discover`) accounts other wallets made for
   * it. Each with its status, amounts, when it settles and what the wallet may do with it.
   */
  async getStakeAccounts(): Promise<StakeAccountInfo[]> {
    const wallet = await this.wallet()
    const chain = await this.chainState()
    return (await this.scan(wallet, chain)).accounts
  }

  /**
   * The position: `balance` is the stake delegated and not being withdrawn (principal plus compounded
   * rewards), `total` every lamport in the wallet's stake accounts. There is no wrapped form (`rate` 0).
   * Only accounts the wallet can withdraw count; `managedOnly` sums those it is just the stake authority of.
   */
  override async getStakedBalance(): Promise<StakedBalance & { active: bigint; activating: bigint; deactivating: bigint; claimable: bigint; managedOnly: bigint }> {
    const accounts = await this.getStakeAccounts()
    let balance = 0n, total = 0n, active = 0n, activating = 0n, deactivating = 0n, claimable = 0n, managedOnly = 0n
    for (const a of accounts) {
      if (!a.owned) { managedOnly += a.lamports; continue } // the wallet is only the stake authority: not its SOL
      total += a.lamports
      if (a.kind === 'delegated' && a.deactivationEpoch === null) balance += a.delegated
      active += a.status === 'active' || a.status === 'activating' ? a.effective : 0n
      activating += a.activating
      deactivating += a.deactivating
      if (a.withdrawable === a.lamports && a.canWithdraw) claimable += a.lamports
    }
    return { balance, wrappedBalance: 0n, rate: 0n, total, active, activating, deactivating, claimable, managedOnly }
  }

  /** The most `stake` can take now: balance − account rent − fee reserve (0 when below the minimum delegation). */
  async getMaxStakeable(): Promise<bigint> {
    const [balance, params] = await Promise.all([this._account.getBalance(), this.getStakeParams()])
    const max = max0(BigInt(balance) - params.rentExempt - this.feeReserve)
    return max >= params.minimumDelegation ? max : 0n
  }

  // ── Validators ───────────────────────────────────────────────────────────────

  private async voteRow(vote: string): Promise<{ row: VoteAccountRow; delinquent: boolean } | null> {
    const r = await this.rpc.call<{ current: VoteAccountRow[]; delinquent: VoteAccountRow[] }>('getVoteAccounts', [{ votePubkey: vote, keepUnstakedDelinquents: true, commitment: this.commitment }])
    const current = r.current.find((v) => v.votePubkey === vote)
    if (current) return { row: current, delinquent: false }
    const delinquent = r.delinquent.find((v) => v.votePubkey === vote)
    return delinquent ? { row: delinquent, delinquent: true } : null
  }

  /** Base staking APR before commission, percent: validator inflation × supply ÷ effective stake. */
  private async inflationApr(): Promise<number | null> {
    if (!this.inflationCache || Date.now() - this.inflationCache.at > CACHE_MS) {
      const value = Promise.all([
        this.rpc.call<{ validator: unknown }>('getInflationRate', []),
        this.rpc.call<{ value: { total: unknown } }>('getSupply', [{ commitment: this.commitment, excludeNonCirculatingAccountsList: true }]),
      ]).then(([rate, supply]) => ({ validator: num(rate.validator), supply: num(supply.value.total) }))
      this.inflationCache = { at: Date.now(), value }
      value.catch(() => { if (this.inflationCache?.value === value) this.inflationCache = undefined })
    }
    const [{ validator, supply }, h] = await Promise.all([this.inflationCache.value, this.getEpochInfo().then((c) => this.stakeHistory(c.epoch))])
    let latest = -1n
    for (const e of h.keys()) if (e > latest) latest = e
    const effective = h.get(latest)?.effective ?? 0n
    if (effective === 0n) return null
    return (validator * supply / bigintToNumber(effective)) * 100
  }

  private info(vote: string, found: { row: VoteAccountRow; delinquent: boolean } | null, baseApr: number | null, extra: ValidatorExtra | undefined): ValidatorInfo {
    const configured = this.validators === 'any' ? undefined : this.validators.find((v) => v.voteAccount === vote)
    const listed = this.validators === 'any' ? found !== null : configured !== undefined
    const refusals: ValidatorRefusal[] = []
    if (!listed) refusals.push(this.validators === 'any' ? 'not-found' : 'not-listed')
    if (!found) { if (listed) refusals.push('not-found') } else {
      if (found.delinquent && !this._config.allowDelinquent) refusals.push('delinquent')
      if (num(found.row.commission) > this.maxCommission) refusals.push('commission-above-max')
    }
    const commission = found ? num(found.row.commission) : 0
    const history = found?.row.epochCredits
    const credits = (history && history.length > 0 ? history[history.length - 1] : undefined) as unknown[] | undefined
    const estimate = found && baseApr !== null ? baseApr * (1 - commission / 100) : null
    const apr = typeof extra?.apr === 'number' ? extra.apr : estimate
    const out: ValidatorInfo = {
      voteAccount: vote,
      nodePubkey: found?.row.nodePubkey ?? null,
      name: configured?.name ?? (typeof extra?.name === 'string' ? extra.name : null),
      commission,
      activatedStake: found ? big(found.row.activatedStake) : 0n,
      delinquent: found?.delinquent ?? false,
      lastVote: found ? big(found.row.lastVote) : 0n,
      epochCredits: credits && credits.length >= 3 ? big(credits[1]) - big(credits[2]) : null,
      listed,
      eligible: refusals.length === 0,
      refusals,
      apr,
      aprSource: typeof extra?.apr === 'number' ? 'enrich' : estimate !== null ? 'estimate' : null,
    }
    if (extra) out.extra = extra
    return out
  }

  private async enrich(votes: string[]): Promise<Record<string, ValidatorExtra>> {
    if (!this._config.enrich || votes.length === 0) return {}
    try {
      return (await this._config.enrich(votes)) ?? {}
    } catch {
      return {} // decoration only: the on-chain facts still stand
    }
  }

  /** One validator, live: commission, stake, delinquency, APR, and whether the module may delegate to it. */
  async getValidator(voteAccount: string): Promise<ValidatorInfo> {
    if (!isAddress(voteAccount)) throw new Error(`'${String(voteAccount)}' is not a vote account address.`)
    const [found, base, extra] = await Promise.all([this.voteRow(voteAccount), this.inflationApr().catch(() => null), this.enrich([voteAccount])])
    return this.info(voteAccount, found, base, extra[voteAccount])
  }

  /**
   * The validators to offer: the configured list in its order, or in `'any'` mode the cluster's voting
   * validators by stake (`limit` to cut it). Each says whether it can take stake now and why not.
   */
  async listValidators(options: { limit?: number } = {}): Promise<ValidatorInfo[]> {
    const base = this.inflationApr().catch(() => null)
    if (this.validators === 'any') {
      const r = await this.rpc.call<{ current: VoteAccountRow[]; delinquent: VoteAccountRow[] }>('getVoteAccounts', [{ commitment: this.commitment }])
      const rows = [...r.current].sort((a, b) => (big(b.activatedStake) > big(a.activatedStake) ? 1 : big(b.activatedStake) < big(a.activatedStake) ? -1 : 0))
      const cut = options.limit !== undefined ? rows.slice(0, options.limit) : rows
      const extra = await this.enrich(cut.map((v) => v.votePubkey))
      const b = await base
      return cut.map((row) => this.info(row.votePubkey, { row, delinquent: false }, b, extra[row.votePubkey]))
    }
    const list = options.limit !== undefined ? this.validators.slice(0, options.limit) : this.validators
    const votes = list.map((v) => v.voteAccount)
    const [rows, extra, b] = await Promise.all([Promise.all(votes.map((v) => this.voteRow(v))), this.enrich(votes), base])
    return votes.map((v, i) => this.info(v, rows[i] ?? null, b, extra[v]))
  }

  private async pickValidator(requested?: string): Promise<ValidatorInfo> {
    const vote = requested ?? this.defaultValidator
    if (vote !== undefined) {
      const v = await this.getValidator(vote)
      if (!v.eligible) throw new Error(`Validator ${vote} cannot take stake: ${v.refusals.join(', ')}${v.refusals.includes('commission-above-max') ? ` (commission ${v.commission} % > ${this.maxCommission} %)` : ''}.`)
      return v
    }
    if (this.validators === 'any') throw new Error("Pass `validator`: with validators: 'any' there is no default.")
    const all = await this.listValidators()
    const first = all.find((v) => v.eligible)
    if (!first) throw new Error(`None of the configured validators can take stake now: ${all.map((v) => `${v.voteAccount} (${v.refusals.join(', ')})`).join('; ')}.`)
    return first
  }

  /**
   * APR in percent for a validator (`validator`, else the default or the first eligible one): the
   * `enrich` figure when it gives one, else validator inflation × supply ÷ staked SOL × (1 − commission).
   * With `'any'` and no validator: the cluster-wide figure before commission.
   */
  override async getApr(options: { validator?: string } = {}): Promise<number> {
    const vote = options.validator ?? this.defaultValidator
    if (vote !== undefined) return (await this.getValidator(vote)).apr ?? 0
    if (this.validators === 'any') return (await this.inflationApr()) ?? 0
    const first = (await this.listValidators()).find((v) => v.eligible)
    return first?.apr ?? 0
  }

  /**
   * Inflation rewards the wallet's delegated stake accounts earned in the last `epochs` completed
   * epochs (default 5). An epoch the node no longer serves is reported with its error, not dropped.
   */
  async getRewards(options: { epochs?: number } = {}): Promise<NativeRewards> {
    const n = options.epochs ?? 5
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('epochs must be an integer from 1 to 50.')
    const [accounts, clock] = await Promise.all([this.getStakeAccounts(), this.getEpochInfo()])
    const delegated = accounts.filter((a) => a.kind === 'delegated' && a.owned).map((a) => a.address)
    const out: NativeRewards = { total: 0n, epochs: [] }
    if (delegated.length === 0) return out
    for (let k = 1n; k <= BigInt(n) && clock.epoch - k >= 0n; k++) {
      const epoch = clock.epoch - k
      try {
        const rows: Array<{ amount: unknown; postBalance: unknown; commission?: unknown } | null> = []
        for (let i = 0; i < delegated.length; i += REWARD_BATCH) {
          rows.push(...await this.rpc.call<Array<{ amount: unknown; postBalance: unknown; commission?: unknown } | null>>('getInflationReward', [delegated.slice(i, i + REWARD_BATCH), { epoch: bigintToNumber(epoch), commitment: this.commitment === 'processed' ? 'confirmed' : this.commitment }]))
        }
        const list = rows.flatMap((r, i) => (r ? [{ address: delegated[i]!, amount: big(r.amount), postBalance: big(r.postBalance), commission: r.commission === undefined || r.commission === null ? null : num(r.commission) }] : []))
        const amount = list.reduce((s, r) => s + r.amount, 0n)
        out.total += amount
        out.epochs.push({ epoch, amount, accounts: list })
      } catch (e) {
        out.epochs.push({ epoch, error: (e as Error).message })
      }
    }
    return out
  }

  // ── Writes ───────────────────────────────────────────────────────────────────

  private message(instructions: Instruction[]): { version: 0; instructions: Instruction[] } {
    const budget: Instruction[] = []
    if (this._config.computeUnitLimit !== undefined) budget.push(ixSetComputeUnitLimit(this._config.computeUnitLimit))
    if (this._config.computeUnitPrice !== undefined) budget.push(ixSetComputeUnitPrice(BigInt(this._config.computeUnitPrice)))
    return { version: 0, instructions: [...budget, ...instructions] }
  }

  private async quoteFee(instructions: Instruction[]): Promise<bigint> {
    if (typeof this._account.quoteSendTransaction !== 'function') return 0n
    try {
      return BigInt((await this._account.quoteSendTransaction(this.message(instructions))).fee ?? 0)
    } catch (e) {
      throw explainTakeover(e, instructions, this.maxAccounts)
    }
  }

  private async send(account: IWalletAccount, instructions: Instruction[]): Promise<{ hash: string; fee: bigint }> {
    try {
      const r = await account.sendTransaction(this.message(instructions))
      return { hash: r.hash, fee: BigInt(r.fee ?? 0) }
    } catch (e) {
      throw explainTakeover(e, instructions, this.maxAccounts)
    }
  }

  private async planStake(o: NativeStakeOptions): Promise<{ instructions: Instruction[]; quote: Omit<NativeStakeQuote, 'fee'> }> {
    const amount = toLamports(o?.amount)
    const wallet = await this.wallet()
    const chain = await this.chainState()
    if (amount < chain.minimumDelegation) throw new Error(`A stake must be at least ${lamportsText(chain.minimumDelegation)} (the Stake program's minimum delegation).`)
    const [validator, { free }, balance] = await Promise.all([this.pickValidator(o.validator), this.scan(wallet, chain), this._account.getBalance()])
    if (free === null) throw new Error(`All ${this.maxAccounts} stake account slots are in use: claim or merge accounts first.`)
    const total = amount + chain.rentExempt
    if (BigInt(balance) < total + this.feeReserve) {
      throw new Error(`Not enough SOL: staking ${lamportsText(amount)} needs ${lamportsText(total + this.feeReserve)} (stake + ${lamportsText(chain.rentExempt)} account rent + ${lamportsText(this.feeReserve)} kept for fees); the wallet has ${lamportsText(BigInt(balance))}.`)
    }
    const seed = this.seedOf(free.index)
    const stakeAccount = free.address
    return {
      instructions: [
        ...this.fundSlot(free, wallet, total),
        ixInitialize({ stake: stakeAccount, staker: wallet, withdrawer: wallet }),
        ixDelegate({ stake: stakeAccount, vote: validator.voteAccount, authority: wallet }),
      ],
      quote: { amount, rentExempt: chain.rentExempt, total, stakeAccount, seed, validator, readyEpoch: chain.clock.epoch + 1n },
    }
  }

  /** Network fee and details of a stake; nothing is signed. */
  override async quoteStake(options: NativeStakeOptions): Promise<NativeStakeQuote> {
    const { instructions, quote } = await this.planStake(options)
    return { ...quote, fee: await this.quoteFee(instructions) }
  }

  /** Stakes `amount` lamports with a validator: a new stake account, initialized and delegated in one transaction. */
  override async stake(options: NativeStakeOptions): Promise<NativeStakeResult> {
    const account = this.requireSigningAccount('stake')
    const { instructions, quote } = await this.planStake(options)
    return { ...quote, ...(await this.send(account, instructions)) }
  }

  private async planUnstake(o: NativeUnstakeOptions): Promise<{ instructions: Instruction[]; quote: Omit<NativeUnstakeQuote, 'fee'> }> {
    const amount = toLamports(o?.amount)
    const wallet = await this.wallet()
    const chain = await this.chainState()
    const { accounts, free } = await this.scan(wallet, chain)
    const min = chain.minimumDelegation
    // Only the wallet's own stake: a discovered account it merely manages belongs to its withdrawer.
    const unstakeable = (a: StakeAccountInfo) => a.kind === 'delegated' && a.deactivationEpoch === null && a.canManage && a.owned
    let pool = accounts.filter(unstakeable)
    if (o.account !== undefined) {
      const a = accounts.find((x) => x.address === o.account)
      if (!a) throw new Error(`Stake account ${o.account} is not one of this wallet's.`)
      if (!a.canManage) throw new Error(`The wallet is not the stake authority of ${o.account}.`)
      if (!a.owned) throw new Error(`Stake account ${o.account} is withdrawn by ${a.withdrawer}, not this wallet: its stake is not the wallet's to unstake.`)
      if (!unstakeable(a)) throw new Error(`Stake account ${o.account} is ${a.status === 'deactivating' ? 'already deactivating' : 'not delegated'}.`)
      pool = [a]
    }
    if (o.validator !== undefined) pool = pool.filter((a) => a.validator === o.validator)
    if (pool.length === 0) throw new Error('There is no delegated stake to unstake' + (o.validator !== undefined ? ` with validator ${o.validator}.` : '.'))
    const available = pool.reduce((s, a) => s + a.delegated, 0n)
    if (amount > available) throw new Error(`Only ${lamportsText(available)} is delegated here; asked to unstake ${lamportsText(amount)}.`)

    const plan = planUnstakeSteps(pool, amount, min)
    if (!plan) {
      throw new Error(`Unstaking ${lamportsText(amount)} cannot be split from these accounts with at least ${lamportsText(min)} (the minimum delegation) left in each part: unstake whole accounts, or an amount that leaves the minimum in both parts.`)
    }
    if (plan.whole.length + (plan.split ? 1 : 0) > MAX_DEACTIVATIONS_PER_TX) throw new Error(`That would deactivate more than ${MAX_DEACTIVATIONS_PER_TX} accounts in one transaction: unstake in parts.`)

    const steps: UnstakeStep[] = plan.whole.map((a) => ({ kind: 'deactivate', account: a.address, amount: a.delegated }))
    const instructions: Instruction[] = plan.whole.map((a) => ixDeactivate({ stake: a.address, authority: wallet }))
    let readyEpoch: bigint | null = chain.clock.epoch
    const settle = (a: StakeAccountInfo, stake: bigint) => settlesAt(
      { voter: a.validator!, stake, activationEpoch: a.activationEpoch ?? U64_MAX, deactivationEpoch: chain.clock.epoch },
      chain.clock.epoch, chain.history, RATE_CHANGE_EPOCH,
    )
    const later = (r: bigint | null) => { if (readyEpoch !== null && (r === null || r > readyEpoch)) readyEpoch = r }
    for (const a of plan.whole) later(settle(a, a.delegated))
    if (plan.split) {
      const { source, lamports } = plan.split
      if (free === null) throw new Error(`A partial unstake needs a free stake account slot and all ${this.maxAccounts} are in use: claim or merge accounts first.`)
      const balance = BigInt(await this._account.getBalance())
      if (balance < chain.rentExempt + this.feeReserve / 2n) throw new Error(`A partial unstake funds a new stake account with ${lamportsText(chain.rentExempt)} of rent (returned on claim); the wallet has ${lamportsText(balance)}.`)
      steps.push({ kind: 'split', account: source.address, amount: lamports, splitInto: free.address })
      instructions.push(
        ...this.fundSlot(free, wallet, chain.rentExempt),
        ixSplit({ stake: source.address, splitStake: free.address, authority: wallet, lamports }),
        ixDeactivate({ stake: free.address, authority: wallet }),
      )
      later(settle(source, lamports))
    }
    const ready: bigint | null = readyEpoch
    const readyAt = ready === null ? null : ready > chain.clock.epoch ? this.epochStart(ready, chain.clock) : Date.now()
    return { instructions, quote: { amount, steps, readyEpoch: ready, readyAt } }
  }

  /** Network fee and plan of an unstake; nothing is signed. */
  override async quoteRequestWithdrawal(options: NativeUnstakeOptions): Promise<NativeUnstakeQuote> {
    const { instructions, quote } = await this.planUnstake(options)
    return { ...quote, fee: await this.quoteFee(instructions) }
  }

  /**
   * Unstakes `amount` lamports of delegated stake: deactivates whole accounts (an exact match first,
   * then the largest that fit) and splits the remainder off one account. Claim after the cool-down.
   */
  override async requestWithdrawal(options: NativeUnstakeOptions): Promise<NativeUnstakeResult> {
    const account = this.requireSigningAccount('requestWithdrawal')
    const { instructions, quote } = await this.planUnstake(options)
    return { ...quote, ...(await this.send(account, instructions)), approveHash: null }
  }

  /**
   * Stake accounts that are cooling down or ready to claim. `id` is {@link accountId}; `amount` the
   * account's lamports (all of it returns on claim, rent included); `timestamp` is 0 (the chain does
   * not record when a deactivation was sent).
   */
  override async getWithdrawalRequests(): Promise<NativeWithdrawalRequestsView> {
    const accounts = await this.getStakeAccounts()
    const requests: NativeWithdrawalRequest[] = []
    let pendingAmount = 0n, claimableAmount = 0n
    const claimableIds: bigint[] = []
    for (const a of accounts) {
      if (!a.owned) continue // the SOL goes to another withdrawer
      const claimable = a.withdrawable === a.lamports && a.canWithdraw
      if (a.status !== 'deactivating' && !claimable) continue
      requests.push({ id: a.id, amount: a.lamports, timestamp: 0, claimable, address: a.address, status: a.status, readyEpoch: a.readyEpoch, readyAt: a.readyAt })
      if (claimable) { claimableAmount += a.lamports; claimableIds.push(a.id) } else pendingAmount += a.lamports
    }
    claimableIds.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
    return { requests, pendingAmount, claimableAmount, claimableIds }
  }

  private async planClaim(o: NativeClaimOptions = {}): Promise<{ instructions: Instruction[]; quote: Omit<NativeClaimQuote, 'fee'> }> {
    const wallet = await this.wallet()
    const chain = await this.chainState()
    const { accounts } = await this.scan(wallet, chain)
    const ready = accounts.filter((a) => a.withdrawable === a.lamports && a.lamports > 0n && a.canWithdraw)
    const pick = (match: (a: StakeAccountInfo) => boolean, label: string): StakeAccountInfo => {
      const a = accounts.find(match)
      if (!a) throw new Error(`${label} is not one of this wallet's stake accounts.`)
      if (!a.canWithdraw) throw new Error(`${label}: the wallet is not its withdraw authority${a.lockup ? ' or a lockup is in force' : ''}.`)
      if (a.withdrawable !== a.lamports) throw new Error(`${label} is ${a.status}${a.readyEpoch !== null ? `; claimable from epoch ${a.readyEpoch}` : ''}.`)
      return a
    }
    let chosen: StakeAccountInfo[]
    if (o.ids !== undefined || o.accounts !== undefined) {
      chosen = [
        ...(o.ids ?? []).map((id) => pick((a) => a.id === BigInt(id), `Withdrawal #${id}`)),
        ...(o.accounts ?? []).map((addr) => pick((a) => a.address === addr, `Stake account ${addr}`)),
      ].filter((a, i, all) => all.indexOf(a) === i)
    } else {
      chosen = ready
    }
    if (chosen.length === 0) throw new Error('Nothing is claimable yet.')
    // One transaction holds at most MAX_CLAIMS_PER_TX withdrawals; the rest is `remaining` for the next call.
    const now = chosen.slice(0, MAX_CLAIMS_PER_TX)
    return {
      instructions: now.map((a) => ixWithdraw({ stake: a.address, recipient: wallet, authority: wallet, lamports: a.lamports })),
      quote: { amount: now.reduce((s, a) => s + a.lamports, 0n), accounts: now.map((a) => a.address), remaining: chosen.length - now.length },
    }
  }

  /** Network fee and amount of a claim; nothing is signed. */
  override async quoteClaimWithdrawals(options: NativeClaimOptions = {}): Promise<NativeClaimQuote> {
    const { instructions, quote } = await this.planClaim(options)
    return { ...quote, fee: await this.quoteFee(instructions) }
  }

  /** Withdraws every lamport of fully inactive stake accounts to the wallet (the accounts close). */
  override async claimWithdrawals(options: NativeClaimOptions = {}): Promise<NativeClaimResult> {
    const account = this.requireSigningAccount('claimWithdrawals')
    const { instructions, quote } = await this.planClaim(options)
    return { ...quote, ...(await this.send(account, instructions)) }
  }

  private async planDelegate(o: DelegateOptions): Promise<{ instructions: Instruction[]; quote: Omit<DelegateQuote, 'fee'> }> {
    if (!o || !isAddress(o.account)) throw new Error("'account' must be a stake account address.")
    const wallet = await this.wallet()
    const chain = await this.chainState()
    const a = (await this.scan(wallet, chain)).accounts.find((x) => x.address === o.account)
    if (!a) throw new Error(`Stake account ${o.account} is not one of this wallet's.`)
    if (!a.canManage) throw new Error(`The wallet is not the stake authority of ${o.account}.`)
    if (!a.owned) throw new Error(`Stake account ${o.account} is withdrawn by ${a.withdrawer}, not this wallet.`)
    if (a.kind === 'delegated' && a.deactivationEpoch === chain.clock.epoch && a.effective > 0n) {
      if (o.validator !== undefined && o.validator !== a.validator) throw new Error('This account is still cooling down: it can only go back to its own validator this epoch.')
      // Undoing an unstake is a delegation like any other: the validator must still pass the policy.
      const v = await this.pickValidator(a.validator!)
      if (a.lamports - chain.rentExempt < a.delegated) throw new Error(`Stake account ${a.address} no longer holds its full delegation plus rent: it cannot be reactivated.`)
      return { instructions: [ixDelegate({ stake: a.address, vote: v.voteAccount, authority: wallet })], quote: { account: a.address, validator: v.voteAccount, mode: 'reactivate' } }
    }
    if (a.status === 'activating' && o.validator === undefined) {
      throw new Error(`Stake account ${a.address} is activating on ${a.validator}: pass \`validator\` to move it to another one.`)
    }
    if (a.kind === 'delegated' && a.effective > 0n) {
      throw new Error(a.status === 'deactivating' ? `Stake account ${a.address} is cooling down: delegate it again once inactive (epoch ${a.readyEpoch ?? chain.clock.epoch + 1n}).` : `Stake account ${a.address} is already delegated: unstake it first.`)
    }
    if (a.lamports - chain.rentExempt < chain.minimumDelegation) throw new Error(`Stake account ${a.address} holds less than the minimum delegation plus rent.`)
    const validator = await this.pickValidator(o.validator)
    return { instructions: [ixDelegate({ stake: a.address, vote: validator.voteAccount, authority: wallet })], quote: { account: a.address, validator: validator.voteAccount, mode: 'delegate' } }
  }

  /** Network fee of {@link delegate}; nothing is signed. */
  async quoteDelegate(options: DelegateOptions): Promise<DelegateQuote> {
    const { instructions, quote } = await this.planDelegate(options)
    return { ...quote, fee: await this.quoteFee(instructions) }
  }

  /**
   * Delegates an inactive stake account (to `validator`, or the default), or — for an account
   * deactivated in the current epoch — puts it back on its validator, undoing the unstake.
   */
  async delegate(options: DelegateOptions): Promise<DelegateResult> {
    const account = this.requireSigningAccount('delegate')
    const { instructions, quote } = await this.planDelegate(options)
    return { ...quote, ...(await this.send(account, instructions)) }
  }

  private async planMerge(o: MergeOptions): Promise<{ instructions: Instruction[]; quote: Omit<MergeQuote, 'fee'> }> {
    if (!o || !isAddress(o.destination) || !isAddress(o.source)) throw new Error("'destination' and 'source' must be stake account addresses.")
    if (o.destination === o.source) throw new Error('Cannot merge an account into itself.')
    const wallet = await this.wallet()
    const chain = await this.chainState()
    const { accounts } = await this.scan(wallet, chain)
    const find = (addr: string) => {
      const a = accounts.find((x) => x.address === addr)
      if (!a) throw new Error(`Stake account ${addr} is not one of this wallet's.`)
      if (!a.canManage) throw new Error(`The wallet is not the stake authority of ${addr}.`)
      if (!a.owned) throw new Error(`Stake account ${addr} is withdrawn by ${a.withdrawer}, not this wallet.`)
      return a
    }
    const d = find(o.destination), s = find(o.source)
    if (d.staker !== s.staker || d.withdrawer !== s.withdrawer) throw new Error('Merging needs both accounts to have the same authorities.')
    // The program merges when both lockups are expired, or when they are identical.
    const sameLockup = d.lockup === null && s.lockup === null
      || (d.lockup !== null && s.lockup !== null && d.lockup.epoch === s.lockup.epoch && d.lockup.unixTimestamp === s.lockup.unixTimestamp && d.lockup.custodian === s.lockup.custodian)
    if (!sameLockup) throw new Error('Merging needs both accounts to have the same lockup.')
    const epoch = chain.clock.epoch
    const inactive = (a: StakeAccountInfo) => a.status === 'inactive'
    const ok =
      (inactive(d) && inactive(s)) ||
      (inactive(s) && d.status === 'activating' && d.activationEpoch === epoch && d.effective === 0n) ||
      (d.status === 'active' && s.status === 'active' && d.validator === s.validator && d.effective === d.delegated && s.effective === s.delegated) ||
      (d.status === 'activating' && s.status === 'activating' && d.activationEpoch === epoch && s.activationEpoch === epoch && d.validator === s.validator)
    if (!ok) {
      throw new Error(`These accounts cannot be merged now (${d.status} + ${s.status}): merge two inactive accounts, two fully active ones on the same validator, or two activated this epoch on the same validator.`)
    }
    return { instructions: [ixMerge({ destination: d.address, source: s.address, authority: wallet })], quote: { destination: d.address, source: s.address } }
  }

  /** Network fee of {@link merge}; nothing is signed. */
  async quoteMerge(options: MergeOptions): Promise<MergeQuote> {
    const { instructions, quote } = await this.planMerge(options)
    return { ...quote, fee: await this.quoteFee(instructions) }
  }

  /** Merges `source` into `destination` (the source closes). Frees a seed slot and keeps the position tidy. */
  async merge(options: MergeOptions): Promise<MergeResult> {
    const account = this.requireSigningAccount('merge')
    const { instructions, quote } = await this.planMerge(options)
    return { ...quote, ...(await this.send(account, instructions)) }
  }

  /** Labels Stake-program transactions (stake, unstake, claim, delegate, merge) offline; see `activity.ts`. */
  override describeActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
    return describeNativeStakeActivity(tx, ctx, this.validators === 'any' ? [] : this.validators)
  }
}

/**
 * Picks the accounts an unstake of `amount` deactivates: an exact match, else whole accounts plus at
 * most one split. Every account is tried as the split source, with whole accounts taken largest first
 * from the rest while what remains can still be split (≥ `min` off the source, ≥ `min` left on it).
 * The plan with the fewest steps wins. Returns null when no plan respects the minimum delegation.
 */
export function planUnstakeSteps<A extends { delegated: bigint; address: string }>(pool: readonly A[], amount: bigint, min: bigint): { whole: A[]; split: { source: A; lamports: bigint } | null } | null {
  const exact = pool.find((a) => a.delegated === amount)
  if (exact) return { whole: [exact], split: null }
  const desc = [...pool].sort((a, b) => (b.delegated > a.delegated ? 1 : b.delegated < a.delegated ? -1 : 0))
  let best: { whole: A[]; split: { source: A; lamports: bigint } | null } | null = null
  const better = (p: NonNullable<typeof best>) => !best || p.whole.length + (p.split ? 1 : 0) < best.whole.length + (best.split ? 1 : 0)
  // Whole accounts only.
  {
    let rest = amount
    const whole: A[] = []
    for (const a of desc) if (a.delegated <= rest) { whole.push(a); rest -= a.delegated }
    if (rest === 0n) best = { whole, split: null }
  }
  for (const source of desc) {
    let rest = amount
    const whole: A[] = []
    for (const a of desc) {
      if (a === source) continue
      const left = rest - a.delegated
      if (left === 0n || left >= min) { whole.push(a); rest = left }
      if (rest === 0n) break
    }
    if (rest === 0n) { const p = { whole, split: null }; if (better(p)) best = p; continue }
    if (rest >= min && source.delegated - rest >= min) {
      const p = { whole, split: { source, lamports: rest } }
      if (better(p)) best = p
    }
  }
  return best
}
