import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { derivationVectors } from '@anywalletkit/conformance'
import { LIQUID_PRESETS, LiquidStakingProtocolNear } from '@anywalletkit/protocol-staking-liquid-near'
import { claimLinear, linearPosition, linearUnlockEpoch, quoteLinearStake, walletWithLiquidNear } from '../src/liquid-near.ts'
import { LINEAR, NEAR, RNEAR, offlineNear } from './near-node.ts'

const SEED = derivationVectors.seeds['bip39-abandon-12']!
const TGAS = 10n ** 12n

describe('Liquid NEAR staking (docs) — offline', () => {
  let node: ReturnType<typeof offlineNear>
  beforeEach(() => {
    node = offlineNear()
    vi.stubGlobal('fetch', node.fetch)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('the kit hands out one module per contract, pinned by account id and code hash', async () => {
    const wallet = walletWithLiquidNear(SEED)
    try {
      const linear = await wallet.getProtocol<LiquidStakingProtocolNear>('linear')
      const rnear = await wallet.getProtocol<LiquidStakingProtocolNear>('rnear')
      expect(linear).toBeInstanceOf(LiquidStakingProtocolNear)
      expect(linear.pool).toMatchObject({ contract: LINEAR, symbol: 'LINEAR', codeHashes: LIQUID_PRESETS.linear.contracts.mainnet.codeHashes })
      expect(rnear.pool).toMatchObject({ contract: RNEAR, symbol: 'rNEAR', codeHashes: LIQUID_PRESETS.rnear.contracts.mainnet.codeHashes })
      // The live code hash is read and compared with the pin.
      expect(await rnear.getPoolInfo()).toMatchObject({ contract: RNEAR, codeHashKnown: true, paused: false, feeBps: 500 })
    } finally {
      wallet.dispose()
    }
  })

  it('quotes a LiNEAR stake over the mocked RPC: one deposit_and_stake, the LINEAR it mints, the APR from the price', async () => {
    const wallet = walletWithLiquidNear(SEED)
    try {
      const quote = await quoteLinearStake(wallet, NEAR)
      expect(quote.transactions).toEqual([{ receiverId: LINEAR, actions: [{ functionCall: { methodName: 'deposit_and_stake', args: {}, gas: 30n * TGAS, deposit: NEAR } }] }])
      // 1 NEAR at 1.43 NEAR per LINEAR, rounded down like the contract.
      expect(quote.shares).toBeGreaterThan(699n * 10n ** 21n)
      expect(quote.shares).toBeLessThan(700n * 10n ** 21n)
      expect(quote.upfront).toBeGreaterThan(quote.fee)
      expect(quote.apr).toBeGreaterThan(4)
      expect(quote.apr).toBeLessThan(5.5)
      // The past price for the APR comes from the archival RPC.
      expect(new Set(node.urls.map((u) => new URL(u).host))).toEqual(new Set(['free.rpc.fastnear.com', 'archival-rpc.mainnet.fastnear.com']))
    } finally {
      wallet.dispose()
    }
  })

  it('reads the position: LINEAR held and its NEAR value; nothing unstaking, nothing to claim', async () => {
    const wallet = walletWithLiquidNear(SEED)
    try {
      const position = await linearPosition(wallet)
      expect(position.balance).toBe(2n * NEAR)
      expect(position.total).toBe(286n * 10n ** 22n)
      expect(position.price).toBe(143n * 10n ** 22n)
      expect(position.unstaked).toBe(0n)
      expect(position.withdrawable).toBe(0n)
      expect(await claimLinear(wallet)).toEqual({ hash: null, awaitingLiquidity: false })
      // No unstake on the account: no request, so no exact unlock epoch to read.
      expect(await linearUnlockEpoch(wallet, 4952n)).toBeNull()
    } finally {
      wallet.dispose()
    }
  })
})

// Mainnet reads, nothing signed: LIVE=1 pnpm --filter @anywalletkit/example-earn test
describe.runIf(process.env.LIVE === '1')('Liquid NEAR staking (docs) — live reads', () => {
  it('reads the (empty) LiNEAR position and the APR', async () => {
    const wallet = walletWithLiquidNear(SEED)
    try {
      const position = await linearPosition(wallet)
      console.log('liquid near', { balance: position.balance, price: position.price, apr: position.apr })
      expect(position.apr).toBeGreaterThan(0)
      expect(position.apr).toBeLessThan(15)
    } finally {
      wallet.dispose()
    }
  }, 120_000)
})
