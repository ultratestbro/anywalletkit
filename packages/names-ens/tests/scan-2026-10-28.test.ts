// Scan 2026-10-28 F12 + F13. F12: a backslash in a gateway host (`https://localhost\x/{data}`) got past the
// private-host check, and fetch went to localhost. F13: React Native's fetch follows a gateway's redirect whatever
// `redirect: 'error'` says, so the device sent a request to the LAN target before the final URL was checked. Now
// there, gateways are asked only through an app-supplied `fetch` (one that refuses redirects, e.g. a server
// proxy) or with `allowRedirectFollowingFetch`. A fetch double stands in for the network.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'
import { EnsNameError, createEnsCcipRead, ensCcipRead, ensCcipRequest, ensResolver } from '../src/index.js'

afterEach(() => vi.unstubAllGlobals())

const SENDER = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63' as const
const CALLDATA = '0x9061b923' as Hex
const answer = () => new Response('{"data":"0xabcdef"}', { headers: { 'content-type': 'application/json' } })

function globalFetch() {
  const asked: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { asked.push(String(url)); return answer() }))
  return asked
}
const asReactNative = () => vi.stubGlobal('navigator', { product: 'ReactNative' })

/** A runtime without a `process.versions.node` (a browser): gateways go through the global fetch (scan 2026-10-30 F17). Empty, not removed: libraries split it. */
const NODE_VERSION = Object.getOwnPropertyDescriptor(process.versions, 'node')!
const asBrowser = () => Object.defineProperty(process.versions, 'node', { ...NODE_VERSION, value: '' })
afterEach(() => { Object.defineProperty(process.versions, 'node', NODE_VERSION) })

describe('F12: a backslash gateway host is not asked', () => {
  it.each(['https://localhost\\x/{sender}/{data}.json', 'https://192.168.1.1\\admin/{data}', 'https://127.0.0.1\\x/{data}'])('%s', async (t) => {
    const asked = globalFetch()
    await expect(ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: [t] })).rejects.toThrow(/not https on a public host; it was not asked/)
    expect(asked).toEqual([])
  })
})

describe('F13: on React Native, resolver-chosen gateways are not fetched with a redirect-following fetch', () => {
  it('by default no gateway is asked, and the reason says why', async () => {
    asReactNative()
    const asked = globalFetch()
    const err = await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['https://gw.example/{sender}/{data}.json'] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EnsNameError)
    expect(String((err as Error).message)).toMatch(/off on React Native: its fetch follows redirects/)
    await expect(ensCcipRead.request({ data: CALLDATA, sender: SENDER, urls: ['https://gw.example/{data}'] })).rejects.toThrow(EnsNameError)
    expect(asked).toEqual([])
  })

  it('an app-supplied fetch (e.g. a server proxy) is used, after the same URL checks', async () => {
    asReactNative()
    const asked = globalFetch()
    const viaServer: string[] = []
    const ccip = createEnsCcipRead({ fetch: async (url, init) => { viaServer.push(`${init.method} ${url} ${init.redirect}`); return answer() } })
    expect(await ccip.request({ data: CALLDATA, sender: SENDER, urls: ['https://192.168.1.1/{data}', 'https://gw.example/{data}'] })).toBe('0xabcdef')
    expect(viaServer).toEqual([`GET https://gw.example/${CALLDATA} error`])
    expect(asked).toEqual([])
  })

  it('allowRedirectFollowingFetch brings direct lookups back; a followed redirect is still not used', async () => {
    asReactNative()
    const asked = globalFetch()
    expect(await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['https://gw.example/{data}'] }, { allowRedirectFollowingFetch: true })).toBe('0xabcdef')
    expect(asked).toHaveLength(1)
    vi.stubGlobal('fetch', vi.fn(async () => { const r = answer(); Object.defineProperty(r, 'url', { value: 'http://192.168.1.1/apply.cgi' }); return r }))
    await expect(ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['https://gw.example/{data}'] }, { allowRedirectFollowingFetch: true })).rejects.toThrow(/redirected; the answer was not used/)
  })

  it('ensResolver takes the same options for the client it builds', () => {
    expect(() => ensResolver({ rpcUrl: 'https://rpc.example', ccip: { allowRedirectFollowingFetch: true } })).not.toThrow()
  })

  it('a runtime whose fetch refuses redirects (browsers) asks gateways directly, redirect: error', async () => {
    asBrowser()
    const seen: Array<string | undefined> = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { seen.push(init.redirect); return answer() }))
    expect(await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['https://gw.example/{data}'] })).toBe('0xabcdef')
    expect(seen).toEqual(['error'])
  })
})
