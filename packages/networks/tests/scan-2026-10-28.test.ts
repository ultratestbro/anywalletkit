import { describe, expect, it } from 'vitest'
import { checkRpcUrl, isPublicHttpsUrl, parseAddChainParams, parseUrl } from '../src/index.js'

// Scan 2026-10-28 F12: the hand-written parseUrl ended the authority only at / ? #, while WHATWG parsers
// (browsers, Node, the extension) and OkHttp also end it at a backslash. `https://192.168.1.1\x` was
// checked as the host "192.168.1.1\x" (public) and fetched from 192.168.1.1. A URL with a backslash,
// tab, CR/LF or another control character is now refused before parsing.

const BACKSLASH = ['https://127.0.0.1\\x', 'https://localhost\\x', 'https://192.168.1.1\\admin', 'https://192.168.1.1\\.example.com']

describe('F12: backslash and control characters in a URL', () => {
  it.each(BACKSLASH)('%s is not a public https URL and not an RPC URL', (u) => {
    expect(parseUrl(u)).toBeNull()
    expect(isPublicHttpsUrl(u)).toBe(false)
    expect(checkRpcUrl(u)).toMatchObject({ ok: false, reason: 'not-a-url' })
  })

  it.each(['https://rpc.example\t.org/', 'https://rpc.example.org/a\nb', 'https://rpc.example.org\r/', 'https://rpc\x00.example.org/', 'https://rpc.example.org/\x7f', 'https://gw.example/x\\y'])(
    'a control character or backslash anywhere is refused: %j', (u) => {
      expect(parseUrl(u)).toBeNull()
      expect(isPublicHttpsUrl(u)).toBe(false)
    })

  it('a site cannot add a backslash RPC URL', () => {
    expect(parseAddChainParams({ chainId: '0x1', rpcUrls: ['https://192.168.1.1\\admin'] })).not.toMatchObject({ rpcs: ['https://192.168.1.1\\admin'] })
  })

  it('ordinary URLs still pass', () => {
    expect(isPublicHttpsUrl('https://gw.example/{sender}/{data}.json')).toBe(true)
    expect(checkRpcUrl('  https://rpc.example.org/v1?key=a#x  ')).toMatchObject({ ok: true, url: 'https://rpc.example.org/v1?key=a#x', local: false })
    expect(isPublicHttpsUrl('https://192.168.1.1/admin')).toBe(false)
  })
})
