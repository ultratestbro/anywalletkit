// Scan 2026-10-28 F12: a backslash in a gateway host (`https://localhost\x/{data}`) got past the private-host check,
// and fetch went to localhost. A fetch double stands in for the network.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'
import { ensCcipRequest } from '../src/index.js'

afterEach(() => vi.unstubAllGlobals())

const SENDER = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63' as const
const CALLDATA = '0x9061b923' as Hex
const answer = () => new Response('{"data":"0xabcdef"}', { headers: { 'content-type': 'application/json' } })

function globalFetch() {
  const asked: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { asked.push(String(url)); return answer() }))
  return asked
}
describe('F12: a backslash gateway host is not asked', () => {
  it.each(['https://localhost\\x/{sender}/{data}.json', 'https://192.168.1.1\\admin/{data}', 'https://127.0.0.1\\x/{data}'])('%s', async (t) => {
    const asked = globalFetch()
    await expect(ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: [t] })).rejects.toThrow(/not https on a public host; it was not asked/)
    expect(asked).toEqual([])
  })
})
