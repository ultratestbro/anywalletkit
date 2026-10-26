import { describe, expect, it } from 'vitest'
import { derivationVectors } from '@anywalletkit/conformance'
import { NativeStakingProtocolSolana } from '@anywalletkit/protocol-staking-native-solana'
import { nativePosition, walletWithNativeStaking } from '../src/native-solana.ts'

const SEED = derivationVectors.seeds['bip39-abandon-12']!

describe('Native SOL staking (docs) — offline', () => {
  it('the kit hands out the module over the Solana account, with its validator list', async () => {
    const wallet = walletWithNativeStaking(SEED)
    try {
      const staking = await wallet.getProtocol<NativeStakingProtocolSolana>('sol-staking')
      expect(staking).toBeInstanceOf(NativeStakingProtocolSolana)
      expect(staking.validators).toHaveLength(2)
      expect(staking.maxCommission).toBe(10)
      // Seed-derived stake accounts: known before anything is sent.
      expect(await staking.getStakeAccountAddress(0)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
    } finally {
      wallet.dispose()
    }
  })
})

// Mainnet reads, nothing signed: LIVE=1 pnpm --filter @anywalletkit/example-earn test
describe.runIf(process.env.LIVE === '1')('Native SOL staking (docs) — live reads', () => {
  it('reads the validators, the (empty) position and the APR', async () => {
    const wallet = walletWithNativeStaking(SEED)
    try {
      const position = await nativePosition(wallet)
      console.log('native staking', { accounts: position.accounts.length, balance: position.balance, apr: position.apr })
      expect(position.apr).toBeGreaterThan(0)
      expect(position.apr).toBeLessThan(20)
    } finally {
      wallet.dispose()
    }
  }, 90_000)
})
