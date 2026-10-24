import { describe, expect, it } from 'vitest'
import { derivationVectors } from '@anywalletkit/conformance'
import { LocalSigner, seedFromMnemonic } from '@anywalletkit/core'
import { walletOnRemoteKey } from '../src/signer.ts'

describe('Accounts & signers (docs) — external signer', () => {
  it('a wallet on an external signer resolves the same address and signs the same bytes', async () => {
    const seed = await seedFromMnemonic(derivationVectors.seeds['bip39-abandon-12']!)
    const device = LocalSigner.fromSeed(seed, 'secp256k1', "m/44'/60'/0'/0/0") // stands in for a hardware key
    const wallet = walletOnRemoteKey({ publicKey: device.publicKey, sign: (d, o) => device.sign(d, o) })
    try {
      const account = await wallet.getAccount('eip155:1')
      const golden = derivationVectors.vectors.evm['bip39-abandon-12']!.accounts[0]!
      expect(await account.getAddress()).toBe(golden.address)
      expect(await account.sign(derivationVectors.message)).toBe(golden.signMessage)
    } finally {
      wallet.dispose()
      device.dispose()
    }
  })
})
