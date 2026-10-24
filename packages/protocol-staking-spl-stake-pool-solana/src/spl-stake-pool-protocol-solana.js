'use strict'

import StakingProtocol from './staking-protocol.js'
import SPL_STAKE_POOL_ADDRESS_MAP from './spl-stake-pool-address-map.js'
import { describeStakePoolActivity } from './spl-stake-pool-activity.js'
import {
  STAKE_ACCOUNT_SPACE,
  STAKE_POOL_PROGRAM,
  STAKE_PROGRAM,
  decodeStakeAccount,
  decodeStakePool,
  decodeValidatorList,
  feePercent,
  findAta,
  findUnstakeAccount,
  findWithdrawAuthority,
  ixCreateAccountWithSeed,
  ixCreateAtaIdempotent,
  ixDepositSol,
  ixSetComputeUnitLimit,
  ixSetComputeUnitPrice,
  ixStakeDeactivate,
  ixStakeWithdraw,
  ixWithdrawSol,
  ixWithdrawStake,
  minimumStakeLamports,
  poolRate,
  quoteDepositSol,
  quoteWithdrawSol,
  quoteWithdrawStake,
  selectWithdrawSource,
  stakeActivation,
  unstakeSeed
} from './spl-stake-pool-codec.js'

/** @typedef {import('./staking-protocol.js').StakeOptions} StakeOptions */
/** @typedef {import('./staking-protocol.js').StakeResult} StakeResult */
/** @typedef {import('./staking-protocol.js').WithdrawalRequestOptions} WithdrawalRequestOptions */
/** @typedef {import('./staking-protocol.js').WithdrawalRequestResult} WithdrawalRequestResult */
/** @typedef {import('./staking-protocol.js').WithdrawalRequestsView} WithdrawalRequestsView */
/** @typedef {import('./staking-protocol.js').ClaimWithdrawalsOptions} ClaimWithdrawalsOptions */
/** @typedef {import('./staking-protocol.js').ClaimWithdrawalsResult} ClaimWithdrawalsResult */
/** @typedef {import('./staking-protocol.js').StakedBalance} StakedBalance */
/** @typedef {import('./spl-stake-pool-address-map.js').StakePoolConfig} StakePoolConfig */
/** @typedef {import('./spl-stake-pool-codec.js').StakePoolState} StakePoolState */
/** @typedef {import('./spl-stake-pool-codec.js').StakeActivation} StakeActivation */
/** @typedef {import('@solana/instructions').Instruction} Instruction */

const LAMPORTS_PER_SOL = 1_000_000_000n
const U64_MAX = 0xffffffffffffffffn
/** Public gateways tried after whatever the caller configured. */
export const DEFAULT_PROVIDERS = ['https://api.mainnet-beta.solana.com']
/** Compute budget attached to every transaction the module sends. */
export const DEFAULT_COMPUTE_UNIT_LIMIT = 300_000
/** Priority fee per compute unit, micro-lamports (≈ 0.000015 SOL at the default limit). */
export const DEFAULT_COMPUTE_UNIT_PRICE = 50_000n
/** Quote tolerance for the ..WithSlippage instructions (rates move only at epoch boundaries). */
export const DEFAULT_SLIPPAGE_BPS = 50
/** Seed-derived stake accounts tracked per wallet for delayed exits. */
export const DEFAULT_UNSTAKE_SLOTS = 8
/** Slot time used to project the epoch boundary. */
const SLOT_MS = 400

/**
 * Normalizes and validates an amount option.
 *
 * @param {number | bigint} amount - The amount (in base unit).
 * @returns {bigint} The amount as a bigint.
 */
function toAmount (amount) {
  if (typeof amount !== 'bigint' && !(typeof amount === 'number' && Number.isSafeInteger(amount))) {
    throw new Error("'amount' must be a bigint or a safe integer (in base unit).")
  }
  const value = BigInt(amount)
  if (value <= 0n) {
    throw new Error("'amount' should be greater than zero.")
  }
  return value
}

/**
 * @param {string} s - Base64.
 * @returns {Uint8Array} Bytes.
 */
function fromBase64 (s) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'))
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
/**
 * @param {string} s - Base58.
 * @returns {Uint8Array} Bytes.
 */
