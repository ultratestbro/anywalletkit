import { describe, expect, it } from 'vitest'
import { derivationVectors } from '@anywalletkit/conformance'
import { NativeStakingProtocolMonad } from '@anywalletkit/protocol-staking-native-monad'
import { monadPosition, walletWithMonadStaking } from '../src/native-monad.ts'

const SEED = derivationVectors.seeds['bip39-abandon-12']!

describe('Native MON staking (docs) — offline', () => {
  it('the kit hands out the module over the Monad account, with its validator list', async () => {
    const wallet = walletWithMonadStaking(SEED)
    try {
      const staking = await wallet.getProtocol<NativeStakingProtocolMonad>('mon-staking')
      expect(staking).toBeInstanceOf(NativeStakingProtocolMonad)
      expect(staking.validators).toHaveLength(2)
      expect(staking.defaultValidator).toBe(97n)
    } finally {
      wallet.dispose()
    }
  })
})

// Mainnet reads, nothing signed: LIVE=1 pnpm --filter @anywalletkit/example-earn test
describe.runIf(process.env.LIVE === '1')('Native MON staking (docs) — live reads', () => {
  it('reads the (empty) position and the APR', async () => {
    const wallet = walletWithMonadStaking(SEED)
    try {
      const position = await monadPosition(wallet)
      console.log('monad staking', { positions: position.positions.length, apr: position.apr })
      expect(position.apr).toBeGreaterThan(0)
      expect(position.apr).toBeLessThan(30)
    } finally {
      wallet.dispose()
    }
  }, 120_000)
})
