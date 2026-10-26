import { describe, expect, it } from 'vitest'
import type { EIP1193Provider, Hex } from 'viem'
import { NotATokenError } from '@anywalletkit/core'
import { WalletAccountReadOnlyEvm } from '../src/index.js'
import { decodeTokenString } from '../src/token-info.js'
import FIXTURES from './fixtures-token-info.json' with { type: 'json' }

// eth_call / eth_getStorageAt answers recorded from Ethereum mainnet on 2026-10-26.
type Fixture = { address: string; calls: Record<string, string | null>; slots: Record<string, string> }
const ZERO32 = `0x${'0'.repeat(64)}`
const reverted = () => Object.assign(new Error('execution reverted'), { code: 3, data: '0x' })

function provider(f: { code: Hex; calls?: Record<string, string | null>; slots?: Record<string, string> }): EIP1193Provider {
  const handlers: Record<string, (p: unknown[]) => unknown> = {
    eth_chainId: () => '0x1',
    eth_getCode: () => f.code,
    eth_call: (p) => {
      const data = (p[0] as { data: string }).data.slice(0, 10)
      const out = f.calls?.[data]
      if (out === null) throw reverted()
      return out ?? '0x'
    },
    eth_getStorageAt: (p) => f.slots?.[(p[1] as string).toLowerCase()] ?? ZERO32,
  }
  return { request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    const h = handlers[method]
    if (!h) throw new Error(`unexpected ${method}`)
    return h(params ?? [])
  } } as unknown as EIP1193Provider
}
const accountFor = (p: EIP1193Provider) => new WalletAccountReadOnlyEvm('0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA', { provider: p, chainId: 1 })
const fromFixture = (f: Fixture) => accountFor(provider({ code: '0x6080', calls: f.calls, slots: f.slots }))

describe('getTokenInfo (mainnet answers)', () => {
  it('LDO: a plain ERC-20, nothing flagged', async () => {
    const info = await fromFixture(FIXTURES.LDO).getTokenInfo(FIXTURES.LDO.address.toLowerCase())
    expect(info).toMatchObject({ address: FIXTURES.LDO.address, standard: 'erc20', decimals: 18, symbol: 'LDO', name: 'Lido DAO Token', flags: [] })
    expect(info.totalSupply).toBe(10n ** 27n)
  })
  it('USDC: 6 decimals and upgradeable (ZeppelinOS proxy slot)', async () => {
    const info = await fromFixture(FIXTURES.USDC).getTokenInfo(FIXTURES.USDC.address)
    expect(info).toMatchObject({ decimals: 6, symbol: 'USDC', name: 'USD Coin', flags: ['upgradeable'] })
  })
  it('MKR: bytes32 symbol and name are decoded', async () => {
    const info = await fromFixture(FIXTURES.MKR).getTokenInfo(FIXTURES.MKR.address)
    expect(info).toMatchObject({ decimals: 18, symbol: 'MKR', name: 'Maker' })
  })
  it('an NFT (BAYC: decimals() reverts) is not a token', async () => {
    await expect(fromFixture(FIXTURES.BAYC).getTokenInfo(FIXTURES.BAYC.address)).rejects.toThrow(NotATokenError)
    await expect(fromFixture(FIXTURES.BAYC).getTokenInfo(FIXTURES.BAYC.address)).rejects.toThrow(/no decimals\(\)/)
  })
})

describe('getTokenInfo refusals', () => {
  it('no code, an EIP-7702 delegated account, a bad address, absurd decimals', async () => {
    await expect(accountFor(provider({ code: '0x' })).getTokenInfo('0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32')).rejects.toThrow(/no contract code/)
    await expect(accountFor(provider({ code: `0xef0100${'ab'.repeat(20)}` })).getTokenInfo('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).rejects.toThrow(/EIP-7702/)
    await expect(accountFor(provider({ code: '0x60' })).getTokenInfo('not-an-address')).rejects.toThrow(NotATokenError)
    const huge = `0x${(1000n).toString(16).padStart(64, '0')}`
    await expect(accountFor(provider({ code: '0x60', calls: { '0x313ce567': huge } })).getTokenInfo('0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32')).rejects.toThrow(/decimals\(\) returned 1000/)
  })
  it('a transport failure is not swallowed as "not a token"', async () => {
    const p = { request: async ({ method }: { method: string }) => {
      if (method === 'eth_getCode') return '0x60'
      if (method === 'eth_call') throw Object.assign(new Error('fetch failed'), { code: -32603 })
      return ZERO32
    } } as unknown as EIP1193Provider
    await expect(accountFor(p).getTokenInfo('0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32')).rejects.not.toThrow(NotATokenError)
  })
})

describe('decodeTokenString', () => {
  it('ABI strings, bytes32, malformed and non-UTF-8 input', () => {
    expect(decodeTokenString(undefined)).toBe('')
    expect(decodeTokenString('0x')).toBe('')
    expect(decodeTokenString(`0x${'4d4b52'.padEnd(64, '0')}`)).toBe('MKR')
    // offset pointing past the end, and a length running past the end
    expect(decodeTokenString(`0x${'ff'.padStart(64, '0')}${'00'.repeat(32)}`)).toBe('')
    expect(decodeTokenString(`0x${'20'.padStart(64, '0')}${'ff'.padStart(64, '0')}${'41'.padEnd(64, '0')}`)).toBe('')
    // invalid UTF-8 (a lone continuation byte) → ''
    expect(decodeTokenString(`0x${'20'.padStart(64, '0')}${'01'.padStart(64, '0')}${'80'.padEnd(64, '0')}`)).toBe('')
    // multi-byte UTF-8 survives ("₮")
    expect(decodeTokenString(`0x${'20'.padStart(64, '0')}${'03'.padStart(64, '0')}${'e282ae'.padEnd(64, '0')}`)).toBe('₮')
  })
})