export function base58Decode (s) {
  const bytes = []
  for (const ch of s) {
    let carry = B58.indexOf(ch)
    if (carry < 0) throw new Error('bad base58')
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  for (const ch of s) {
    if (ch !== '1') break
    bytes.push(0)
  }
  return Uint8Array.from(bytes.reverse())
}

/**
 * @typedef {Object} SplStakePoolProtocolConfig
 * @property {string | StakePoolConfig} [pool] - A key of `SPL_STAKE_POOL_ADDRESS_MAP` ('jito' by default) or an explicit `{ name, pool, mint, symbol }` for any pool on the program.
 * @property {*} [provider] - Where reads go: a JSON-RPC URL, an array of URLs (tried in order), a `@solana/rpc` client (what `@anywalletkit/wallet-solana` accounts hold), or `{ request(method, params) }`. Defaults to the account's own RPC.
 * @property {'processed' | 'confirmed' | 'finalized'} [commitment] - Read commitment (default 'confirmed').
 * @property {number} [slippageBps] - Tolerance on the quoted amount for ..WithSlippage instructions (default 50).
 * @property {number} [computeUnitLimit] - Compute budget per transaction (default 300 000).
 * @property {bigint | number} [computeUnitPrice] - Priority fee in micro-lamports per unit (default 50 000).
 * @property {number} [unstakeSlots] - Delayed-exit stake accounts tracked per wallet (default 8).
 * @property {() => Promise<number>} [apr] - Hook returning the APY in percent from a provider's figure (Jito's stats, Sanctum, …); without it `getApr` estimates from the pool's last two epochs.
 */

/**
 * Liquid staking through any pool on the SPL Stake Pool program — Jito by
 * default — for Solana wallet accounts.
 *
 * An SPL stake pool holds validator stake accounts and a reserve; the pool
 * token (JitoSOL, bSOL, …) is the non-rebasing receipt whose SOL value is
 * `total_lamports / pool_token_supply`, updated once per epoch (~2 days) by
 * the pool's crank. Staking is one `DepositSol` (SOL goes to the reserve,
 * tokens are minted at the rate). Exits come in two shapes:
 *
 *  - **instant** — `WithdrawSol`: burn tokens, SOL is paid from the reserve
 *    right away, minus the pool's SOL withdrawal fee; only while the reserve
 *    holds enough;
 *  - **delayed** — `WithdrawStake`: burn tokens, the pool splits a validator
 *    stake account to a fresh stake account owned by the wallet, which this
 *    module deactivates in the same transaction. The SOL is claimable after
 *    the epoch boundary (`claimWithdrawals` sweeps it back, rent included).
 *    The stake program's minimum delegation (1 SOL + rent) is the floor.
 *
 * The delayed exit is what the proposed staking interface calls a withdrawal
 * request: `requestWithdrawal` → `getWithdrawalRequests` → `claimWithdrawals`.
 * The wallet's stake accounts are derived with seeds (`<pool>-unstake:<i>`),
 * so the queue is recoverable from the wallet alone and no ephemeral keypair
 * ever signs.
 *
 * Fail-closed before signing: the configured mint must match the on-chain
 * pool state; the pool must be reconciled for the current epoch (the program
 * rejects everything else); a delayed exit must yield at least the stake
 * program's minimum and leave the split-from account its minimum; an instant
 * exit must fit the reserve; every amount is sent with a slippage floor.
 */
export default class SplStakePoolProtocolSolana extends StakingProtocol {
  /**
   * Creates a new interface to an SPL stake pool for Solana blockchains.
   *
   * @param {*} account - The wallet account (a @anywalletkit/wallet-solana account, or a read-only one for views).
   * @param {SplStakePoolProtocolConfig} [config] - The protocol's configuration.
   */
  constructor (account, config = {}) {
    super(account)

    const pool = typeof config.pool === 'object' && config.pool !== null
      ? config.pool
      : SPL_STAKE_POOL_ADDRESS_MAP[config.pool ?? 'jito']
    if (!pool || typeof pool.pool !== 'string' || typeof pool.mint !== 'string' || typeof pool.name !== 'string') {
      throw new Error(`Unknown stake pool '${config.pool}': pass a key of SPL_STAKE_POOL_ADDRESS_MAP or { name, pool, mint, symbol }.`)
    }
    /** @type {StakePoolConfig} */
    this.pool = { symbol: pool.name, ...pool }

    const source = config.provider ?? account?._rpc ?? account?._config?.provider ?? account?._config?.rpcUrl
    /** @private @type {Array<string | { request: Function } | object>} */
    this._providers = Array.isArray(source) ? source : source ? [source] : []
    /** @private */
    this._commitment = config.commitment ?? 'confirmed'
    /** @private */
    this._slippageBps = BigInt(config.slippageBps ?? DEFAULT_SLIPPAGE_BPS)
    /** @private */
    this._computeUnitLimit = config.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT
    /** @private */
    this._computeUnitPrice = BigInt(config.computeUnitPrice ?? DEFAULT_COMPUTE_UNIT_PRICE)
    /** @private */
    this._unstakeSlots = config.unstakeSlots ?? DEFAULT_UNSTAKE_SLOTS
    /** @private */
    this._aprHook = config.apr
  }

  /** @private */
  _requireWritable (method) {
    // Structural, deliberately not instanceof: a duplicated copy of the
    // account package fails instanceof while the account works fine.
    if (typeof this._account?.sendTransaction !== 'function') {
      throw new Error(`The '${method}' method requires the protocol to be initialized with a non read-only account.`)
    }
  }

  /**
   * One JSON-RPC call, tried against each provider until one answers. A
   * node-side rejection (bad params, unsupported method) is final; transport
   * failures and rate limits move to the next provider.
   *
   * @protected
   * @param {string} method - The RPC method.
   * @param {unknown[]} [params] - Its params.
   * @returns {Promise<any>} The result.
   */
  async _rpc (method, params = []) {
    if (this._providers.length === 0) {
      throw new Error('The protocol must be initialized with a provider (or an account configured with one).')
    }
    let lastError
    for (const provider of this._providers) {
      try {
        if (typeof provider === 'string') {
          const res = await fetch(provider, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const body = await res.json()
          if (body.error) {
            if (body.error.code === 429 || /rate|limit|too many/i.test(String(body.error.message))) throw new Error(body.error.message)
            throw Object.assign(new Error(`${method}: ${body.error.message}`), { final: true })
          }
          return body.result
        }
        if (typeof provider.request === 'function') {
          return await provider.request(method, params)
        }
        if (typeof provider[method] === 'function') {
          // @solana/rpc client (or a failover proxy over one): positional params, then .send()
          return await provider[method](...params).send()
        }
        throw Object.assign(new Error('Unsupported provider: expected a URL, a @solana/rpc client or { request(method, params) }.'), { final: true })
      } catch (error) {
        if (error?.final) throw error
        lastError = error
      }
    }
    throw lastError
  }

  /** @private */
  async _getAccount (address) {
    const r = await this._rpc('getAccountInfo', [address, { encoding: 'base64', commitment: this._commitment }])
    return r?.value ?? null
  }

  /** @private */
  async _getAccounts (addresses) {
    if (addresses.length === 0) return []
    const r = await this._rpc('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: this._commitment }])
    return r?.value ?? []
  }

  /** @private */
  async _getBalance (address) {
    const r = await this._rpc('getBalance', [address, { commitment: this._commitment }])
    return BigInt(r.value)
  }

  /** @private */
  async _address () {
    return await this._account.getAddress()
  }

  // ---- Reads ----

  /**
   * The chain's epoch clock.
   *
   * @returns {Promise<{ epoch: bigint, slotIndex: number, slotsInEpoch: number, progress: number, endsAt: number }>} Epoch, position in it, and a projected unix-ms boundary.
   */
  async getEpochInfo () {
    const e = await this._rpc('getEpochInfo', [{ commitment: this._commitment }])
    const slotIndex = Number(e.slotIndex)
    const slotsInEpoch = Number(e.slotsInEpoch)
    return {
      epoch: BigInt(e.epoch),
      slotIndex,
      slotsInEpoch,
      progress: slotsInEpoch > 0 ? slotIndex / slotsInEpoch : 0,
      endsAt: Date.now() + Math.max(0, slotsInEpoch - slotIndex) * SLOT_MS
    }
  }

  /**
   * The stake program's parameters a delayed exit has to respect.
   *
   * @returns {Promise<{ rentExempt: bigint, minimumDelegation: bigint, minimumStakeLamports: bigint }>} Rent for a stake account, the minimum delegation, and their sum as the pool applies it.
   */
  async getStakeParams () {
    const [rent, min] = await Promise.all([
      this._rpc('getMinimumBalanceForRentExemption', [STAKE_ACCOUNT_SPACE]),
      this._rpc('getStakeMinimumDelegation', [{ commitment: this._commitment }])
    ])
    const rentExempt = BigInt(rent)
    const minimumDelegation = BigInt(min.value)
    return { rentExempt, minimumDelegation, minimumStakeLamports: minimumStakeLamports(rentExempt, minimumDelegation) }
  }

  /**
   * The pool's live state, decoded from chain and checked against the
   * configured mint. Rates are 1e9 fixed point lamports per pool token.
   *
   * @returns {Promise<{ state: StakePoolState, withdrawAuthority: string, epoch: bigint, updated: boolean, rate: bigint, previousRate: bigint, totalLamports: bigint, poolTokenSupply: bigint, reserveLamports: bigint, instantLiquidity: bigint, rentExempt: bigint, minimumDelegation: bigint, minimumStakeLamports: bigint, fees: { solDepositPct: number, solWithdrawalPct: number, stakeWithdrawalPct: number, epochPct: number } }>} The pool data.
   */
  async getPoolData () {
    const [account, epochInfo, params, withdrawAuthority] = await Promise.all([
      this._getAccount(this.pool.pool),
      this.getEpochInfo(),
      this.getStakeParams(),
      findWithdrawAuthority(this.pool.pool)
    ])
    if (!account) throw new Error(`Stake pool account ${this.pool.pool} not found.`)
    if (account.owner !== STAKE_POOL_PROGRAM) throw new Error(`${this.pool.pool} is not owned by the SPL Stake Pool program.`)
    const state = decodeStakePool(fromBase64(account.data[0]))
    if (state.poolMint !== this.pool.mint) {
      throw new Error(`Pool mint ${state.poolMint} does not match the configured ${this.pool.symbol} mint ${this.pool.mint}.`)
    }
    const reserveLamports = await this._getBalance(state.reserveStake)
    const instantLiquidity = reserveLamports > params.rentExempt ? reserveLamports - params.rentExempt : 0n
    return {
      state,
      withdrawAuthority,
      epoch: epochInfo.epoch,
      updated: state.lastUpdateEpoch >= epochInfo.epoch,
      rate: poolRate(state),
      previousRate: poolRate({ totalLamports: state.lastEpochTotalLamports, poolTokenSupply: state.lastEpochPoolTokenSupply }),
      totalLamports: state.totalLamports,
      poolTokenSupply: state.poolTokenSupply,
      reserveLamports,
      instantLiquidity,
      ...params,
      fees: {
        solDepositPct: feePercent(state.solDepositFee),
        solWithdrawalPct: feePercent(state.solWithdrawalFee),
        stakeWithdrawalPct: feePercent(state.stakeWithdrawalFee),
        epochPct: feePercent(state.epochFee)
      }
    }
  }

  /**
   * The account's liquid SOL.
   *
   * @returns {Promise<bigint>} Lamports.
   */
  async getNativeBalance () {
    return await this._getBalance(await this._address())
  }

  /**
   * The account's associated token account for the pool token.
   *
   * @returns {Promise<string>} The ATA address.
   */
  async getTokenAccount () {
    return await findAta(await this._address(), this.pool.mint)
  }

  /**
   * Pool tokens held by the account (0 when its token account does not exist).
   *
   * @returns {Promise<bigint>} Base units (9 decimals on every known pool).
   */
  async getTokenBalance () {
    const ata = await this.getTokenAccount()
    const account = await this._getAccount(ata)
    if (!account) return 0n
    const d = fromBase64(account.data[0])
    return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(64, true)
  }

  /**
   * The position: `balance` is pool tokens held, `rate` lamports per token
   * (1e9 fixed point), `total` the position valued in lamports — for a
   * non-rebasing receipt the SOL value is the figure that means anything.
   *
   * @returns {Promise<StakedBalance>} The staked balances.
   */
  async getStakedBalance () {
    const [balance, pool] = await Promise.all([this.getTokenBalance(), this.getPoolData()])
    return { balance, wrappedBalance: 0n, rate: pool.rate, total: (balance * pool.rate) / LAMPORTS_PER_SOL }
  }

  /**
   * SOL the reserve can pay out right now (reserve minus its rent).
   *
   * @returns {Promise<bigint>} Lamports.
   */
  async getInstantLiquidity () {
    return (await this.getPoolData()).instantLiquidity
  }

  /**
   * APY in percent. With the `apr` hook, the provider's figure (Jito's own
   * stats include MEV tips). Without it, an on-chain estimate from the last
   * epoch's rate change annualized — honest, but it sees one epoch and no
   * off-chain rewards.
   *
   * @returns {Promise<number>} The APY.
   */
  async getApr () {
    if (this._aprHook) return await this._aprHook()
    const [pool, epoch] = await Promise.all([this.getPoolData(), this.getEpochInfo()])
    if (pool.previousRate <= 0n) return 0
    const perEpoch = Number(pool.rate) / Number(pool.previousRate) - 1
    const epochsPerYear = (365.25 * 86_400_000) / (epoch.slotsInEpoch * SLOT_MS)
    return perEpoch * epochsPerYear * 100
  }

  // ---- Stake ----

  /**
   * The instructions of a stake: create the token account if missing, then
   * `DepositSolWithSlippage` with the quoted tokens minus the tolerance.
   *
   * @protected
   * @param {bigint} lamports - The deposit.
   * @returns {Promise<{ instructions: Instruction[], poolTokens: bigint }>} Instructions and the quoted tokens.
   */
  async _getStakeInstructions (lamports) {
    const [pool, wallet] = await Promise.all([this.getPoolData(), this._address()])
    if (!pool.updated) {
      throw new Error(`The ${this.pool.name} pool is not yet updated for epoch ${pool.epoch}: deposits and withdrawals reopen once its crank runs (usually minutes).`)
    }
    const ata = await findAta(wallet, this.pool.mint)
    const { poolTokens } = quoteDepositSol(pool.state, lamports)
    if (poolTokens <= 0n) throw new Error(`The amount is too small to mint any ${this.pool.symbol}.`)
    return {
      poolTokens,
      instructions: [
        ixCreateAtaIdempotent({ payer: wallet, ata, owner: wallet, mint: this.pool.mint }),
        ixDepositSol({
          pool: this.pool.pool,
          state: pool.state,
          withdrawAuthority: pool.withdrawAuthority,
          from: wallet,
          destination: ata,
          lamports,
          minimumPoolTokensOut: this._lessSlippage(poolTokens)
        })
      ]
    }
  }

  /**
   * Stakes SOL: pool tokens land on the account at the current rate.
   *
   * @param {StakeOptions} options - The stake's options (`amount` in lamports).
   * @returns {Promise<StakeResult>} The stake's result.
   */
  async stake ({ amount }) {
    this._requireWritable('stake')
    const { instructions } = await this._getStakeInstructions(toAmount(amount))
    const { hash, fee } = await this._account.sendTransaction(this._message(instructions))
    return { hash, fee: BigInt(fee ?? 0) }
  }

  /**
   * Quotes a stake: the network fee and the pool tokens it mints.
   *
   * @param {StakeOptions} options - The stake's options.
   * @returns {Promise<Omit<StakeResult, 'hash'> & { amountOut: bigint }>} The costs and the quoted tokens.
   */
  async quoteStake ({ amount }) {
    const { instructions, poolTokens } = await this._getStakeInstructions(toAmount(amount))
    return { fee: await this._quoteFee(instructions), amountOut: poolTokens }
  }

  // ---- Unstake ----

  /**
   * The account's delayed-exit slots: seed-derived stake accounts, decoded.
   *
   * @protected
   * @returns {Promise<{ wallet: string, epoch: bigint, slots: Array<{ index: number, address: string, lamports: bigint, status: StakeActivation, deactivationEpoch: bigint | null } | null>, freeIndex: number | null }>} Slots (null where empty) and the first free one.
   */
  async _getUnstakeSlots () {
    const wallet = await this._address()
    const addresses = await Promise.all(Array.from({ length: this._unstakeSlots }, (_, i) => findUnstakeAccount(wallet, this.pool.name, i)))
    const [accounts, epochInfo] = await Promise.all([this._getAccounts(addresses), this.getEpochInfo()])
    const slots = []
    let freeIndex = null
    for (let i = 0; i < addresses.length; i++) {
      const a = accounts[i]
      if (!a) {
        if (freeIndex === null) freeIndex = i
        slots.push(null)
        continue
      }
      if (a.owner !== STAKE_PROGRAM) { slots.push(null); continue } // something else parked on our seed address
      const data = decodeStakeAccount(fromBase64(a.data[0]))
      if (data.state === 'uninitialized') { slots.push(null); continue }
      const status = stakeActivation(data, epochInfo.epoch)
      slots.push({
        index: i,
        address: addresses[i],
        lamports: BigInt(a.lamports),
        status,
        deactivationEpoch: data.delegation && data.delegation.deactivationEpoch !== U64_MAX ? data.delegation.deactivationEpoch : null
      })
    }
    return { wallet, epoch: epochInfo.epoch, slots, freeIndex }
  }

  /**
   * The instructions of an exit.
   *
   * @protected
   * @param {bigint} poolTokens - Pool tokens to burn.
   * @param {'instant' | 'delayed'} mode - The exit mode.
   * @returns {Promise<{ instructions: Instruction[], lamportsOut: bigint, feeTokens: bigint, stakeAccount: string | null, source: import('./spl-stake-pool-codec.js').WithdrawSource | null }>} Instructions and the quote.
   */
  async _getUnstakeInstructions (poolTokens, mode) {
    if (mode !== 'instant' && mode !== 'delayed') throw new Error("'mode' must be 'instant' or 'delayed'.")
    const [pool, wallet, held] = await Promise.all([this.getPoolData(), this._address(), this.getTokenBalance()])
    if (!pool.updated) {
      throw new Error(`The ${this.pool.name} pool is not yet updated for epoch ${pool.epoch}: deposits and withdrawals reopen once its crank runs (usually minutes).`)
    }
    if (poolTokens > held) throw new Error(`The amount exceeds the ${this.pool.symbol} balance (${held}).`)
    const ata = await findAta(wallet, this.pool.mint)
    const base = { pool: this.pool.pool, state: pool.state, withdrawAuthority: pool.withdrawAuthority, owner: wallet, source: ata }

    if (mode === 'instant') {
      const q = quoteWithdrawSol(pool.state, poolTokens)
      if (q.lamports <= 0n) throw new Error('The amount is too small.')
      if (q.lamports > pool.instantLiquidity) {
        throw new Error(`The pool reserve can pay ${pool.instantLiquidity} lamports right now, less than this exit — use the delayed mode.`)
      }
      return {
        instructions: [ixWithdrawSol({ ...base, poolTokens, minimumLamportsOut: this._lessSlippage(q.lamports) })],
        lamportsOut: q.lamports,
        feeTokens: q.feeTokens,
        stakeAccount: null,
        source: null
      }
    }

    const q = quoteWithdrawStake(pool.state, poolTokens)
    if (q.lamports < pool.minimumStakeLamports) {
      throw new Error(`A delayed exit must be worth at least ${pool.minimumStakeLamports} lamports (the stake program's minimum delegation plus rent) — use the instant mode for less.`)
    }
    const { freeIndex } = await this._getUnstakeSlots()
    if (freeIndex === null) throw new Error(`All ${this._unstakeSlots} delayed-exit slots are in use — claim a finished exit first.`)
    const listAccount = await this._getAccount(pool.state.validatorList)
    if (!listAccount) throw new Error('Validator list account not found.')
    const { validators } = decodeValidatorList(fromBase64(listAccount.data[0]))
    const source = await selectWithdrawSource({
      pool: this.pool.pool,
      state: pool.state,
      validators,
      lamports: q.lamports,
      rentExempt: pool.rentExempt,
      minimumDelegation: pool.minimumDelegation,
      reserveLamports: pool.reserveLamports
    })
    if (source.kind === 'validator') {
      // The list is as of the last update; make sure the live balance still keeps the minimum after our split.
      const live = await this._getBalance(source.account)
      if (live - q.lamports < pool.minimumStakeLamports) {
        throw new Error('The validator stake account moved since the last pool update — retry in a moment.')
      }
    }
    const stakeAccount = await findUnstakeAccount(wallet, this.pool.name, freeIndex)
    return {
      instructions: [
        ixCreateAccountWithSeed({
          from: wallet,
          newAccount: stakeAccount,
          base: wallet,
          seed: unstakeSeed(this.pool.name, freeIndex),
          lamports: pool.rentExempt,
          space: BigInt(STAKE_ACCOUNT_SPACE),
          owner: STAKE_PROGRAM
        }),
        ixWithdrawStake({ ...base, splitFrom: source.account, splitTo: stakeAccount, poolTokens, minimumLamportsOut: this._lessSlippage(q.lamports) }),
        ixStakeDeactivate({ stake: stakeAccount, authority: wallet })
      ],
      lamportsOut: q.lamports,
      feeTokens: q.feeTokens,
      stakeAccount,
      source
    }
  }

  /**
   * Exits the pool. `mode: 'instant'` burns tokens against the reserve and
   * pays SOL at once (nothing to claim). `mode: 'delayed'` (default) burns
   * tokens into a stake account on the wallet and deactivates it; claim the
   * SOL after the epoch boundary through {@link claimWithdrawals}.
   *
   * @param {WithdrawalRequestOptions & { mode?: 'instant' | 'delayed' }} options - The request's options (`amount` in pool-token base units).
   * @returns {Promise<WithdrawalRequestResult & { amountOut: bigint, stakeAccount: string | null }>} The result, the quoted lamports and the stake account (delayed mode).
   */
  async requestWithdrawal ({ amount, mode = 'delayed' }) {
    this._requireWritable('requestWithdrawal')
    const { instructions, lamportsOut, stakeAccount } = await this._getUnstakeInstructions(toAmount(amount), mode)
    const { hash, fee } = await this._account.sendTransaction(this._message(instructions))
    return { hash, fee: BigInt(fee ?? 0), approveHash: null, amountOut: lamportsOut, stakeAccount }
  }

  /**
   * Quotes an exit: the network fee and the lamports it yields after the pool fee.
   *
   * @param {WithdrawalRequestOptions & { mode?: 'instant' | 'delayed' }} options - The request's options.
   * @returns {Promise<{ fee: bigint, amountOut: bigint, feeTokens: bigint }>} The costs and the quote.
   */
  async quoteRequestWithdrawal ({ amount, mode = 'delayed' }) {
    const { instructions, lamportsOut, feeTokens } = await this._getUnstakeInstructions(toAmount(amount), mode)
    return { fee: await this._quoteFee(instructions), amountOut: lamportsOut, feeTokens }
  }

  /**
   * The account's delayed exits: one request per seed slot in use. `id` is
   * the slot index, `amount` the lamports the stake account holds (rent
   * included, all of it comes back on claim), `claimable` once the account
   * is fully inactive. `timestamp` is not knowable from state alone and is 0.
   *
   * @returns {Promise<WithdrawalRequestsView & { requests: Array<import('./staking-protocol.js').WithdrawalRequest & { address: string, status: StakeActivation, deactivationEpoch: bigint | null }> }>} The queue view.
   */
  async getWithdrawalRequests () {
    const { slots } = await this._getUnstakeSlots()
    const requests = []
    let pendingAmount = 0n
    let claimableAmount = 0n
    const claimableIds = []
    for (const s of slots) {
      if (!s) continue
      const claimable = s.status === 'inactive'
      requests.push({ id: BigInt(s.index), amount: s.lamports, timestamp: 0, claimable, address: s.address, status: s.status, deactivationEpoch: s.deactivationEpoch })
      if (claimable) {
        claimableAmount += s.lamports
        claimableIds.push(BigInt(s.index))
      } else {
        pendingAmount += s.lamports
      }
    }
    return { requests: requests.reverse(), pendingAmount, claimableAmount, claimableIds }
  }

  /**
   * @protected
   * @param {bigint[] | undefined} ids - Slot indexes, or every claimable one.
   * @returns {Promise<{ instructions: Instruction[], lamports: bigint }>} Instructions and the lamports swept.
   */
  async _getClaimInstructions (ids) {
    const { wallet, slots } = await this._getUnstakeSlots()
    const ready = slots.filter((s) => s && s.status === 'inactive')
    const chosen = ids === undefined ? ready : ids.map((id) => {
      const s = ready.find((r) => BigInt(r.index) === BigInt(id))
      if (!s) throw new Error(`Exit #${id} is not claimable (unknown slot or still cooling down).`)
      return s
    })
    if (chosen.length === 0) throw new Error('Nothing is claimable yet.')
    return {
      instructions: chosen.map((s) => ixStakeWithdraw({ stake: s.address, recipient: wallet, authority: wallet, lamports: s.lamports })),
      lamports: chosen.reduce((n, s) => n + s.lamports, 0n)
    }
  }

  /**
   * Sweeps finished delayed exits back to the account (closes the stake accounts).
   *
   * @param {ClaimWithdrawalsOptions} [options] - The claim's options.
   * @returns {Promise<ClaimWithdrawalsResult & { amount: bigint }>} The result and the lamports swept.
   */
  async claimWithdrawals (options = {}) {
    this._requireWritable('claimWithdrawals')
    const { instructions, lamports } = await this._getClaimInstructions(options.ids)
    const { hash, fee } = await this._account.sendTransaction(this._message(instructions))
    return { hash, fee: BigInt(fee ?? 0), amount: lamports }
  }

  /**
   * Quotes a claim.
   *
   * @param {ClaimWithdrawalsOptions} [options] - The claim's options.
   * @returns {Promise<{ fee: bigint, amount: bigint }>} The costs and the lamports it sweeps.
   */
  async quoteClaimWithdrawals (options = {}) {
    const { instructions, lamports } = await this._getClaimInstructions(options.ids)
    return { fee: await this._quoteFee(instructions), amount: lamports }
  }

  // ---- Extras ----

  /**
   * What the position has earned. Pool tokens never change count, only
   * their SOL value, so the honest figure is (rate now − the account's
   * weighted entry rate) × tokens held; entry rates come from the account's
   * own `DepositSol` transactions on its token account (lamports in from the
   * instruction data, tokens out from the balance delta — top-level or
   * CPI'd by a router). Bounded to the last `limit` transactions.
   * Decoration: null when nothing was staked or history is unavailable.
   *
   * @param {{ limit?: number }} [options] - How many token-account transactions to scan (default 60).
   * @returns {Promise<{ earned: bigint, entryRate: bigint, deposited: bigint, minted: bigint, firstStakeAt: number | null } | null>} Earnings (lamports; rates 1e9 fixed; firstStakeAt unix seconds).
   */
  async getRewards ({ limit = 60 } = {}) {
    try {
      const [position, wallet] = await Promise.all([this.getStakedBalance(), this._address()])
      if (position.balance <= 0n) return null
      const ata = await findAta(wallet, this.pool.mint)
      const signatures = await this._rpc('getSignaturesForAddress', [ata, { limit, commitment: this._commitment }])
      let deposited = 0n
      let minted = 0n
      let first = null
      for (const s of signatures ?? []) {
        if (s.err) continue
        const tx = await this._rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', commitment: this._commitment, maxSupportedTransactionVersion: 0 }]).catch(() => null)
        const found = parseDepositSol(tx, wallet, ata)
        if (!found) continue
        deposited += found.lamports
        minted += found.minted
        if (tx.blockTime && (first === null || Number(tx.blockTime) < first)) first = Number(tx.blockTime)
      }
      if (minted === 0n) return null
      const entryRate = (deposited * LAMPORTS_PER_SOL) / minted
      const delta = position.rate - entryRate
      return { earned: delta > 0n ? (position.balance * delta) / LAMPORTS_PER_SOL : 0n, entryRate, deposited, minted, firstStakeAt: first }
    } catch {
      return null
    }
  }

  /**
   * Waits for a sent transaction to be confirmed (or reports its failure).
   *
   * @param {string} hash - The transaction signature.
   * @param {{ timeoutMs?: number, intervalMs?: number }} [options] - Polling bounds (default 90s / 2.5s).
   * @returns {Promise<'confirmed' | 'finalized'>} The reached commitment.
   */
  async awaitConfirmation (hash, { timeoutMs = 90_000, intervalMs = 2_500 } = {}) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
      let status
      try {
        const r = await this._rpc('getSignatureStatuses', [[hash]])
        status = r?.value?.[0]
      } catch {
        continue
      }
      if (!status) continue
      if (status.err) throw new Error(`Transaction ${hash} failed on-chain: ${JSON.stringify(status.err)}`)
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return status.confirmationStatus
    }
    throw new Error(`Transaction ${hash} was not confirmed within ${timeoutMs} ms.`)
  }

  // ---- Internals ----

  /** @private */
  _lessSlippage (amount) {
    return (amount * (10_000n - this._slippageBps)) / 10_000n
  }

  /**
   * The transaction message the wallet signs: compute budget first, then the
   * operation. Blockhash and fee payer are left to the account.
   *
   * @protected
   * @param {Instruction[]} instructions - The operation's instructions.
   * @returns {{ version: 0, instructions: Instruction[] }} The message.
   */
  _message (instructions) {
    return {
      version: 0,
      instructions: [ixSetComputeUnitLimit(this._computeUnitLimit), ixSetComputeUnitPrice(this._computeUnitPrice), ...instructions]
    }
  }

  /** @private */
  async _quoteFee (instructions) {
    if (typeof this._account?.quoteSendTransaction !== 'function') return 0n
    const { fee } = await this._account.quoteSendTransaction(this._message(instructions))
    return BigInt(fee ?? 0)
  }
  /**
   * Recognize SPL Stake Pool transactions offline (DepositSol → stake, WithdrawSol /
   * WithdrawStake → unstake), labelling this instance's pool and the known presets.
   * See `spl-stake-pool-activity.js` for the rule.
   *
   * @param {import('@anywalletkit/core').ChainTx} tx
   * @param {import('@anywalletkit/core').DescribeActivityContext} ctx
   * @returns {import('@anywalletkit/core').ActivityItem | null}
   */
  describeActivity (tx, ctx) {
    return describeStakePoolActivity(tx, ctx, { pool: this.pool })
  }
}

/**
 * Finds the wallet's `DepositSol` in a jsonParsed transaction: the first
 * stake-pool instruction (top-level or inner) tagged 14 / 25 whose funder is
 * the wallet and whose destination is its token account; tokens minted come
 * from the token-account balance delta of the whole transaction.
 *
 * @param {any} tx - A `getTransaction` result with `encoding: 'jsonParsed'`.
 * @param {string} wallet - The wallet.
 * @param {string} ata - Its pool-token account.
 * @returns {{ lamports: bigint, minted: bigint } | null} The deposit, or null.
 */
export function parseDepositSol (tx, wallet, ata) {
  if (!tx?.meta || tx.meta.err) return null
  const all = [...(tx.transaction?.message?.instructions ?? []), ...(tx.meta.innerInstructions ?? []).flatMap((i) => i.instructions ?? [])]
  for (const ix of all) {
    if (ix.programId !== STAKE_POOL_PROGRAM || typeof ix.data !== 'string' || !Array.isArray(ix.accounts)) continue
    const data = base58Decode(ix.data)
    if ((data[0] !== 14 && data[0] !== 25) || data.length < 9 || ix.accounts[3] !== wallet || ix.accounts[4] !== ata) continue
    const lamports = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true)
    const keys = tx.transaction.message.accountKeys ?? []
    const idx = keys.findIndex((k) => (typeof k === 'string' ? k : k.pubkey) === ata)
    const pre = BigInt(tx.meta.preTokenBalances?.find((b) => b.accountIndex === idx)?.uiTokenAmount?.amount ?? '0')
    const post = BigInt(tx.meta.postTokenBalances?.find((b) => b.accountIndex === idx)?.uiTokenAmount?.amount ?? '0')
    if (post <= pre) return null
    return { lamports, minted: post - pre }
  }
  return null

}
