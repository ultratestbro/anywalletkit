import { describe, expect, it } from 'vitest'
import type { IWalletAccount, IWalletAccountReadOnly } from '@anywalletkit/core'
import { Wallet } from '@anywalletkit/kit'
import { WalletManagerEvm, type WalletAccountEvm } from '../src/index.js'

// Audit 2026-10-29 A1: on a wallet without policies, a protocol module copied the 32-byte key
// through `account.signer.key()`, and the copy survived dispose(). Offline, public test mnemonic.
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

class Module {
  readonly account: WalletAccountEvm
  constructor(account: IWalletAccount | IWalletAccountReadOnly) { this.account = account as WalletAccountEvm }
}

describe('audit 2026-10-29 A1: an EVM module gets no signer, with or without policies', () => {
  for (const policies of [undefined, {}]) {
    it(`policies ${policies === undefined ? 'none' : '{}'}`, async () => {
      const w = new Wallet(SEED, policies === undefined ? {} : { policies })
      w.registerWallet('eip155', WalletManagerEvm, { chainId: 1 })
      w.registerProtocol('m', Module, { chain: 'eip155:1' })
      const { account } = await w.getProtocol<Module>('m')
      const loose = account as unknown as Record<string, unknown>
      expect(loose.signer).toBeUndefined()
      expect(Reflect.ownKeys(account).map(String)).not.toContain('signer')
      expect(Object.getOwnPropertyDescriptor(account, 'signer')).toBeUndefined()
      // Still a working account for the module: it signs through the account's own methods.
      expect(await account.getAddress()).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')
      expect(await account.sign('hello')).toMatch(/^0x[0-9a-f]{130}$/)
      w.dispose()
      await expect(account.sign('hello')).rejects.toThrow(/disposed/)
    })
  }

  it('the app\'s own account has no signer property either; signerKind says what holds the key', async () => {
    const m = new WalletManagerEvm(SEED, { chainId: 1 })
    const a = await m.getAccount()
    expect(Reflect.get(a, 'signer')).toBeUndefined()
    expect(JSON.stringify(Object.keys(a))).not.toContain('signer"')
    expect(a.signerKind).toBe('seed')
    m.dispose()
  })
})
