import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { InsufficientFundsError, ReadOnlyAccountError } from '@anywalletkit/core'
import { createMockAccount } from '@anywalletkit/conformance'
import { WalletAccountReadOnlyNear, type NearTransaction } from '@anywalletkit/wallet-near'
import {
  DEFAULT_RESERVE, LiquidStakingError, assertLiquidPlan, LiquidStakingProtocolNear, MIN_STAKE, TGAS, epochStartsAt, poolRequestId, resolvePool, sameTransactions,
  type LiquidStakingErrorCode, type LiquidStakingNearConfig,
} from '../src/index.js'
import { ALICE, EPOCH, FakeNear, LINEAR, NEAR, RNEAR, RNEAR_HASH } from './fake-near.js'

const ACCOUNT_FEE = 3_000_000_000_000_000_000n

function setup(o: { config?: Partial<LiquidStakingNearConfig>; node?: FakeNear; chain?: string } = {}) {
  const node = o.node ?? new FakeNear()
  const account = createMockAccount({ chain: o.chain ?? 'near:mainnet', address: ALICE, fee: ACCOUNT_FEE })
  const p = new LiquidStakingProtocolNear(account, { pool: 'linear', provider: node.fetch, archivalProvider: node.fetch, ...o.config } as LiquidStakingNearConfig)
  const sent = () => account.sent as NearTransaction[]
  return { p, node, account, sent }
}

const refusal = (code: LiquidStakingErrorCode) => (e: unknown) => e instanceof LiquidStakingError && e.code === code

/** Every transaction the module builds: function calls only, to the pinned contract, from the staking set. Never an FT transfer. */
function assertSafe(txs: NearTransaction[], contract: string = LINEAR) {
  for (const tx of txs) {
    expect(tx.receiverId).toBe(contract)
    expect(tx).not.toHaveProperty('signerId')
    for (const a of tx.actions) {
      expect(Object.keys(a)).toEqual(['functionCall'])
      const f = (a as { functionCall: { methodName: string; args: unknown; gas: bigint; deposit: bigint } }).functionCall
      expect(['deposit_and_stake', 'unstake', 'unstake_all', 'withdraw_all']).toContain(f.methodName)
      expect(typeof f.gas).toBe('bigint')
      expect(typeof f.deposit).toBe('bigint')
      expect(f.args !== null && typeof f.args === 'object' && !Array.isArray(f.args)).toBe(true)
    }
  }
}

const gasOf = (txs: NearTransaction[]) => txs.reduce((s, t) => s + WalletAccountReadOnlyNear.gasOf(t.actions, false), 0n)
/** The fee model: gas × (gas price + 10 %), the margin wallet-near's own estimate uses. */
const feeOf = (txs: NearTransaction[], gasPrice: bigint) => gasOf(txs) * ((gasPrice * 11n) / 10n)
/** What the node holds back on acceptance: all gas bought at min_gas_purchase_price (10^9 on mainnet). */
const PURCHASE_PRICE = 1_000_000_000n
const upfrontOf = (txs: NearTransaction[]) => gasOf(txs) * PURCHASE_PRICE
const EXIT_RESERVE = upfrontOf([{ receiverId: LINEAR, actions: [{ functionCall: { methodName: 'unstake', args: { amount: '9'.repeat(39) }, gas: 30n * TGAS, deposit: 0n } }] }])
/** LiNEAR's storage on mainnet (13.35 MB): what the contract must keep beside its payouts. */
const LINEAR_KEPT = 13_347_387n * 10n ** 19n

describe('config', () => {
  const near = (chain = 'near:mainnet') => createMockAccount({ chain, address: ALICE })

  it('requires a known preset or a pinned custom contract', () => {
    expect(() => new LiquidStakingProtocolNear(near(), {} as never)).toThrow(LiquidStakingError)
    expect(() => new LiquidStakingProtocolNear(near(), undefined as never)).toThrow(/needs a config/)
    expect(() => new LiquidStakingProtocolNear(near(), { pool: 'stnear' as never })).toThrow(/Unknown pool/)
    expect(() => new LiquidStakingProtocolNear(near(), { pool: { contract: 'x.near', symbol: 'X', codeHashes: [] } })).toThrow(/codeHashes/)
    expect(() => new LiquidStakingProtocolNear(near(), { pool: { contract: 'Not An Id', symbol: 'X', codeHashes: ['h'] } })).toThrow(/account id/)
    expect(new LiquidStakingProtocolNear(near(), { pool: 'rnear' }).pool.contract).toBe(RNEAR)
  })

  it('refuses bad numbers', () => {
    expect(() => new LiquidStakingProtocolNear(near(), { pool: 'linear', network: 'devnet' as never })).toThrow(/network/)
    expect(() => new LiquidStakingProtocolNear(near(), { pool: 'linear', reserve: -1n })).toThrow(/reserve/)
    expect(() => new LiquidStakingProtocolNear(near(), { pool: 'linear', reserve: 0.5 })).toThrow(/reserve/)
    expect(() => new LiquidStakingProtocolNear(near(), { pool: 'linear', gas: { stake: 0n } })).toThrow(/gas.stake/)
    expect(() => new LiquidStakingProtocolNear(near(), { pool: 'linear', gas: { unstake: 301n * TGAS } })).toThrow(/gas.unstake/)
    expect(() => new LiquidStakingProtocolNear(near(), { pool: 'linear', aprWindowEpochs: 0 })).toThrow(/aprWindowEpochs/)
    expect(() => new LiquidStakingProtocolNear(near(), { pool: 'linear', apr: 4.5 as never })).toThrow(/apr must be a function/)
  })

  it('defaults: 0.02 NEAR reserve, 30 Tgas per call, 24-epoch APR window', () => {
    const p = new LiquidStakingProtocolNear(near(), { pool: 'linear' })
    expect(p.reserve).toBe(DEFAULT_RESERVE)
    expect(DEFAULT_RESERVE).toBe(2n * 10n ** 22n)
    expect(p.gas).toEqual({ stake: 30n * TGAS, unstake: 30n * TGAS, withdraw: 30n * TGAS })
    expect(() => new LiquidStakingProtocolNear(near(), { pool: 'linear', gas: { unstake: 200n * TGAS, withdraw: 101n * TGAS } })).toThrow(/one transaction/)
    expect(p.aprWindowEpochs).toBe(24)
  })

  it('resolves presets per network; rNEAR has no testnet contract', () => {
    expect(resolvePool('linear', 'mainnet').contract).toBe('linear-protocol.near')
    expect(resolvePool('linear', 'testnet').contract).toBe('linear-protocol.testnet')
    expect(() => resolvePool('rnear', 'testnet')).toThrow(/no contract on NEAR testnet/)
    expect(new LiquidStakingProtocolNear(near('near:testnet'), { pool: 'linear' }).pool.contract).toBe('linear-protocol.testnet')
    expect(new LiquidStakingProtocolNear(near('near:testnet'), { pool: 'linear' }).network).toBe('testnet')
    expect(new LiquidStakingProtocolNear(near('eip155:1'), { pool: 'linear' }).network).toBe('mainnet')
  })

  it('never touches the network in the constructor, on any chain', () => {
    const node = new FakeNear()
    new LiquidStakingProtocolNear(createMockAccount(), { pool: 'rnear', provider: node.fetch })
    new LiquidStakingProtocolNear(near('near:testnet'), { pool: 'rnear', provider: node.fetch })
    expect(node.calls).toEqual([])
  })
})

