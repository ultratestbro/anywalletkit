import { describe, expect, it } from 'vitest'
import { derivationVectors } from '@forgewallet/conformance'
import { memoryJsonStorage, type FetchLike, type NetworksState } from '@forgewallet/networks'
import { addUserRpc, onAddEthereumChain, openNetworks, reviewLabel, walletOnNetworks } from '../src/networks.ts'

const SEED = derivationVectors.seeds['bip39-abandon-12']!

/** An EVM node stand-in that says it is `chainIdHex`. */
const evmNode = (chainIdHex: string): FetchLike => async (_url, init) => {
  const { method, id } = JSON.parse(init!.body!) as { method: string; id: number }
  const body = JSON.stringify({ jsonrpc: '2.0', id, result: method === 'eth_chainId' ? chainIdHex : '0x1234' })
  return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body } as never
}

describe('Networks guide (docs) — offline', () => {
  it('a user RPC is checked, verified against the chain id, and goes first in the failover list', async () => {
    const table = await openNetworks(memoryJsonStorage<NetworksState>())
    const shipped = table.rpcUrlsForSync('eip155:8453')
    expect(shipped.length).toBeGreaterThan(0)

    expect(await addUserRpc(table, 'eip155:8453', 'http://my.node/rpc')).toMatchObject({ ok: false })
    const wrongChain = await addUserRpc(table, 'eip155:8453', 'https://my.node/rpc', evmNode('0x1'))
    expect(wrongChain).toMatchObject({ ok: false, error: expect.stringMatching(/^chain-id-mismatch/) })

    expect(await addUserRpc(table, 'eip155:8453', 'https://my.node/rpc', evmNode('0x2105'))).toMatchObject({ ok: true })
    expect(table.rpcUrlsForSync('eip155:8453')).toEqual(['https://my.node/rpc', ...shipped])
    expect(reviewLabel(table, 'eip155:8453')).toMatch(/Custom RPC/)
    expect(reviewLabel(table, 'eip155:1')).toBeNull()
  })

  it('the wallet is built on the table: accounts resolve on every registered network', async () => {
    const table = await openNetworks(memoryJsonStorage<NetworksState>())
    const wallet = walletOnNetworks(SEED, table, [1, 8453])
    const address = derivationVectors.vectors.evm['bip39-abandon-12']!.accounts[0]!.address
    expect(await (await wallet.getAccount('eip155:8453')).getAddress()).toBe(address)
    expect((await wallet.getAccount('eip155:8453')).chain).toBe('eip155:8453')
  })

  it('wallet_addEthereumChain: bad params are refused, a known chain is a no-op, a new one needs the user and a passing RPC', async () => {
    const table = await openNetworks(memoryJsonStorage<NetworksState>())
    const asked: string[] = []
    const ask = async (n: { name: string }) => { asked.push(n.name); return true }
    expect(await onAddEthereumChain(table, 'https://dapp.example', [{ chainId: 'base' }], ask)).toMatchObject({ code: -32602 })
    expect(await onAddEthereumChain(table, 'https://dapp.example', [{ chainId: '0x2105', chainName: 'Base', rpcUrls: ['https://x'], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }], ask)).toBeNull()
    expect(asked).toEqual([])
    const zora = [{ chainId: '0x76adf1', chainName: 'Zora', rpcUrls: ['https://rpc.zora.energy'], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }]
    expect(await onAddEthereumChain(table, 'https://dapp.example', zora, ask, evmNode('0x1'))).toMatchObject({ code: -32603 })
    expect(await table.get('eip155:7777777')).toBeNull()
    expect(await onAddEthereumChain(table, 'https://dapp.example', zora, ask, evmNode('0x76adf1'))).toBeNull()
    expect(await table.get('eip155:7777777')).toMatchObject({ kind: 'custom', source: { origin: 'https://dapp.example' } })
    expect(await onAddEthereumChain(table, 'https://dapp.example', zora, async () => false)).toBeNull() // already added
  })
})

// A real endpoint, nothing signed: LIVE=1 pnpm --filter @forgewallet/example-networks test
describe.runIf(process.env.LIVE === '1')('Networks guide (docs) — live', () => {
  it('verifies the first shipped Base endpoint', async () => {
    const { verifyNetwork } = await import('@forgewallet/networks')
    const table = await openNetworks(memoryJsonStorage<NetworksState>())
    const r = await verifyNetwork((await table.get('eip155:8453'))!)
    console.log(r)
    expect(r.ok).toBe(true)
  }, 30_000)
})
