import { describe, expect, it } from 'vitest'
import { parseAddChainParams } from '../src/index.js'

// Scan 2026-10-28 F12: a site's wallet_addEthereumChain rpcUrls with a backslash in the host
// (`https://192.168.1.1\admin`) passed isSiteRpcUrl, and the service worker's fetch (WHATWG) went to
// 192.168.1.1. The shared URL policy now refuses any URL with a backslash or a control character.

describe('F12: a site cannot add a backslash RPC URL to a private host', () => {
  it.each(['https://127.0.0.1\\x', 'https://localhost\\x', 'https://192.168.1.1\\admin'])('%s is dropped', (u) => {
    const out = parseAddChainParams({ chainId: '0x1', rpcUrls: [u] }) as { rpcs?: string[] }
    expect(out.rpcs ?? []).not.toContain(u)
  })
  it('the slash form is refused too', () => {
    const out = parseAddChainParams({ chainId: '0x1', rpcUrls: ['https://192.168.1.1/admin'] }) as { rpcs?: string[] }
    expect(out.rpcs ?? []).toEqual([])
  })
})