describe('plan guard', () => {
  const fcall = (methodName: string) => ({ functionCall: { methodName, args: {}, gas: 30n * TGAS, deposit: 1n } })
  it('refuses ft_transfer_call / ft_transfer to the contract, other receivers, other action kinds, a signerId', () => {
    expect(() => assertLiquidPlan([{ receiverId: LINEAR, actions: [fcall('deposit_and_stake'), fcall('withdraw_all')] }], LINEAR)).not.toThrow()
    expect(() => assertLiquidPlan([{ receiverId: LINEAR, actions: [fcall('ft_transfer_call')] }], LINEAR)).toThrow(/no ft_on_transfer/)
    expect(() => assertLiquidPlan([{ receiverId: LINEAR, actions: [fcall('ft_transfer')] }], LINEAR)).toThrow(/Refusing ft_transfer/)
    expect(() => assertLiquidPlan([{ receiverId: LINEAR, actions: [fcall('storage_unregister')] }], LINEAR)).toThrow(/Refusing storage_unregister/)
    expect(() => assertLiquidPlan([{ receiverId: 'meta-pool.near', actions: [fcall('deposit_and_stake')] }], LINEAR)).toThrow(/meta-pool.near/)
    expect(() => assertLiquidPlan([{ receiverId: LINEAR, actions: [{ transfer: { deposit: 1n } }] }], LINEAR)).toThrow(/transfer action/)
    expect(() => assertLiquidPlan([{ receiverId: LINEAR, signerId: 'eve.near', actions: [fcall('unstake_all')] }], LINEAR)).toThrow(/signerId/)
  })
})

describe('poolRequestId', () => {
  it('is the first 8 bytes of sha256(contract) as a u64', () => {
    for (const c of [LINEAR, RNEAR]) expect(poolRequestId(c)).toBe(BigInt(`0x${createHash('sha256').update(c).digest('hex').slice(0, 16)}`))
    expect(poolRequestId(LINEAR)).not.toBe(poolRequestId(RNEAR))
  })
})

describe('network, chain, provider', () => {
  it("refuses an account on another chain with 'wrong-chain'; network reads still work", async () => {
    const { p } = setup({ chain: 'eip155:1' })
    await expect(p.getStakedBalance()).rejects.toSatisfy(refusal('wrong-chain'))
    await expect(p.quoteStake({ amount: NEAR })).rejects.toSatisfy(refusal('wrong-chain'))
    expect((await p.getPoolInfo()).contract).toBe(LINEAR)
  })

  it("a testnet account against a mainnet-pinned module is 'wrong-chain'", async () => {
    const { p } = setup({ chain: 'near:testnet', config: { network: 'mainnet' } })
    await expect(p.getAccountDetails()).rejects.toSatisfy(refusal('wrong-chain'))
  })

  it("rNEAR on testnet is 'unsupported-network'", async () => {
    const node = new FakeNear({ contract: RNEAR, codeHash: RNEAR_HASH, symbol: 'rNEAR' })
    const { p } = setup({ node, chain: 'near:testnet', config: { pool: 'rnear' } })
    expect(() => p.pool).toThrow(LiquidStakingError)
    await expect(p.quoteStake({ amount: NEAR })).rejects.toSatisfy(refusal('unsupported-network'))
    await expect(p.getPoolInfo()).rejects.toSatisfy(refusal('unsupported-network'))
  })

  it("without a provider every read refuses with 'no-provider'", async () => {
    const p = new LiquidStakingProtocolNear(createMockAccount({ chain: 'near:mainnet', address: ALICE }), { pool: 'linear' })
    await expect(p.getPoolInfo()).rejects.toSatisfy(refusal('no-provider'))
    await expect(p.getEpoch()).rejects.toSatisfy(refusal('no-provider'))
    await expect(p.quoteStake({ amount: NEAR })).rejects.toSatisfy(refusal('no-provider'))
  })

  it('writes on a read-only account throw ReadOnlyAccountError before any read', async () => {
    const node = new FakeNear()
    const p = new LiquidStakingProtocolNear(createMockAccount({ chain: 'near:mainnet', address: ALICE }).toReadOnlyAccount(), { pool: 'linear', provider: node.fetch })
    await expect(p.stake({ amount: NEAR })).rejects.toBeInstanceOf(ReadOnlyAccountError)
    await expect(p.requestWithdrawal({ amount: 'all' })).rejects.toBeInstanceOf(ReadOnlyAccountError)
    await expect(p.claimWithdrawals()).rejects.toBeInstanceOf(ReadOnlyAccountError)
    expect(node.calls).toEqual([])
  })
})

