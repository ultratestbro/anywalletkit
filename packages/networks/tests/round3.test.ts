import { describe, expect, it } from 'vitest'
import { NetworksTable, memoryJsonStorage, parseAddChainParams, verifyNetwork, type FetchLike, type Network, type NetworksState } from '../src/index.js'

// Audit 2026-10-25 round 3, L25 (networks).

const esplora = (genesis: string): FetchLike => async (url) => {
  const out = url.endsWith('/blocks/tip/height') ? '123' : url.endsWith('/block-height/0') ? genesis : 'not found'
  return { ok: true, status: 200, text: async () => out }
}
const net = (caip2: string, family: Network['family']) => ({ caip2, family, rpcs: ['https://node.example'] })
const MAINNET_GENESIS = '000000000019d6689c085ae165831e93649b8f6d20e3c06b1f1cfb3d70d8eb5f'
const SIGNET_GENESIS = '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6'
const REGTEST_GENESIS = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206'
const ZCASH_REGTEST_GENESIS = '029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327'

describe('verifyNetwork checks the genesis of every UTXO network it accepts', () => {
  it('bitcoin:signet / bitcoin:regtest / zcash:regtest: the right genesis passes, a mainnet node is refused', async () => {
    // It used to pass ANY endpoint for these: their expected genesis was empty.
    expect(await verifyNetwork(net('bitcoin:signet', 'btc'), { fetch: esplora(SIGNET_GENESIS) })).toMatchObject({ ok: true })
    expect((await verifyNetwork(net('bitcoin:signet', 'btc'), { fetch: esplora(MAINNET_GENESIS) })).error).toMatch(/^chain-id-mismatch/)
    expect(await verifyNetwork(net('bitcoin:regtest', 'btc'), { fetch: esplora(REGTEST_GENESIS) })).toMatchObject({ ok: true })
    expect((await verifyNetwork(net('bitcoin:regtest', 'btc'), { fetch: esplora(MAINNET_GENESIS) })).error).toMatch(/^chain-id-mismatch/)
    expect(await verifyNetwork(net('zcash:regtest', 'zcash'), { fetch: esplora(ZCASH_REGTEST_GENESIS) })).toMatchObject({ ok: true })
    expect((await verifyNetwork(net('zcash:regtest', 'zcash'), { fetch: esplora(MAINNET_GENESIS) })).error).toMatch(/^chain-id-mismatch/)
  })
  it('a UTXO network whose genesis the SDK does not know is refused, not waved through', async () => {
    expect((await verifyNetwork(net('bitcoin:somenet', 'btc'), { fetch: esplora(MAINNET_GENESIS) })).error).toMatch(/^bad-network/)
  })
})

describe('wallet_addEthereumChain and private addresses', () => {
  it('a site cannot point the wallet at a private / local RPC, https or not, without the opt-in', () => {
    for (const url of ['https://192.168.1.1:8545', 'https://localhost:8545', 'https://10.0.0.5', 'https://router.local']) {
      expect(parseAddChainParams([{ chainId: '0x2105', rpcUrls: [url] }], { known: () => true }), url).toMatchObject({ code: -32602 })
    }
    expect(parseAddChainParams([{ chainId: '0x2105', rpcUrls: ['https://192.168.1.1:8545'] }], { known: () => true, allowHttpLocal: true })).toMatchObject({ caip2: 'eip155:8453' })
    expect(parseAddChainParams([{ chainId: '0x2105', rpcUrls: ['https://192.168.1.1', 'https://mainnet.base.org'] }], { known: () => true })).toMatchObject({ rpcs: ['https://mainnet.base.org'] })
  })
})

describe('turning "Allow http for local nodes" off', () => {
  it('parks the http:// local endpoints already stored; turning it back on brings them back', async () => {
    const t = new NetworksTable(memoryJsonStorage<NetworksState>(null))
    await t.load()
    await t.setAllowHttpLocal(true)
    await t.addRpc('eip155:8453', 'http://192.168.1.5:8545')
    expect(await t.rpcUrlsFor('eip155:8453')).toContain('http://192.168.1.5:8545')
    await t.setAllowHttpLocal(false)
    expect(await t.rpcUrlsFor('eip155:8453')).not.toContain('http://192.168.1.5:8545')
    expect((await t.get('eip155:8453'))!.issues['http://192.168.1.5:8545']?.error).toMatch(/http/i)
    await t.setAllowHttpLocal(true)
    expect(await t.rpcUrlsFor('eip155:8453')).toContain('http://192.168.1.5:8545')
  })
})
