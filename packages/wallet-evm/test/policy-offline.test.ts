import { describe, expect, it, vi } from 'vitest'
import { Wallet, applyPolicies } from '@anywalletkit/kit'
import { WalletManagerEvm } from '../src/index.js'

// A review of the 2026-10-25 fixes: the policies asked getChainId() of every eip155:unknown
// account, which throws without a provider — offline signing through policies broke.
const SEED = 'test test test test test test test test test test test junk'
const TO = '0x000000000000000000000000000000000000bEEF'

describe('an EVM account without provider or chainId signs offline through the policies', () => {
  it('Wallet with confirm-only policies: sign and a fully specified signTransaction', async () => {
    const confirm = vi.fn(async () => true)
    const w = new Wallet(SEED, { policies: { confirm } })
    w.registerWallet('eip155:1', WalletManagerEvm, {})
    const a = await w.getAccount('eip155:1')
    expect(a.chain).toBe('eip155:unknown')
    await expect(a.sign('hi')).resolves.toMatch(/^0x/)
    await expect(a.signTransaction({ to: TO, value: 1n, chainId: 1, nonce: 0, gasLimit: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).resolves.toMatch(/^0x/)
    expect(confirm).toHaveBeenCalledTimes(2)
    w.dispose()
  })

  it('the keyring recipe: applyPolicies(account, policies, account.chain)', async () => {
    const m = new WalletManagerEvm(SEED, {})
    const a = await m.getAccount(0)
    await expect(applyPolicies(a, { confirm: async () => true }, a.chain).sign('hi')).resolves.toMatch(/^0x/)
    m.dispose()
  })
})