describe('contract checks: pinned code, pause flag', () => {
  it('an unknown code hash refuses every write (exits included)', async () => {
    const { p, node, sent } = setup()
    node.stakeFor(ALICE, 10n * NEAR)
    node.unstakedFor(ALICE, NEAR, 1n)
    node.codeHash = 'EvilEvilEvilEvilEvilEvilEvilEvilEvilEvilEvil'
    expect((await p.getPoolInfo()).codeHashKnown).toBe(false)
    await expect(p.quoteStake({ amount: NEAR })).rejects.toSatisfy(refusal('unknown-contract-code'))
    await expect(p.stake({ amount: NEAR })).rejects.toSatisfy(refusal('unknown-contract-code'))
    await expect(p.quoteRequestWithdrawal({ amount: 'all' })).rejects.toSatisfy(refusal('unknown-contract-code'))
    await expect(p.claimWithdrawals()).rejects.toSatisfy(refusal('unknown-contract-code'))
    expect(sent()).toEqual([])
  })

  it('a custom family contract is accepted with its own pin, and refused once its code changes', async () => {
    const node = new FakeNear({ contract: 'lst.example.near', codeHash: 'CustomHash111', symbol: 'xNEAR' })
    const { p } = setup({ node, config: { pool: { contract: 'lst.example.near', symbol: 'xNEAR', name: 'Example', codeHashes: ['CustomHash111'] } } })
    const q = await p.quoteStake({ amount: NEAR })
    assertSafe(q.transactions, 'lst.example.near')
    node.codeHash = 'CustomHash222'
    await expect(p.quoteStake({ amount: NEAR })).rejects.toSatisfy(refusal('unknown-contract-code'))
  })

  it("is_paused true, missing, panicking or not a boolean: 'contract-paused' on every write", async () => {
    for (const paused of [true, 'missing', 'panics', 'garbage'] as const) {
      const { p, node } = setup()
      node.stakeFor(ALICE, 10n * NEAR)
      node.unstakedFor(ALICE, NEAR, 1n)
      node.paused = paused
      expect((await p.getPoolInfo()).paused, String(paused)).toBe(true)
      await expect(p.quoteStake({ amount: NEAR })).rejects.toSatisfy(refusal('contract-paused'))
      await expect(p.quoteRequestWithdrawal({ amount: 'all' })).rejects.toSatisfy(refusal('contract-paused'))
      await expect(p.quoteClaimWithdrawals()).rejects.toSatisfy(refusal('contract-paused'))
    }
  })

  it('a transport failure on is_paused is thrown, never read as "not paused" or "paused"', async () => {
    const { p, node } = setup()
    node.failing.add('is_paused')
    await expect(p.getPoolInfo()).rejects.toThrow(/fetch failed/)
    await expect(p.quoteStake({ amount: NEAR })).rejects.toThrow(/fetch failed/)
  })

  it('pool info: price, totals, liquidity, fee from the beneficiaries', async () => {
    const { p, node } = setup()
    node.beneficiaries = { 'a.near': 600, 'b.near': 100 }
    const info = await p.getPoolInfo()
    expect(info).toMatchObject({ contract: LINEAR, symbol: 'LINEAR', name: 'LiNEAR', decimals: 24, price: node.price, totalStaked: node.totalStaked, totalShares: node.totalShares, validators: 448, paused: false, codeHashKnown: true, liquidity: node.liquidity, feeBps: 700 })
    expect(info.price).toBe(1_430_129_795_786_449_767_244_775n)
  })
})

