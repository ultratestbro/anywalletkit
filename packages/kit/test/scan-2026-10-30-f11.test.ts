import { describe, expect, it, vi } from 'vitest'
import { WalletManager, type FeeRates, type IWalletAccount } from '@anywalletkit/core'
import { createMockAccount } from '@anywalletkit/conformance'
import { Wallet } from '../src/index.js'

// Scan 2026-10-30 F11: getManager cached ONE proxy per manager, closed over the first requested
// chain. With a namespace registration, getManager('eip155:1') then getManager('eip155:137')
// returned the eip155:1 proxy; its accounts were guarded for chain 1, so a write meant for Polygon
// ran on Ethereum instead of being refused as a chain mismatch. Now there is one proxy per chain asked for.

const SEED = 'test test test test test test test test test test test junk'
const DEST = '0x00000000000000000000000000000000000000b0'
const send = () => ({ to: DEST, value: 1n, data: '0x' })

class OnChain extends WalletManager<IWalletAccount, { chain: string }> {
  readonly accs: ReturnType<typeof createMockAccount>[] = []
  async getAccount() { return this.getAccountByPath() }
  async getAccountByPath() { const a = createMockAccount({ chain: this._config.chain }); this.accs.push(a); return a }
  async getFeeRates(): Promise<FeeRates> { return { slow: 1n, normal: 1n, fast: 1n } }
}

describe('scan 2026-10-30 F11: getManager guards for the chain it is asked for', () => {
  it('control: getAccount(eip155:137) on a chain-1 manager refuses the write', async () => {
    const w = new Wallet(SEED)
    w.registerWallet('eip155', OnChain, { chain: 'eip155:1' })
    await expect((await w.getAccount('eip155:137')).sendTransaction(send())).rejects.toMatchObject({ policy: 'chain' })
  })

  it('getManager(eip155:137).getAccount() after getManager(eip155:1) refuses the write', async () => {
    const confirm = vi.fn(async () => true)
    const w = new Wallet(SEED, { policies: { confirm } })
    w.registerWallet('eip155', OnChain, { chain: 'eip155:1' })
    const m1 = w.getManager('eip155:1')
    const m137 = w.getManager('eip155:137')
    expect(m1).not.toBe(m137)
    const acc = await m137.getAccount(0)
    const r = await acc.sendTransaction(send() as never).then(() => 'sent', (e: { policy?: string }) => e.policy ?? 'error')
    expect(r).toBe('chain')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('control: the chain the manager signs on still writes, and each chain keeps one proxy', async () => {
    const confirm = vi.fn(async () => true)
    const w = new Wallet(SEED, { policies: { confirm } })
    w.registerWallet('eip155', OnChain, { chain: 'eip155:1' })
    w.getManager('eip155:137')
    const m1 = w.getManager('eip155:1')
    expect(w.getManager('eip155:1')).toBe(m1)
    expect(w.getManager('eip155:137')).toBe(w.getManager('eip155:137'))
    const acc = await m1.getAccount(0)
    await acc.sendTransaction(send() as never)
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ chain: 'eip155:1' }))
  })
})
