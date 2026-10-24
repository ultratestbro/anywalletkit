'use strict'

import './buffer-global.js'
import { Address, beginCell } from '@ton/core'
import { TonClient } from '@ton/ton'

import StakingProtocol from './staking-protocol.js'
import TONSTAKERS_ADDRESS_MAP from './tonstakers-address-map.js'
import { describeTonstakersActivity } from './tonstakers-activity.js'

/** @typedef {import('./staking-protocol.js').StakeOptions} StakeOptions */
/** @typedef {import('./staking-protocol.js').StakeResult} StakeResult */
/** @typedef {import('./staking-protocol.js').WithdrawalRequestOptions} WithdrawalRequestOptions */
/** @typedef {import('./staking-protocol.js').WithdrawalRequestResult} WithdrawalRequestResult */
/** @typedef {import('./staking-protocol.js').WithdrawalRequestsView} WithdrawalRequestsView */
/** @typedef {import('./staking-protocol.js').ClaimWithdrawalsOptions} ClaimWithdrawalsOptions */
/** @typedef {import('./staking-protocol.js').ClaimWithdrawalsResult} ClaimWithdrawalsResult */
/** @typedef {import('./staking-protocol.js').StakedBalance} StakedBalance */

const NANO = 1_000_000_000n

/** Pool message op codes (tonstakers-sdk/src/constants.ts). */
export const OP_STAKE = 0x47d54391
export const OP_UNSTAKE = 0x595f07bc
/** GRAM attached on top of a stake; the pool refunds what it does not use. */
export const STAKE_FEE_RESERVE = 1_000_000_000n
/** Gas budget attached to an unstake (burn) message; the rest comes back. */
export const UNSTAKE_FEE_RESERVE = 1_050_000_000n
/** The pool's minimum stake (tonapi `min_stake`). */
export const MIN_STAKE = 1_000_000_000n

/**
 * The stake payload: op, query id 1, then the 64-bit partner code the pool
 * records for referral attribution. Byte-for-byte the official SDK's cell.
 *
 * @param {bigint | number} partnerCode - The partner code.
 * @returns {import('@ton/core').Cell} The message body.
 */
export function buildStakeBody (partnerCode) {
  return beginCell()
    .storeUint(OP_STAKE, 32)
    .storeUint(1, 64)
    .storeUint(BigInt(partnerCode), 64)
    .endCell()
}

/**
 * The unstake payload, sent to the account's own tsTON jetton wallet: a burn
 * with the pool's custom payload carrying the two mode bits.
 *
 *   standard → (wait_till_round_end 0, fill_or_kill 0): paid now from free
 *              liquidity when there is enough, otherwise a payout bill
 *   instant  → (0, 1): paid now or the message bounces — never a bill
 *   bestRate → (1, 0): always a bill, settled at the round-end projected rate
 *
 * @param {bigint} amount - tsTON to burn (base units).
 * @param {Address} owner - The account (response destination).
 * @param {'standard' | 'instant' | 'bestRate'} mode - The exit mode.
 * @returns {import('@ton/core').Cell} The message body.
 */
export function buildUnstakeBody (amount, owner, mode = 'standard') {
  if (!['standard', 'instant', 'bestRate'].includes(mode)) {
    throw new Error("'mode' must be 'standard', 'instant' or 'bestRate'.")
  }
  return beginCell()
    .storeUint(OP_UNSTAKE, 32)
    .storeUint(0, 64)
    .storeCoins(amount)
    .storeAddress(owner)
    .storeMaybeRef(
      beginCell()
        .storeUint(mode === 'bestRate' ? 1 : 0, 1)
        .storeUint(mode === 'instant' ? 1 : 0, 1)
        .endCell()
    )
    .endCell()
}

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
 * REST reads with a courtesy retry: keyless tonapi rate-limits bursts (a
 * screen opening fires several reads at once) and answers 429 — a silent
 * skip there hides real bills. Two short waits before giving up.
 *
 * @param {string} url - The URL.
 * @returns {Promise<Response>} The response (possibly still not ok).
 */
async function fetchWithRetry (url) {
  let res
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url)
    if (res.status !== 429) return res
    await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)))
  }
  return res
}

