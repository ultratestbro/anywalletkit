// Scan 2026-10-27 (modules), the F37 class in wallet-evm: viem follows a contract's CCIP-Read OffchainLookup revert by
// default, so reading a token the user added (or one airdropped to them) could make the device fetch URLs the token
// names, LAN addresses included. The client is created with ccipRead: false.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeErrorResult, encodeFunctionData, parseAbi, type Hex } from 'viem'
import { createClient } from '../src/index.js'

afterEach(() => vi.unstubAllGlobals())

const TOKEN = '0x6982508145454Ce325dDbE47a25d4ec3d2311933'
const OFFCHAIN_LOOKUP = parseAbi(['error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)'])

describe('wallet-evm: no CCIP-Read on the account client (scan 2026-10-27 modules, F37 class)', () => {
  it('a token whose symbol() reverts with an OffchainLookup to the user\'s router makes no request', async () => {
    const fetched: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { fetched.push(String(url)); return new Response('{"data":"0x"}', { headers: { 'content-type': 'application/json' } }) }))
    const lookup = encodeErrorResult({ abi: OFFCHAIN_LOOKUP, errorName: 'OffchainLookup', args: [TOKEN, ['http://192.168.1.1/{sender}/{data}.json'], '0x', '0x12345678', '0x'] })
    const provider = {
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === 'eth_chainId') return '0x1'
        if ((params as Array<{ data: string }>)[0]!.data.startsWith('0x12345678')) return '0x' + '00'.repeat(32) // the callback viem would make
        throw Object.assign(new Error('execution reverted'), { code: 3, data: lookup })
      },
    }
    const client = createClient({ provider } as never)!
    const data = encodeFunctionData({ abi: parseAbi(['function symbol() view returns (string)']), functionName: 'symbol' }) as Hex
    await expect(client.call({ to: TOKEN, data })).rejects.toThrow()
    expect(fetched).toEqual([])
  })
})
