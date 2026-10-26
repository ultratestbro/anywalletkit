import { describe, expect, it } from 'vitest'
import { parseAddChainParams } from '../src/index.js'

// Audit 2026-10-25 round 3, L25 (neighbour of the networks fix): wallet_addEthereumChain took any
// https URL, so a page could point the extension's RPC reads at the user's router or a LAN service.
describe('extension wallet_addEthereumChain refuses private / local RPC hosts', () => {
  it('private hosts are dropped; with none left the request is refused', () => {
    for (const url of ['https://192.168.1.1', 'https://localhost:8545', 'https://10.0.0.5', 'https://172.20.1.1', 'https://169.254.169.254', 'https://router.local', 'https://[::1]:8545', 'https://[fd00::1]']) {
      expect(parseAddChainParams({ chainId: '0x1', rpcUrls: [url] }), url).toMatchObject({ code: -32602 })
    }
    expect(parseAddChainParams({ chainId: '0x1', rpcUrls: ['https://192.168.1.1', 'https://eth.example'] })).toMatchObject({ rpcs: ['https://eth.example'] })
  })
})