/** Reads the address a `cell`/`slice` stack item wraps, or null. */
function readAddressItem (reader) {
  const item = reader.peek()
  if (item.type === 'null') {
    reader.pop()
    return null
  }
  const cell = reader.readCell()
  return cell.beginParse().loadAddress()
}

/**
 * @typedef {Object} TonstakersProtocolConfig
 * @property {*} [tonClient] - A @ton/ton TonClient, a `{ url, secretKey }` config, or an array of either (tried in order). Defaults to the account's own client.
 * @property {string} [network] - TON network id: '-239' mainnet (default) or '-3' testnet.
 * @property {Object} [addresses] - Override for `{ pool, jetton }`.
 * @property {bigint | number} [partnerCode] - Referral partner code carried in stake payloads.
 * @property {Object} [endpoints] - Override for the REST endpoints `{ tonapi, withdrawalPayouts }`; set a key to null to disable that feature.
 */

/**
 * Tonstakers liquid staking for TON wallet accounts.
 *
 * Tonstakers is the largest liquid-staking pool on The Open Network: the pool
 * contract lends deposited GRAM (TON's native token, renamed from Toncoin in
 * 2026) to validators, and tsTON is the non-rebasing receipt jetton whose GRAM
 * value grows with the pool's rewards — the rate is the pool's balance over
 * the jetton supply, moving once per validation round (~18h). Staking is one
 * message to the pool; exiting is a burn of tsTON on the account's own jetton
 * wallet in one of three modes (see `buildUnstakeBody`). Standard and
 * best-rate exits that cannot be paid at once become "payout bill" NFTs the
 * pool settles by itself after the round — there is nothing to claim, which
 * is why `claimWithdrawals` refuses honestly instead of pretending.
 *
 * On-chain reads (pool data, jetton wallet, tsTON balance, free liquidity)
 * run through the account's TonClient. The payout-bill list and APY come
 * from the same off-chain indexes the official SDK reads (tonapi, Tonstakers'
 * API); they are configuration and decoration — money paths never depend on
 * them.
 */
export default class TonstakersProtocolTon extends StakingProtocol {
  /**
   * Creates a new interface to Tonstakers for TON blockchains.
   *
   * @param {*} account - The wallet account (a @anywalletkit/wallet-ton account, or a read-only one for views).
   * @param {TonstakersProtocolConfig} [config] - The protocol's configuration.
   */
  constructor (account, config = {}) {
    super(account)

    const network = String(config.network ?? '-239')
    const defaults = TONSTAKERS_ADDRESS_MAP[network]
    if (!defaults && !config.addresses?.pool) {
      throw new Error(`No default Tonstakers deployment for network ${network}: pass 'addresses' explicitly.`)
    }
    const { endpoints, partnerCode, ...addresses } = defaults ?? {}

    /** @private */
    this._network = network
    /** @private */
    this._addresses = { ...addresses, ...config.addresses }
    if (typeof this._addresses.pool !== 'string') {
      throw new Error(`'addresses.pool' is required for network ${network}.`)
    }
    /** @private */
    this._pool = Address.parse(this._addresses.pool)
    /** @private */
    this._partnerCode = BigInt(config.partnerCode ?? partnerCode ?? 0)
    /** @private */
    this._endpoints = { ...endpoints, ...config.endpoints }

    const source = config.tonClient ?? account?._tonClient ?? account?._config?.tonClient
    /** @private */
    this._clients = (Array.isArray(source) ? source : source ? [source] : [])
      .map((c) => (c instanceof TonClient ? c : new TonClient({ endpoint: c.url ?? c.endpoint, apiKey: c.secretKey ?? c.apiKey })))
  }

  /** @private */
  _requireWritable (method) {
    // A structural check, deliberately not instanceof: a duplicated copy of
    // the account package fails instanceof while the account works fine.
    if (typeof this._account?.sendTransaction !== 'function') {
      throw new Error(`The '${method}' method requires the protocol to be initialized with a non read-only account.`)
    }
  }

