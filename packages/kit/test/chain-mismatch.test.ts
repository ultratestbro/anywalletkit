import { describe, expect, it, vi } from 'vitest'
import { WalletManager, type FeeRates, type IWalletAccount } from '@anywalletkit/core'
import { createMockAccount } from '@anywalletkit/conformance'
import { PolicyViolationError, Wallet, applyPolicies, sameChain } from '../src/index.js'

// Audit 2026-10-25, #7: confirm showed the chain the app asked for (Base) while the account signed
// for the network its RPC is on (Ethereum). A mismatch must be refused before confirm and signing.
const SEED = 'test test test test test test test test test test test junk'
const DEST = '0x00000000000000000000000000000000000000b0'
const send = () => ({ to: DEST, value: 1n, data: '0x' })

class OnChain extends WalletManager<IWalletAccount, { chain: string; lazy?: number }> {
  async getAccount() { return this.getAccountByPath() }
  async getAccountByPath() {
    const acc = createMockAccount({ chain: this._config.chain })
    return this._config.lazy === undefined ? acc : Object.assign(acc, { getChainId: async () => this._config.lazy! })
  }
  async getFeeRates(): Promise<FeeRates> { return { slow: 1n, normal: 1n, fast: 1n } }
}

describe('requested chain ≠ the chain the account signs on', () => {
  it('applyPolicies refuses before confirm and before anything is sent', async () => {
    const confirm = vi.fn(async () => true)
    const acc = createMockAccount({ chain: 'eip155:1' })
    await expect(applyPolicies(acc, { confirm }, 'eip155:8453').sendTransaction(send())).rejects.toMatchObject({ policy: 'chain' })
    expect(confirm).not.toHaveBeenCalled()
    expect(acc.sent).toHaveLength(0)
  })

  it('a lazy account (eip155:unknown) learns its chain id first and is refused on a mismatch', async () => {
    const confirm = vi.fn(async () => true)
    const acc = Object.assign(createMockAccount({ chain: 'eip155:unknown' }), { getChainId: async () => 1 })
    await expect(applyPolicies(acc, { confirm }, 'eip155:8453').sendTransaction(send())).rejects.toBeInstanceOf(PolicyViolationError)
    expect(confirm).not.toHaveBeenCalled()
    expect(acc.sent).toHaveLength(0)
    // the same lazy account on the asked-for chain goes through, and confirm sees that chain
    await applyPolicies(acc, { confirm }, 'eip155:1').sendTransaction(send())
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ chain: 'eip155:1' }))
  })

  it('Wallet.getAccount refuses a known mismatch even without policies; a lazy one is refused at write time', async () => {
    const plain = new Wallet(SEED)
    plain.registerWallet('eip155', OnChain, { chain: 'eip155:1' })
    await expect(plain.getAccount('eip155:8453')).rejects.toThrow(/eip155:1.*eip155:8453|eip155:8453.*eip155:1/)
    expect(await (await plain.getAccount('eip155:1')).getAddress()).toBeTruthy()

    const confirm = vi.fn(async () => true)
    const guarded = new Wallet(SEED, { policies: { confirm } })
    guarded.registerWallet('eip155', OnChain, { chain: 'eip155:unknown', lazy: 1 })
    const base = await guarded.getAccount('eip155:8453')
    await expect(base.sendTransaction(send())).rejects.toMatchObject({ policy: 'chain' })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('two spellings of one network are the same chain', () => {
    expect(sameChain('solana:mainnet', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe(true)
    expect(sameChain('solana:devnet', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe(false)
    expect(sameChain('tron:728126428', 'tron:0x2b6653dc')).toBe(true)
    expect(sameChain('tron:mainnet', 'tron:0x2B6653DC')).toBe(true)
    expect(sameChain('tron:nile', 'tron:0x2b6653dc')).toBe(false)
    expect(sameChain('ton:mainnet', 'ton:-239')).toBe(true)
    expect(sameChain('bitcoin:mainnet', 'bip122:000000000019d6689c085ae165831e93')).toBe(true)
    expect(sameChain('eip155:8453', 'eip155:08453')).toBe(true)
    expect(sameChain('eip155:8453', 'eip155:1')).toBe(false)
  })

  it('non-EVM accounts asked for by their short id are not refused', async () => {
    const w = new Wallet(SEED, { policies: { confirm: async () => true } })
    w.registerWallet('solana', OnChain, { chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' })
    const sol = await w.getAccount('solana:mainnet')
    await expect(sol.transfer({ recipient: 'x', amount: 1n })).resolves.toBeDefined()
    await expect(w.getAccount('solana:devnet')).rejects.toThrow()
  })
})
