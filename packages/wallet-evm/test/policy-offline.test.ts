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

describe('typed data through the policies: the domain chainId is the account\'s to judge (third review)', () => {
  const agent = (chainId: number) => ({ domain: { name: 'Exchange', version: '1', chainId, verifyingContract: '0x0000000000000000000000000000000000000000' }, types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] }, primaryType: 'Agent', message: { source: 'a', connectionId: `0x${'11'.repeat(32)}` } })
  const permit = (chainId: number, spender: string) => ({
    domain: { name: 'USD Coin', version: '2', chainId, verifyingContract: '0x000000000000000000000000000000000000c0de' },
    types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'Permit', message: { owner: TO, spender, value: 10n ** 30n, nonce: 0n, deadline: 1n },
  })
  it('Hyperliquid-style domain (chainId 1337) from Arbitrum: signs when the account allows it, refused when it does not', async () => {
    for (const allow of [true, false]) {
      const w = new Wallet(SEED, { policies: { confirm: async () => true } })
      w.registerWallet('eip155:42161', WalletManagerEvm, { chainId: 42161, allowCrossChainTypedData: allow })
      const a = await w.getAccount<import('../src/index.js').WalletAccountEvm>('eip155:42161')
      const res = a.signTypedData(agent(1337) as never)
      if (allow) await expect(res).resolves.toMatch(/^0x/)
      else await expect(res).rejects.toThrow()
      w.dispose()
    }
  })
  it('without `chain`, a blocklisted spender of a permit for another domain chainId is refused by the account\'s rules', async () => {
    const DRAINER = '0x00000000000000000000000000000000000Dead1'
    const m = new WalletManagerEvm(SEED, { chainId: 1, allowCrossChainTypedData: true })
    const a = await m.getAccount(0)
    await expect(applyPolicies(a, { blocklist: { 'eip155:1': [DRAINER] } }).signTypedData(permit(8453, DRAINER) as never)).rejects.toThrow(/eip155:1 blocklist/)
    m.dispose()
  })
})