describe('stake', () => {
  it('one transaction: deposit_and_stake with the exact amount, 30 Tgas, no storage step', async () => {
    const { p, node } = setup()
    const q = await p.quoteStake({ amount: 7n * NEAR })
    expect(q.transactions).toEqual([{ receiverId: LINEAR, actions: [{ functionCall: { methodName: 'deposit_and_stake', args: {}, gas: 30n * TGAS, deposit: 7n * NEAR } }] }])
    assertSafe(q.transactions)
    expect(q).toMatchObject({ amount: 7n * NEAR, price: node.price, warnings: [], reserve: EXIT_RESERVE })
    expect(q).not.toHaveProperty('storageDeposit')
    expect(q.shares).toBe((7n * NEAR * node.totalShares) / node.totalStaked)
    expect(q.fee).toBe(feeOf(q.transactions, node.gasPrice))
    expect(q.upfront).toBe(upfrontOf(q.transactions))
    expect(typeof q.apr).toBe('number')
  })

  it('the account gets a copy: one that rewrites what it is handed cannot change the result the app holds', async () => {
    const { p, account } = setup()
    const send = account.sendTransaction.bind(account)
    account.sendTransaction = async (tx, o) => {
      const t = tx as NearTransaction
      ;(t.actions[0] as { functionCall: { deposit: bigint } }).functionCall.deposit = 1n
      t.receiverId = 'evil.near'
      return send(tx, o)
    }
    const r = await p.stake({ amount: NEAR })
    expect(r.transactions).toEqual([{ receiverId: LINEAR, actions: [{ functionCall: { methodName: 'deposit_and_stake', args: {}, gas: 30n * TGAS, deposit: NEAR } }] }])
  })

  it('registered or not, the transaction is the same (deposit creates the account entry)', async () => {
    const a = setup(), b = setup()
    b.node.account(ALICE).registered = true
    const [qa, qb] = await Promise.all([a.p.quoteStake({ amount: NEAR }), b.p.quoteStake({ amount: NEAR })])
    expect(sameTransactions(qa.transactions, qb.transactions)).toBe(true)
    expect((await a.p.getAccountDetails()).registered).toBe(false)
    expect((await b.p.getAccountDetails()).registered).toBe(true)
  })

  it('an account that already held 1000 NEAR stakes exactly the amount asked, never the balance', async () => {
    const { p, node, sent } = setup()
    node.balances.set(ALICE, { amount: 1000n * NEAR, locked: 0n, storage: 182n })
    const amount = 730_000_000_000_000_000_000_000n // the 0.73 NEAR a swap delivered
    const r = await p.stake({ amount })
    expect(sent()).toHaveLength(1)
    expect((sent()[0]!.actions[0] as { functionCall: { deposit: bigint } }).functionCall.deposit).toBe(amount)
    expect(r.amount).toBe(amount)
  })

  it('funds: amount + upfront gas + reserve must fit the spendable balance (amount − locked − storage)', async () => {
    const { p, node } = setup()
    const quote = await p.quoteStake({ amount: NEAR })
    const storage = 182n * 10n ** 19n
    // Exactly enough: passes.
    node.balances.set(ALICE, { amount: NEAR + quote.upfront + EXIT_RESERVE + storage, locked: 0n, storage: 182n })
    expect((await p.quoteStake({ amount: NEAR })).maxStakeable).toBe(NEAR)
    expect(await p.getMaxStakeable()).toBe(NEAR)
    // One yocto short: refused with the numbers.
    node.balances.set(ALICE, { amount: NEAR + quote.upfront + EXIT_RESERVE + storage - 1n, locked: 0n, storage: 182n })
    const e = await p.quoteStake({ amount: NEAR }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(InsufficientFundsError)
    expect(e).toMatchObject({ required: NEAR + quote.upfront + EXIT_RESERVE, available: NEAR + quote.upfront + EXIT_RESERVE - 1n })
    // The default 0.02 NEAR reserve could not buy the 30 Tgas an unstake needs at 10^9: the floor is that unstake.
    expect(DEFAULT_RESERVE).toBeLessThan(EXIT_RESERVE)
    expect(EXIT_RESERVE).toBeGreaterThanOrEqual(30n * TGAS * PURCHASE_PRICE)
    // Locked (staked) NEAR is not spendable.
    node.balances.set(ALICE, { amount: 5n * NEAR, locked: 5n * NEAR, storage: 182n })
    await expect(p.quoteStake({ amount: 4n * NEAR })).rejects.toBeInstanceOf(InsufficientFundsError)
  })

  it('a missing account has nothing to stake', async () => {
    const { p, node } = setup()
    node.balances.delete(ALICE)
    expect(await p.getMaxStakeable()).toBe(0n)
    await expect(p.quoteStake({ amount: NEAR })).rejects.toBeInstanceOf(InsufficientFundsError)
  })

  it('amount checks: positive bigint or safe integer, at least 0.001 NEAR', async () => {
    const { p } = setup()
    for (const amount of [0n, -1n, 1.5, Number.MAX_SAFE_INTEGER + 2, 'all', '5'] as unknown[]) {
      await expect(p.quoteStake({ amount } as never)).rejects.toSatisfy(refusal('invalid-amount'))
    }
    await expect(p.quoteStake({ amount: MIN_STAKE - 1n })).rejects.toSatisfy(refusal('below-minimum'))
    await expect(p.quoteStake({ amount: MIN_STAKE })).resolves.toMatchObject({ amount: MIN_STAKE })
  })

  it('sends exactly the quoted transactions, once', async () => {
    const { p, sent } = setup()
    const q = await p.quoteStake({ amount: 2n * NEAR })
    const r = await p.stake({ amount: 2n * NEAR, expected: q.transactions })
    expect(sameTransactions(q.transactions, sent())).toBe(true)
    expect(r).toMatchObject({ hash: r.hashes[0], fee: ACCOUNT_FEE })
    expect(r.hashes).toHaveLength(1)
  })

  it("'quote-changed' when the fresh plan differs from `expected`, and nothing is sent", async () => {
    const { p, sent } = setup()
    const q = await p.quoteStake({ amount: 2n * NEAR })
    const e = await p.stake({ amount: 3n * NEAR, expected: q.transactions }).catch((x: unknown) => x)
    expect(e).toSatisfy(refusal('quote-changed'))
    expect(((e as LiquidStakingError).details?.transactions as NearTransaction[])[0]!.actions).toHaveLength(1)
    expect(sent()).toEqual([])
  })

  it('a failed send carries the hashes already sent (none for one transaction)', async () => {
    const { p, account } = setup()
    account.sendTransaction = async () => { throw new Error('user rejected') }
    const e = await p.stake({ amount: NEAR }).catch((x: unknown) => x)
    expect(e).toMatchObject({ message: 'user rejected', sent: [] })
  })

  it('the APR in the quote is null when it cannot be read; the stake still quotes', async () => {
    const { p, node } = setup({ config: { archivalProvider: async () => { throw new Error('archival down') } } })
    node.prunedBelow = node.head - 10n
    expect((await p.quoteStake({ amount: NEAR })).apr).toBeNull()
  })
})

describe('unstake', () => {
  it('a partial amount is in token units; the contract gets their NEAR value (burns at most that many tokens)', async () => {
    const { p, node } = setup()
    node.stakeFor(ALICE, 100n * NEAR)
    const tokens = 10n * NEAR
    const q = await p.quoteRequestWithdrawal({ amount: tokens })
    const nearValue = (tokens * node.totalStaked) / node.totalShares
    expect(q.transactions).toEqual([{ receiverId: LINEAR, actions: [{ functionCall: { methodName: 'unstake', args: { amount: String(nearValue) }, gas: 30n * TGAS, deposit: 0n } }] }])
    assertSafe(q.transactions)
    expect(q).toMatchObject({ shares: tokens, amount: nearValue, id: poolRequestId(LINEAR), withdrawsFirst: 0n, resetsTimer: false, relocks: 0n })
    // internal.rs: shares burnt = ceil(amount × totalShares / totalStaked) ≤ the tokens asked.
    const burnt = (nearValue * node.totalShares + node.totalStaked - 1n) / node.totalStaked
    expect(burnt <= tokens).toBe(true)
    expect(nearValue).toBeGreaterThan(14n * NEAR) // 1 LINEAR ≈ 1.43 NEAR
  })

  it("'all', or the whole balance as a number, is unstake_all", async () => {
    const { p, node } = setup()
    node.stakeFor(ALICE, 50n * NEAR)
    const shares = node.account(ALICE).shares
    for (const amount of ['all', shares] as const) {
      const q = await p.quoteRequestWithdrawal({ amount })
      expect(q.transactions[0]!.actions).toEqual([{ functionCall: { methodName: 'unstake_all', args: {}, gas: 30n * TGAS, deposit: 0n } }])
      expect(q.shares).toBe(shares)
      expect(q.amount).toBe((shares * node.totalStaked) / node.totalShares)
    }
  })

  it("refuses more than the balance ('exceeds-balance') and an empty position ('nothing-staked')", async () => {
    const { p, node } = setup()
    await expect(p.quoteRequestWithdrawal({ amount: 'all' })).rejects.toSatisfy(refusal('nothing-staked'))
    node.stakeFor(ALICE, NEAR)
    await expect(p.quoteRequestWithdrawal({ amount: node.account(ALICE).shares + 1n })).rejects.toSatisfy(refusal('exceeds-balance'))
    await expect(p.quoteRequestWithdrawal({ amount: 0n })).rejects.toSatisfy(refusal('invalid-amount'))
    // One token base unit is worth one yoctoNEAR at a price above 1: still a valid unstake.
    expect((await p.quoteRequestWithdrawal({ amount: 1n })).amount).toBe(1n)
  })

  it('an unlocked balance the contract can pay goes out first: [withdraw_all, unstake] in one transaction', async () => {
    const { p, node } = setup()
    node.stakeFor(ALICE, 20n * NEAR)
    node.unstakedFor(ALICE, 3n * NEAR, EPOCH - 1n)
    const q = await p.quoteRequestWithdrawal({ amount: NEAR })
    expect(q.transactions).toHaveLength(1)
    expect(q.transactions[0]!.actions.map((a) => (a as { functionCall: { methodName: string } }).functionCall.methodName)).toEqual(['withdraw_all', 'unstake'])
    expect(q.withdrawsFirst).toBe(3n * NEAR)
    expect(q.warnings.map((w) => w.code)).toEqual(['withdraws-unlocked-first', 'unlock-may-be-later'])
    assertSafe(q.transactions)
    expect(q.fee).toBe(feeOf(q.transactions, node.gasPrice))
    expect(q.upfront).toBe(upfrontOf(q.transactions))
  })

  it("an unlocked balance the contract cannot pay yet: 'relock-refused', or relocks with allowRelock", async () => {
    const { p, node, sent } = setup()
    node.stakeFor(ALICE, 20n * NEAR)
    node.unstakedFor(ALICE, 3n * NEAR, EPOCH)
    node.liquidity = 3n * NEAR // − what the contract keeps < 3 NEAR
    await expect(p.quoteRequestWithdrawal({ amount: 'all' })).rejects.toSatisfy(refusal('relock-refused'))
    await expect(p.requestWithdrawal({ amount: 'all' })).rejects.toSatisfy(refusal('relock-refused'))
    expect(sent()).toEqual([])
    const q = await p.quoteRequestWithdrawal({ amount: 'all', allowRelock: true })
    expect(q.transactions[0]!.actions).toHaveLength(1)
    expect(q).toMatchObject({ relocks: 3n * NEAR, withdrawsFirst: 0n })
    expect(q.warnings.map((w) => w.code)).toContain('relocks-unlocked')
    // Exactly what it keeps plus the balance: payable.
    node.liquidity = LINEAR_KEPT + 3n * NEAR
    expect((await p.quoteRequestWithdrawal({ amount: 'all' })).withdrawsFirst).toBe(3n * NEAR)
  })

  it("the contract's storage cost is kept too, not just 1 NEAR: a payout that would leave it below is not offered (audit M3)", async () => {
    const node = new FakeNear({ contract: RNEAR, codeHash: RNEAR_HASH, symbol: 'rNEAR' })
    node.contractStorage = 5_197_575n // lst.rhealab.near on 2026-11-08: 51.98 NEAR of storage
    const kept = 5_197_575n * 10n ** 19n
    const { p, sent } = setup({ node, config: { pool: 'rnear' } })
    node.stakeFor(ALICE, 20n * NEAR)
    node.unstakedFor(ALICE, 3n * NEAR, EPOCH)
    // 1 NEAR + 3 NEAR + 40 NEAR: enough under the old "− 1 NEAR" rule, short of the storage the runtime keeps.
    node.liquidity = 44n * NEAR
    expect((await p.getPoolInfo()).kept).toBe(kept)
    expect((await p.getStakedBalance()).withdrawable).toBe(0n)
    expect((await p.getWithdrawalRequests()).requests[0]).toMatchObject({ claimable: false, awaitingLiquidity: true })
    await expect(p.quoteClaimWithdrawals()).rejects.toSatisfy(refusal('awaiting-liquidity'))
    // the unstake is not built as [withdraw_all, unstake] (that whole transaction would revert): relock-refused, as for any unpayable balance
    await expect(p.requestWithdrawal({ amount: 'all' })).rejects.toSatisfy(refusal('relock-refused'))
    expect(sent()).toEqual([])
    node.liquidity = kept + 3n * NEAR
    expect((await p.quoteClaimWithdrawals()).amount).toBe(3n * NEAR)
    // a small contract still keeps its own 1 NEAR
    node.contractStorage = 100n
    node.liquidity = NEAR + 3n * NEAR - 1n
    await expect(p.quoteClaimWithdrawals()).rejects.toSatisfy(refusal('awaiting-liquidity'))
  })

  it('a locked unstaked balance would restart its timer: refused unless allowTimerReset', async () => {
    const { p, node, sent } = setup()
    node.stakeFor(ALICE, 20n * NEAR)
    node.unstakedFor(ALICE, 2n * NEAR, EPOCH + 2n)
    const e = await p.quoteRequestWithdrawal({ amount: NEAR }).catch((x: unknown) => x)
    expect(e).toSatisfy(refusal('timer-reset-refused'))
    expect((e as LiquidStakingError).details).toMatchObject({ unstaked: 2n * NEAR, unlockEpoch: EPOCH + 2n })
    await expect(p.requestWithdrawal({ amount: NEAR })).rejects.toSatisfy(refusal('timer-reset-refused'))
    expect(sent()).toEqual([])
    // below MIN_STAKE it is refused even when allowed: dust never restarts a real balance's wait
    const tiny = (MIN_STAKE * node.totalShares) / node.totalStaked - 1n
    await expect(p.quoteRequestWithdrawal({ amount: tiny, allowTimerReset: true })).rejects.toSatisfy(refusal('timer-reset-refused'))
    const q = await p.quoteRequestWithdrawal({ amount: NEAR, allowTimerReset: true })
    expect(q.resetsTimer).toBe(true)
    expect(q.transactions[0]!.actions).toHaveLength(1)
    expect(q.warnings.find((w) => w.code === 'resets-unbonding-timer')?.message).toMatch(/restarts the wait for the whole unstaked balance/)
  })

  it('rounding dust in the unstaked balance is ignored', async () => {
    const { p, node } = setup()
    node.stakeFor(ALICE, 20n * NEAR)
    node.unstakedFor(ALICE, 2n, 0n)
    const q = await p.quoteRequestWithdrawal({ amount: 'all' })
    expect(q.transactions[0]!.actions).toHaveLength(1)
    expect(q.warnings.map((w) => w.code)).toEqual(['unlock-may-be-later'])
    expect((await p.getWithdrawalRequests()).requests).toEqual([])
  })

  it('unlock estimate: earliest = current + 4, latest unknown (the contract decides)', async () => {
    const { p, node } = setup()
    node.stakeFor(ALICE, 5n * NEAR)
    const [q, epoch] = await Promise.all([p.quoteRequestWithdrawal({ amount: 'all' }), p.getEpoch()])
    expect(q.unlock).toEqual({ epoch: null, earliestEpoch: EPOCH + 4n, latestEpoch: null, at: null, earliestAt: epochStartsAt(epoch, EPOCH + 4n), latestAt: null, source: 'estimate' })
    // ~21 h or more from now (4 epochs from the start of the current one, which is ~1.6 h old here).
    expect(q.unlock.earliestAt - epoch.startedAt).toBe(4 * epoch.epochMs)
  })

  it('the upfront gas must be covered by the spendable balance (0.02 NEAR cannot buy 30 Tgas at 10^9)', async () => {
    const { p, node } = setup()
    node.stakeFor(ALICE, 5n * NEAR)
    node.balances.set(ALICE, { amount: 182n * 10n ** 19n + DEFAULT_RESERVE, locked: 0n, storage: 182n })
    await expect(p.quoteRequestWithdrawal({ amount: 'all' })).rejects.toBeInstanceOf(InsufficientFundsError)
    // what a stake leaves is enough for the unstake, and then for the claim
    node.balances.set(ALICE, { amount: 182n * 10n ** 19n + EXIT_RESERVE, locked: 0n, storage: 182n })
    expect((await p.quoteRequestWithdrawal({ amount: 'all' })).shares).toBe(node.account(ALICE).shares)
    node.unstakedFor(ALICE, NEAR, EPOCH)
    node.account(ALICE).shares = 0n
    expect((await p.quoteClaimWithdrawals()).amount).toBe(NEAR)
  })

  it('min_gas_purchase_price from the protocol config, or the mainnet value when the node cannot say; maxFee checked by the module', async () => {
    const node = new FakeNear()
    node.minGasPurchasePrice = '3000000000'
    const { p, sent } = setup({ node })
    const q = await p.quoteStake({ amount: NEAR })
    expect(q.upfront).toBe(gasOf(q.transactions) * 3_000_000_000n)
    const failing = new FakeNear()
    failing.minGasPurchasePrice = 'fails'
    const f = await setup({ node: failing }).p.quoteStake({ amount: NEAR })
    expect(f.upfront).toBe(upfrontOf(f.transactions))
    await expect(p.stake({ amount: NEAR, maxFee: q.fee - 1n })).rejects.toSatisfy(refusal('max-fee-exceeded'))
    expect(sent()).toEqual([])
    await p.stake({ amount: NEAR, maxFee: q.fee, expected: q.transactions })
    expect(sent()).toHaveLength(1)
  })

  it("requestWithdrawal sends the quote; 'quote-changed' when an unlocked balance appeared since", async () => {
    const { p, node, sent } = setup()
    node.stakeFor(ALICE, 5n * NEAR)
    const q = await p.quoteRequestWithdrawal({ amount: 'all' })
    node.unstakedFor(ALICE, NEAR, EPOCH)
    const e = await p.requestWithdrawal({ amount: 'all', expected: q.transactions }).catch((x: unknown) => x)
    expect(e).toSatisfy(refusal('quote-changed'))
    const fresh = (e as LiquidStakingError).details!.transactions as NearTransaction[]
    expect(fresh[0]!.actions.map((a) => (a as { functionCall: { methodName: string } }).functionCall.methodName)).toEqual(['withdraw_all', 'unstake_all'])
    expect(sent()).toEqual([])
    const r = await p.requestWithdrawal({ amount: 'all', expected: fresh })
    expect(sameTransactions(fresh, sent())).toBe(true)
    expect(r).toMatchObject({ approveHash: null, hash: r.hashes[0] })
  })
})

describe('claim', () => {
  it("before the unlock epoch: 'not-withdrawable' with the contract's epoch and its date", async () => {
    const { p, node } = setup()
    node.unstakedFor(ALICE, 2n * NEAR, EPOCH + 3n)
    const e = await p.quoteClaimWithdrawals().catch((x: unknown) => x)
    expect(e).toSatisfy(refusal('not-withdrawable'))
    const epoch = await p.getEpoch()
    expect((e as LiquidStakingError).details?.unlock).toEqual({ epoch: EPOCH + 3n, earliestEpoch: EPOCH + 3n, latestEpoch: EPOCH + 3n, at: epochStartsAt(epoch, EPOCH + 3n), earliestAt: epochStartsAt(epoch, EPOCH + 3n), latestAt: epochStartsAt(epoch, EPOCH + 3n), source: 'contract' })
  })

  it("unlocked but the contract holds too little: 'awaiting-liquidity'", async () => {
    const { p, node } = setup()
    node.unstakedFor(ALICE, 5n * NEAR, EPOCH)
    node.liquidity = LINEAR_KEPT + 5n * NEAR - 1n
    await expect(p.quoteClaimWithdrawals()).rejects.toSatisfy(refusal('awaiting-liquidity'))
    node.liquidity = LINEAR_KEPT + 5n * NEAR
    await expect(p.quoteClaimWithdrawals()).resolves.toMatchObject({ amount: 5n * NEAR })
  })

  it('happy path: one withdraw_all, sent as quoted', async () => {
    const { p, node, sent } = setup()
    node.unstakedFor(ALICE, 5n * NEAR, EPOCH - 2n)
    const q = await p.quoteClaimWithdrawals()
    expect(q.transactions).toEqual([{ receiverId: LINEAR, actions: [{ functionCall: { methodName: 'withdraw_all', args: {}, gas: 30n * TGAS, deposit: 0n } }] }])
    expect(q).toMatchObject({ amount: 5n * NEAR, fee: feeOf(q.transactions, node.gasPrice), upfront: upfrontOf(q.transactions) })
    const r = await p.claimWithdrawals({ ids: [poolRequestId(LINEAR)], expected: q.transactions })
    expect(sameTransactions(q.transactions, sent())).toBe(true)
    expect(r.hashes).toHaveLength(1)
  })

  it("ids: the contract's one id works; any other is 'unknown-request'; an empty list claims nothing", async () => {
    const { p, node } = setup()
    node.unstakedFor(ALICE, 5n * NEAR, EPOCH)
    await expect(p.quoteClaimWithdrawals({ ids: [poolRequestId(LINEAR), poolRequestId(LINEAR)] })).resolves.toMatchObject({ amount: 5n * NEAR })
    await expect(p.quoteClaimWithdrawals({ ids: [poolRequestId(RNEAR)] })).rejects.toSatisfy(refusal('unknown-request'))
    await expect(p.quoteClaimWithdrawals({ ids: [123n] })).rejects.toSatisfy(refusal('unknown-request'))
    await expect(p.quoteClaimWithdrawals({ ids: [] })).rejects.toSatisfy(refusal('nothing-to-claim'))
  })

  it("nothing unstaked (or dust): 'nothing-to-claim'", async () => {
    const { p, node } = setup()
    await expect(p.quoteClaimWithdrawals()).rejects.toSatisfy(refusal('nothing-to-claim'))
    node.unstakedFor(ALICE, 1n, 0n)
    await expect(p.claimWithdrawals()).rejects.toSatisfy(refusal('nothing-to-claim'))
  })
})

describe('reads', () => {
  it('account details: tokens, NEAR value at the price, unstaked, exact unlock epoch, registration', async () => {
    const { p, node } = setup()
    node.stakeFor(ALICE, 10n * NEAR)
    node.unstakedFor(ALICE, 2n * NEAR, EPOCH + 4n)
    const d = await p.getAccountDetails()
    const shares = node.account(ALICE).shares
    expect(d).toEqual({ shares, value: (shares * node.price) / NEAR, unstaked: 2n * NEAR, unlockEpoch: EPOCH + 4n, canWithdraw: false, registered: true })
    expect(d.value <= 10n * NEAR && d.value > 10n * NEAR - 10n ** 7n).toBe(true)
  })

  it('staked balance, Tonstakers-style; withdrawable needs the epoch and the liquidity', async () => {
    const { p, node } = setup()
    node.stakeFor(ALICE, 10n * NEAR)
    node.unstakedFor(ALICE, 2n * NEAR, EPOCH)
    const shares = node.account(ALICE).shares
    expect(await p.getStakedBalance()).toEqual({ balance: shares, wrappedBalance: 0n, rate: node.price, total: (shares * node.price) / NEAR, unstaked: 2n * NEAR, withdrawable: 2n * NEAR, price: node.price })
    node.liquidity = 2n * NEAR
    expect((await p.getStakedBalance()).withdrawable).toBe(0n)
    node.liquidity = 100n * NEAR
    node.unstakedFor(ALICE, 2n * NEAR, EPOCH + 1n)
    expect((await p.getStakedBalance()).withdrawable).toBe(0n)
  })

  it('withdrawal requests: one per contract; claimable, locked (with its date) or awaiting liquidity', async () => {
    const { p, node } = setup()
    expect(await p.getWithdrawalRequests()).toEqual({ requests: [], pendingAmount: 0n, claimableAmount: 0n, claimableIds: [] })

    node.unstakedFor(ALICE, 2n * NEAR, EPOCH)
    const id = poolRequestId(LINEAR)
    expect(await p.getWithdrawalRequests()).toEqual({
      requests: [{ id, amount: 2n * NEAR, timestamp: 0, claimable: true, contract: LINEAR, unlockEpoch: EPOCH, awaitingLiquidity: false, unlock: null }],
      pendingAmount: 0n, claimableAmount: 2n * NEAR, claimableIds: [id],
    })

    node.unstakedFor(ALICE, 2n * NEAR, EPOCH + 4n)
    const locked = await p.getWithdrawalRequests()
    expect(locked).toMatchObject({ pendingAmount: 2n * NEAR, claimableAmount: 0n, claimableIds: [] })
    expect(locked.requests[0]).toMatchObject({ claimable: false, awaitingLiquidity: false, unlock: { epoch: EPOCH + 4n, source: 'contract' } })

    node.unstakedFor(ALICE, 2n * NEAR, EPOCH - 1n)
    node.liquidity = NEAR
    const waiting = await p.getWithdrawalRequests()
    expect(waiting.requests[0]).toMatchObject({ claimable: false, awaitingLiquidity: true })
    expect(waiting.claimableIds).toEqual([])
  })
})

describe('APR', () => {
  it('price growth over 24 epochs from the archival RPC, annualized by block time (≈ 4.7 %)', async () => {
    const { p, node } = setup()
    const apr = await p.getApr()
    expect(apr).toBeGreaterThan(4.6)
    expect(apr).toBeLessThan(4.8)
    const past = node.calls.find((c) => c.method === 'query' && (c.params as { block_id?: number }).block_id !== undefined)
    expect((past?.params as { block_id: number }).block_id).toBe(Number((node.head - 24n * 43_200n).toString()))
  })

  it('aprWindowEpochs moves the past read; a skipped height reads the next block', async () => {
    const node = new FakeNear()
    const { p } = setup({ node, config: { aprWindowEpochs: 3 } })
    node.skipped.add(node.head - 3n * 43_200n)
    await p.getApr()
    const heights = node.calls.filter((c) => c.method === 'query' && (c.params as { block_id?: number }).block_id !== undefined).map((c) => (c.params as { block_id: number }).block_id)
    expect(heights).toEqual([Number((node.head - 3n * 43_200n).toString()), Number((node.head - 3n * 43_200n + 1n).toString())])
  })

  it('falls back to a 2-epoch window on the regular RPC when the archival RPC fails', async () => {
    const { p, node } = setup({ config: { archivalProvider: async () => { throw new Error('archival down') } } })
    const apr = await p.getApr()
    expect(apr).toBeGreaterThan(4.6)
    expect(node.calls.some((c) => (c.params as { block_id?: number }).block_id === Number((node.head - 2n * 43_200n).toString()))).toBe(true)
  })

  it('throws when neither RPC has the past block, and is cached for 10 minutes once read', async () => {
    const { p, node } = setup({ config: { archivalProvider: async () => { throw new Error('archival down') } } })
    node.prunedBelow = node.head - 10n
    await expect(p.getApr()).rejects.toThrow(/archival down/)
    node.prunedBelow = 0n
    await p.getApr()
    const n = node.calls.length
    await p.getApr()
    expect(node.calls.length).toBe(n)
  })

  it('the apr hook replaces the estimate', async () => {
    const { p, node } = setup({ config: { apr: async () => 5.25 } })
    expect(await p.getApr()).toBe(5.25)
    expect(node.calls).toEqual([])
  })
})

describe('epoch clock', () => {
  it('height, start, measured duration and the end estimate', async () => {
    const { p, node } = setup()
    const e = await p.getEpoch()
    expect(e).toMatchObject({ height: EPOCH, startBlock: node.epochStart, length: 43_200n, block: node.head, blocksLeft: 43_200n - 10_000n })
    expect(e.epochMs).toBe(43_200 * 575)
    expect(e.startedAt).toBe(node.timeAt(node.epochStart))
    expect(e.endsAt).toBe(node.timeAt(node.head) + 33_200 * 575)
  })
})
