import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { derivationVectors } from '@anywalletkit/conformance'
import { InsufficientFundsError } from '@anywalletkit/core'
import { NativeStakingProtocolNear } from '@anywalletkit/protocol-staking-native-near'
import { claimNear, nearPosition, quoteNearStake, walletWithNearStaking } from '../src/native-near.ts'
import { ASTRO, FIGMENT, NEAR, offlineNear } from './near-node.ts'

const SEED = derivationVectors.seeds['bip39-abandon-12']!
const TGAS = 10n ** 12n

describe('Native NEAR staking (docs) — offline', () => {
  let node: ReturnType<typeof offlineNear>
  beforeEach(() => {
    node = offlineNear()
    vi.stubGlobal('fetch', node.fetch)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('the kit hands out the module over the NEAR account, with its pool list', async () => {
    const wallet = walletWithNearStaking(SEED)
    try {
      const staking = await wallet.getProtocol<NativeStakingProtocolNear>('near-staking')
      expect(staking).toBeInstanceOf(NativeStakingProtocolNear)
      expect(staking.pools).toEqual([{ id: ASTRO, name: 'Pool A' }, { id: FIGMENT, name: 'Pool B' }])
      expect(staking.defaultPool).toBe(ASTRO)
      expect(staking.maxFee).toBe(10)
      expect(staking.network).toBe('mainnet')
    } finally {
      wallet.dispose()
    }
  })

  it('quotes a stake over the mocked RPC: one deposit_and_stake into the default pool, prepaid gas counted', async () => {
    const wallet = walletWithNearStaking(SEED)
    try {
      const quote = await quoteNearStake(wallet, NEAR)
      expect(quote.transactions).toEqual([{ receiverId: ASTRO, actions: [{ functionCall: { methodName: 'deposit_and_stake', args: {}, gas: 50n * TGAS, deposit: NEAR } }] }])
      expect(quote.pool).toMatchObject({ id: ASTRO, eligible: true, codeHashKnown: true, feePercent: 1, paused: false, inCurrentSet: true, inNextSet: true })
      // The node buys the prepaid gas at min_gas_purchase_price (10× the gas price) and refunds the unburnt part.
      expect(quote.upfront).toBeGreaterThan(quote.fee)
      expect(quote.reserve).toBeGreaterThanOrEqual(quote.upfront)
      expect(quote.apr).toBeGreaterThan(4.5)
      expect(quote.apr).toBeLessThan(6)
      expect(new Set(node.urls.map((u) => new URL(u).host))).toEqual(new Set(['free.rpc.fastnear.com']))
    } finally {
      wallet.dispose()
    }
  })

  it('a stake that would not leave the reserve and the upfront gas is refused before anything is signed', async () => {
    const wallet = walletWithNearStaking(SEED)
    try {
      await expect(quoteNearStake(wallet, 10n * NEAR)).rejects.toBeInstanceOf(InsufficientFundsError)
    } finally {
      wallet.dispose()
    }
  })

  it('reads the position: both pools with live checks, the stake found through the discovery index, the APR', async () => {
    const wallet = walletWithNearStaking(SEED)
    try {
      const position = await nearPosition(wallet)
      expect(position.pools.map((p) => [p.id, p.eligible, p.feePercent])).toEqual([[ASTRO, true, 1], [FIGMENT, true, 10]])
      expect(position.positions.map((p) => [p.pool, p.staked, p.unstaked])).toEqual([[ASTRO, 5n * NEAR, 0n]])
      expect(position.balance).toBe(5n * NEAR)
      expect(position.total).toBe(5n * NEAR)
      expect(position.apr).toBeCloseTo(position.pools[0]!.apr!, 9)
      expect(node.urls.some((u) => u.startsWith('https://api.fastnear.com/v1/account/'))).toBe(true)
      // Nothing is unstaked: nothing to claim, and nothing is planned.
      expect(await claimNear(wallet)).toBeNull()
    } finally {
      wallet.dispose()
    }
  })
})

// Mainnet reads, nothing signed: LIVE=1 pnpm --filter @anywalletkit/example-earn test
describe.runIf(process.env.LIVE === '1')('Native NEAR staking (docs) — live reads', () => {
  it('reads the pools, the (empty) position and the APR', async () => {
    const wallet = walletWithNearStaking(SEED)
    try {
      const position = await nearPosition(wallet)
      console.log('near staking', { pools: position.pools.map((p) => `${p.id} ${p.apr?.toFixed(2)} %`), positions: position.positions.length, apr: position.apr })
      expect(position.apr).toBeGreaterThan(0)
      expect(position.apr).toBeLessThan(15)
    } finally {
      wallet.dispose()
    }
  }, 120_000)
})
