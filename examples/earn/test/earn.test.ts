import { describe, expect, it } from 'vitest'
import { derivationVectors } from '@anywalletkit/conformance'
import LidoProtocolEvm from '@anywalletkit/protocol-staking-lido-evm'
import { AaveProtocolEvm } from '@anywalletkit/protocol-lending-aave-evm'
import { lendingPosition, stakingPosition, walletWithEarn } from '../src/earn.ts'

const SEED = derivationVectors.seeds['bip39-abandon-12']!

describe('Earn guide (docs) — offline', () => {
  it('the kit hands out Lido and Aave over the Ethereum account', async () => {
    const wallet = walletWithEarn(SEED)
    try {
      expect(await wallet.getProtocol('lido')).toBeInstanceOf(LidoProtocolEvm)
      expect(await wallet.getProtocol('aave')).toBeInstanceOf(AaveProtocolEvm)
    } finally {
      wallet.dispose()
    }
  })
})

// Mainnet reads, nothing signed: LIVE=1 pnpm --filter @anywalletkit/example-earn test
describe.runIf(process.env.LIVE === '1')('Earn guide (docs) — live reads', () => {
  it('reads the Lido position and APR, the Aave position and USDC APY', async () => {
    const wallet = walletWithEarn(SEED)
    try {
      const staking = await stakingPosition(wallet)
      console.log('lido', staking)
      expect(staking.apr).toBeGreaterThan(0)
      expect(staking.apr).toBeLessThan(20) // percent
      const lending = await lendingPosition(wallet)
      console.log('aave', { supplies: lending.supplies.length, borrows: lending.borrows.length, hf: lending.healthFactor })
      expect(lending.healthFactor).toBe(Infinity)
      const aave = await wallet.getProtocol<AaveProtocolEvm>('aave')
      const apy = await aave.getSupplyApy('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')
      console.log('aave USDC supply APY %', apy)
      expect(apy).toBeGreaterThan(0)
    } finally {
      wallet.dispose()
    }
  }, 90_000)
})