  /**
   * Runs a client call against each configured client until one answers.
   *
   * @private
   */
  async _withClient (fn) {
    if (this._clients.length === 0) {
      throw new Error('The protocol must be initialized with a tonClient (or an account configured with one).')
    }
    let lastError
    for (const client of this._clients) {
      try {
        return await fn(client)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }

  /**
   * A get-method that must succeed: public toncenter nodes intermittently
   * answer exit code -13 (out of gas) on the pool's heavy getter, so every
   * client gets two tries before the next one is asked.
   *
   * @private
   */
  async _runGetMethod (address, name, args = []) {
    return await this._withClient(async (client) => {
      let last
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await client.runMethodWithError(address, name, args)
        if (res.exit_code === 0) return res.stack
        last = new Error(`${name} on ${address.toString()} exited with code ${res.exit_code}`)
        last.exitCode = res.exit_code
        if (res.exit_code !== -13) break
      }
      throw last
    })
  }

  /**
   * The pool's live state from `get_pool_full_data` (stack layout verified on
   * mainnet 2026-09-04). Rates are 1e9 fixed point GRAM per tsTON.
   *
   * @returns {Promise<{ halted: boolean, depositsOpen: boolean, totalBalance: bigint, supply: bigint, jettonMinter: Address | null, withdrawalPayout: Address | null, projectedBalance: bigint, projectedSupply: bigint, rate: bigint, projectedRate: bigint }>} The pool data.
   */
  async getPoolData () {
    const s = await this._runGetMethod(this._pool, 'get_pool_full_data')
    if (s.remaining < 30) {
      throw new Error(`get_pool_full_data: unexpected stack size ${s.remaining}`)
    }
    s.readNumber() // 0 state
    const halted = s.readBoolean() // 1
    const totalBalance = s.readBigNumber() // 2
    s.skip(2) // 3 interest_rate, 4 optimistic_deposit_withdrawals
    const depositsOpen = s.readBoolean() // 5
    s.skip(6) // 6 validator set hash, 7-8 round borrowers, 9-10 loan bounds, 11 governance fee
    const jettonMinter = readAddressItem(s) // 12
    const supply = s.readBigNumber() // 13
    s.skip(2) // 14 deposit_payout, 15 requested_for_deposit
    const withdrawalPayout = readAddressItem(s) // 16
    s.skip(11) // 17 requested_for_withdrawal … 27 payout minter code
    const projectedBalance = s.readBigNumber() // 28
    const projectedSupply = s.readBigNumber() // 29
    return {
      halted,
      depositsOpen,
      totalBalance,
      supply,
      jettonMinter,
      withdrawalPayout,
      projectedBalance,
      projectedSupply,
      rate: supply > 0n ? (totalBalance * NANO) / supply : NANO,
      projectedRate: projectedSupply > 0n ? (projectedBalance * NANO) / projectedSupply : NANO
    }
  }

  /** @private */
  async _jettonMinter () {
    if (this._addresses.jetton) return Address.parse(this._addresses.jetton)
    const { jettonMinter } = await this.getPoolData()
    if (!jettonMinter) throw new Error('The pool reports no jetton minter.')
    return jettonMinter
  }

  /**
   * The account's tsTON jetton wallet, from the minter's `get_wallet_address`.
   *
   * @returns {Promise<Address>} The jetton wallet address (may not be deployed yet).
   */
  async getJettonWallet () {
    const owner = Address.parse(await this._account.getAddress())
    const minter = await this._jettonMinter()
    const s = await this._runGetMethod(minter, 'get_wallet_address', [
      { type: 'slice', cell: beginCell().storeAddress(owner).endCell() }
    ])
    return s.readAddress()
  }

  /** @private */
  async _getStakeTransaction (amount) {
    if (amount < MIN_STAKE) {
      throw new Error('Tonstakers takes at least 1 GRAM per stake.')
    }
    // Best-effort guards: the pool refuses closed/halted deposits with a
    // bounce that carries no readable reason.
    try {
      const pool = await this.getPoolData()
      if (pool.halted) throw new Error('The Tonstakers pool is halted right now.')
      if (!pool.depositsOpen) throw new Error('Tonstakers deposits are closed right now.')
    } catch (error) {
      if (/halted|closed/.test(error.message)) throw error
    }
    return {
      to: this._pool.toString({ bounceable: true }),
      value: amount + STAKE_FEE_RESERVE,
      body: buildStakeBody(this._partnerCode),
      bounceable: true
    }
  }

  /**
   * Stakes GRAM — tsTON lands on the account at the pool's rate. The message
   * carries 1 GRAM on top of `amount` for fees; the pool refunds the unused part.
   *
   * @param {StakeOptions} options - The stake's options (amount in nanotons, excluding the fee reserve).
   * @returns {Promise<StakeResult>} The stake's result.
   */
  async stake ({ amount }) {
    this._requireWritable('stake(options)')
    const value = toAmount(amount)
    const tx = await this._getStakeTransaction(value)
    const result = await this._account.sendTransaction(tx)
    return { hash: result.hash, fee: result.fee ?? 0n }
  }

  /**
   * Quotes the costs of a stake operation.
   *
   * @param {StakeOptions} options - The stake's options.
   * @returns {Promise<Omit<StakeResult, 'hash'>>} The stake's costs.
   */
  async quoteStake ({ amount }) {
    const value = toAmount(amount)
    const tx = await this._getStakeTransaction(value)
    const { fee } = await this._account.quoteSendTransaction(tx)
    return { fee }
  }

  /** @private */
  async _getUnstakeTransaction (amount, mode) {
    const owner = Address.parse(await this._account.getAddress())
    if (mode === 'instant') {
      // Fill-or-kill: refuse up front when the pool's free balance can't cover it.
      const [pool, liquidity] = await Promise.all([this.getPoolData(), this.getInstantLiquidity()])
      if ((amount * pool.rate) / NANO > liquidity) {
        throw new Error("The pool's instant liquidity can't cover this amount right now — use a standard exit or a smaller amount.")
      }
    }
    const wallet = await this.getJettonWallet()
    return {
      to: wallet.toString({ bounceable: true }),
      value: UNSTAKE_FEE_RESERVE,
      body: buildUnstakeBody(amount, owner, mode),
      bounceable: true
    }
  }

  /**
   * Burns tsTON to exit. `mode` picks the pool's exit path: 'standard'
   * (default — paid now when free liquidity allows, otherwise a payout bill),
   * 'instant' (paid now or bounces) or 'bestRate' (always a bill, settled at
   * the round-end projected rate). `token` is accepted for interface parity
   * and ignored: tsTON is the only staked form.
   *
   * @param {WithdrawalRequestOptions & { mode?: 'standard' | 'instant' | 'bestRate' }} options - The request's options (amount in tsTON base units).
   * @returns {Promise<WithdrawalRequestResult>} The request's result (`approveHash` is always null — a burn needs no approval).
   */
  async requestWithdrawal ({ amount, mode = 'standard' }) {
    this._requireWritable('requestWithdrawal(options)')
    const value = toAmount(amount)
    const tx = await this._getUnstakeTransaction(value, mode)
    const result = await this._account.sendTransaction(tx)
    return { hash: result.hash, fee: result.fee ?? 0n, approveHash: null }
  }

  /**
   * Quotes the costs of an exit.
   *
   * @param {WithdrawalRequestOptions & { mode?: 'standard' | 'instant' | 'bestRate' }} options - The request's options.
   * @returns {Promise<Omit<WithdrawalRequestResult, 'hash' | 'approveHash'>>} The request's costs.
   */
  async quoteRequestWithdrawal ({ amount, mode = 'standard' }) {
    const value = toAmount(amount)
    const tx = await this._getUnstakeTransaction(value, mode)
    const { fee } = await this._account.quoteSendTransaction(tx)
    return { fee }
  }

  /**
   * The account's open payout bills — exits waiting for their round. Bills
   * are NFTs in the pool's payout collection (on-chain: `withdrawal_payout`)
   * plus any closing round Tonstakers' API still lists, read through tonapi's
   * NFT index; with `endpoints.tonapi` disabled this returns an empty view. Nothing here is ever claimable:
   * the pool settles bills by itself after the round, so `claimableIds`
   * stays empty and `timestamp` is the round's start. `roundEnd` /
   * `estimatedPayout` are 0 while the round is closing (settlement is
   * minutes away then).
   *
   * @returns {Promise<WithdrawalRequestsView & { requests: (import('./staking-protocol.js').WithdrawalRequest & { nft: string, roundEnd: number, estimatedPayout: number })[] }>} The queue view.
   */
  async getWithdrawalRequests () {
    const empty = { requests: [], pendingAmount: 0n, claimableAmount: 0n, claimableIds: [] }
    const { tonapi, withdrawalPayouts } = this._endpoints
    if (!tonapi) return empty
    const owner = Address.parse(await this._account.getAddress()).toRawString()

    // Which collections hold bills: the pool's current payout collection is
    // the on-chain truth; Tonstakers' API adds the round timing and any
    // collection from a round that closed but hasn't settled yet. The API
    // routinely lists nothing between a round closing and its settlement —
    // bills still exist then, so the on-chain collection is never optional.
    const collections = new Map()
    try {
      const pool = await this.getPoolData()
      if (pool.withdrawalPayout) collections.set(pool.withdrawalPayout.toRawString(), { cycleStart: 0, cycleEnd: 0 })
    } catch {}
    if (withdrawalPayouts) {
      try {
        const res = await fetchWithRetry(withdrawalPayouts)
        if (res.ok) {
          const body = await res.json()
          for (const col of body?.data?.active_collections ?? []) {
            const key = Address.parse(col.withdrawal_payout).toRawString()
            collections.set(key, { cycleStart: Number(col.cycle_start ?? 0), cycleEnd: Number(col.cycle_end ?? 0) })
          }
        }
      } catch {}
    }
    if (collections.size === 0) return empty

    // No timing fallback on purpose: tonapi's pool "cycle" is the validator
    // election cycle, not the payout round — seen live, it pointed a day out
    // while the bills settled 14 minutes after the API's cycle_end. When the
    // API lists nothing for a collection the round is closing and bills
    // settle within minutes; `roundEnd` 0 says exactly that.

    const requests = []
    for (const [collection, timing] of collections) {
      const roundStart = timing.cycleStart || 0
      const roundEnd = timing.cycleEnd || 0
      try {
        const res = await fetchWithRetry(`${tonapi}/accounts/${owner}/nfts?collection=${collection}&limit=100`)
        if (!res.ok) continue
        const body = await res.json()
        for (const item of body?.nft_items ?? []) {
          const m = String(item.metadata?.name ?? '').match(/([\d.]+)/)
          const amount = m ? BigInt(Math.round(Number.parseFloat(m[1]) * 1e9)) : 0n
          requests.push({
            id: BigInt(item.index ?? requests.length),
            amount,
            timestamp: roundStart,
            claimable: false,
            nft: item.address,
            roundEnd,
            // The SDK's estimate: round end plus ~10 minutes of settlement.
            estimatedPayout: roundEnd ? roundEnd + 10 * 60 : 0
          })
        }
      } catch {}
    }
    requests.sort((a, b) => a.roundEnd - b.roundEnd)
    return {
      requests,
      pendingAmount: requests.reduce((a, r) => a + r.amount, 0n),
      claimableAmount: 0n,
      claimableIds: []
    }
  }

  /**
   * Not applicable: the pool settles payout bills by itself after the round.
   *
   * @param {ClaimWithdrawalsOptions} [options] - Ignored.
   * @returns {Promise<never>} Always rejects.
   */
  async claimWithdrawals (options) { // eslint-disable-line no-unused-vars
    throw new Error('Tonstakers settles payout bills automatically after the round — there is nothing to claim.')
  }

  /**
   * Not applicable, see `claimWithdrawals`.
   *
   * @param {ClaimWithdrawalsOptions} [options] - Ignored.
   * @returns {Promise<never>} Always rejects.
   */
  async quoteClaimWithdrawals (options) { // eslint-disable-line no-unused-vars
    throw new Error('Tonstakers settles payout bills automatically after the round — there is nothing to claim.')
  }

  /**
   * The account's tsTON position. `rate` is GRAM per tsTON (1e9 fixed point)
   * and `total` the position valued in GRAM at that rate — the one honest
   * deviation from the interface wording, where `total` is "in primary
   * staked tokens": for a non-rebasing receipt the GRAM value is the figure
   * that means anything.
   *
   * @returns {Promise<StakedBalance>} The staked balances.
   */
  async getStakedBalance () {
    const [balance, pool] = await Promise.all([this.getTokenBalance(), this.getPoolData()])
    return { balance, wrappedBalance: 0n, rate: pool.rate, total: (balance * pool.rate) / NANO }
  }

  /**
   * tsTON held by the account (0 when its jetton wallet is not deployed yet).
   *
   * @returns {Promise<bigint>} tsTON in base units.
   */
  async getTokenBalance () {
    const wallet = await this.getJettonWallet()
    try {
      const s = await this._runGetMethod(wallet, 'get_wallet_data')
      return s.readBigNumber()
    } catch (error) {
      if (error?.exitCode !== undefined || /exited with code/.test(String(error?.message))) return 0n
      throw error
    }
  }

  /**
   * Current APY in percent, from tonapi's staking pool view — the figure
   * Tonstakers shows.
   *
   * @returns {Promise<number>} The APY.
   */
  async getApr () {
    if (!this._endpoints.tonapi) {
      throw new Error('APY needs endpoints.tonapi.')
    }
    const res = await fetchWithRetry(`${this._endpoints.tonapi}/staking/pool/${this._pool.toString()}`)
    if (!res.ok) {
      throw new Error(`tonapi staking pool: HTTP ${res.status}`)
    }
    const body = await res.json()
    const apy = body?.pool?.apy
    if (typeof apy !== 'number') {
      throw new Error('tonapi staking pool: unexpected response shape.')
    }
    return apy
  }

  // ---- Tonstakers-specific extras (not part of the proposed staking interface) ----

  /**
   * GRAM the pool holds free — what instant exits are paid from.
   *
   * @returns {Promise<bigint>} nanotons.
   */
  async getInstantLiquidity () {
    return await this._withClient((client) => client.getBalance(this._pool))
  }

  /**
   * GRAM per tsTON now and after the current round (1e9 fixed point).
   *
   * @returns {Promise<{ rate: bigint, projectedRate: bigint }>} The rates.
   */
  async getRates () {
    const { rate, projectedRate } = await this.getPoolData()
    return { rate, projectedRate }
  }

  /**
   * What the position has earned. tsTON never changes count, only its GRAM
   * value, so the honest figure is (rate now − the account's weighted entry
   * rate) × tsTON held; entry rates come from the account's own DepositStake
   * events (GRAM in and tsTON minted in the same event) through tonapi.
   * Decoration: null when the index is unavailable or nothing was staked.
   *
   * @returns {Promise<{ earned: bigint, entryRate: bigint, deposited: bigint, minted: bigint, firstStakeAt: number | null } | null>} Earnings (nanotons; rates 1e9 fixed; firstStakeAt unix seconds).
   */
  async getRewards () {
    if (!this._endpoints.tonapi) return null
    try {
      const owner = Address.parse(await this._account.getAddress()).toRawString()
      const [res, minter, position] = await Promise.all([
        fetch(`${this._endpoints.tonapi}/accounts/${owner}/events?limit=100`),
        this._jettonMinter(),
        this.getStakedBalance()
      ])
      if (!res.ok) return null
      const body = await res.json()
      const minterRaw = minter.toRawString()
      let deposited = 0n
      let minted = 0n
      let first = null
      for (const event of body?.events ?? []) {
        const dep = event.actions?.find((a) => a.type === 'DepositStake')?.DepositStake
        const mint = event.actions?.find((a) => a.type === 'JettonMint' && a.JettonMint?.jetton?.address === minterRaw)?.JettonMint
        if (!dep || !mint) continue
        deposited += BigInt(String(dep.amount))
        minted += BigInt(String(mint.amount))
        if (first === null || event.timestamp < first) first = event.timestamp
      }
      if (minted === 0n) return null
      const entryRate = (deposited * NANO) / minted
      const delta = position.rate - entryRate
      return {
        earned: delta > 0n ? (position.balance * delta) / NANO : 0n,
        entryRate,
        deposited,
        minted,
        firstStakeAt: first
      }
    } catch {
      return null
    }
  }

  /**
   * Recognize this deployment's Tonstakers transactions offline: a stake message to
   * the pool, a tsTON burn (unstake request), a withdrawal payout from the pool.
   * See `tonstakers-activity.js` for the rule.
   *
   * @param {import('@anywalletkit/core').ChainTx} tx
   * @param {import('@anywalletkit/core').DescribeActivityContext} ctx
   * @returns {import('@anywalletkit/core').ActivityItem | null}
   */
  describeActivity (tx, ctx) {
    return describeTonstakersActivity(tx, ctx, { network: this._network, addresses: this._addresses })
  }
}
