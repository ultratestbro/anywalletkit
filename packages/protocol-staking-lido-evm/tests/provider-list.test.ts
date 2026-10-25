import { describe, expect, it } from 'vitest'
import type { PublicClient } from 'viem'
import { WalletManagerEvm } from '@anywalletkit/wallet-evm'
import LidoProtocolEvm from '../src/index.js'

// Audit 2026-10-25, #1.4: wallet-evm takes `provider` as a list (failover). The module inherited
// that list from the account and handed it to viem's custom(), which needs one EIP-1193 provider.
const down = { request: async () => { throw Object.assign(new Error('fetch failed'), { code: -32603 }) } }
const up = (calls: string[]) => ({ request: async ({ method }: { method: string }) => { calls.push(method); if (method === 'eth_chainId') return '0x1'; throw new Error(`unmocked ${method}`) } })
const account = (provider: unknown) => ({ chain: 'eip155:1', getAddress: async () => '0x0000000000000000000000000000000000000001', _config: { provider } })
const client = (p: unknown) => (p as Record<string, PublicClient>)['_provider']!

describe('LidoProtocolEvm reads over the account\'s RPC list', () => {
  it('a list inherited from the account fails over to the next provider', async () => {
    const calls: string[] = []
    const p = new LidoProtocolEvm(account([down, up(calls)]) as never)
    expect(await client(p).getChainId()).toBe(1)
    expect(calls).toContain('eth_chainId')
  })

  it('a list in the module config works the same; a single provider still works', async () => {
    const calls: string[] = []
    expect(await client(new LidoProtocolEvm(account(undefined) as never, { provider: [down, up(calls)] } as never)).getChainId()).toBe(1)
    expect(await client(new LidoProtocolEvm(account(up(calls)) as never)).getChainId()).toBe(1)
  })

  it('a real wallet-evm account built with a provider list hands it down', async () => {
    const calls: string[] = []
    const manager = new WalletManagerEvm('test test test test test test test test test test test junk', { provider: [down, up(calls)] as never, chainId: 1 })
    const p = new LidoProtocolEvm(await manager.getAccount(0) as never)
    expect(await client(p).getChainId()).toBe(1)
    manager.dispose()
  })
})
