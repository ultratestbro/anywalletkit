import { describe, expect, it } from 'vitest'
import type { IWalletAccount, WalletManager } from '@forgewallet/core'
import { type ChainKey, derivationVectors } from './vectors.js'

export interface ChainSuiteOptions<M extends WalletManager<IWalletAccount, object>> {
  /** Which vector set to compare against. */
  chain: ChainKey
  /** Build a manager for a seed. Must NOT need the network for getAccount/getAddress/sign. */
  create: (seed: string) => M | Promise<M>
  /** Compare the recorded `sign(message)` encoding too (default true). */
  checkSignMessage?: boolean
  /** Hex of the account's public key; omit if the account does not expose one. */
  publicKeyOf?: (account: IWalletAccount) => Promise<Uint8Array | string | undefined>
}

/**
 * The conformance suite every chain package must pass. Call it inside a test
 * file; it registers `describe`/`it` blocks with vitest.
 */
export function describeChainModule<M extends WalletManager<IWalletAccount, object>>(name: string, o: ChainSuiteOptions<M>): void {
  const sets = derivationVectors.vectors[o.chain]
  describe(`${name}: conformance (${o.chain})`, () => {
    for (const [seedName, set] of Object.entries(sets)) {
      const mnemonic = derivationVectors.seeds[seedName]!
      describe(seedName, () => {
        for (const vec of set.accounts) {
          it(`account #${vec.index} resolves the address ${vec.address}`, async () => {
            const m = await o.create(mnemonic)
            try {
              const a = await m.getAccount(vec.index)
              expect(await a.getAddress()).toBe(vec.address)
              expect(await (await m.getAccountByPath(vec.path)).getAddress()).toBe(vec.address)
              if (o.publicKeyOf) {
                const pk = await o.publicKeyOf(a)
                const hex = pk instanceof Uint8Array ? Array.from(pk, (b) => b.toString(16).padStart(2, '0')).join('') : pk
                expect(hex).toBe(vec.publicKey)
              }
              if (o.checkSignMessage !== false) expect(await a.sign(derivationVectors.message)).toBe(vec.signMessage)
            } finally { m.dispose() }
          })
        }
      })
    }

    it('read-only account cannot sign', async () => {
      const m = await o.create(derivationVectors.seeds['bip39-abandon-12']!)
      try {
        const ro = (await m.getAccount(0)).toReadOnlyAccount() as Partial<IWalletAccount>
        expect(ro.sendTransaction).toBeUndefined()
        expect(ro.sign).toBeUndefined()
        expect(ro.signTransaction).toBeUndefined()
      } finally { m.dispose() }
    })

    it('dispose() makes the account unusable', async () => {
      const m = await o.create(derivationVectors.seeds['bip39-abandon-12']!)
      const a = await m.getAccount(0)
      m.dispose()
      await expect(a.sign('after dispose')).rejects.toThrow()
    })

    it('rejects an invalid seed phrase', async () => {
      await expect(Promise.resolve().then(() => o.create('not a seed phrase at all'))).rejects.toThrow()
    })
  })
}
