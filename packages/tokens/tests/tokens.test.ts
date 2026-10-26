import { describe, expect, it } from 'vitest'
import type { TokenInfo } from '@anywalletkit/core'
import { TokensError, TokensTable, assessToken, foldSymbol, inspectToken, memoryJsonStorage, swapSource, type TokensState, type UserToken } from '../src/index.js'

const PEPE = '0x6982508145454Ce325dDbE47a25d4ec3d2311933'
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const info = (over: Partial<TokenInfo> = {}): TokenInfo => ({ address: PEPE, standard: 'erc20', decimals: 18, symbol: 'PEPE', name: 'Pepe', totalSupply: 10n ** 30n, flags: [], ...over })
const codes = (i: TokenInfo, chain?: string) => assessToken(i, chain).risks.map((r) => r.code)

describe('assessToken', () => {
  it('a token with its own name: unlisted only, caution', () => {
    expect(assessToken(info())).toEqual({ level: 'caution', risks: [expect.objectContaining({ code: 'unlisted', level: 'caution' })] })
  })
  it('look-alikes of catalog symbols are impersonation (danger), however they are spelled', () => {
    for (const symbol of ['USDC', 'usdc', 'USDС' /* Cyrillic С */, 'U$DC', 'US​DC', 'ＵＳＤＣ' /* fullwidth */, 'USD₮', 'ΕΤΗ' /* Greek */, 'SOL']) {
      const a = assessToken(info({ symbol }))
      expect(a.level, symbol).toBe('danger')
      expect(a.risks[0]!.code, symbol).toBe('impersonation')
    }
    expect(codes(info({ symbol: 'USDC.e2' }))).not.toContain('impersonation')
  })
  it("a catalog symbol of the same chain is impersonation; another chain's listed token is not (only majors are global)", () => {
    expect(codes(info({ symbol: 'JUP' }), 'solana:mainnet')).not.toContain('impersonation') // real JUP; the catalog lists a bridged JUP on Unichain
    expect(codes(info({ symbol: 'JUP' }), 'eip155:130')).toContain('impersonation')
    expect(codes(info({ symbol: 'LINK' }), 'eip155:1')).toContain('impersonation')
    expect(codes(info({ symbol: 'LINK' }), 'eip155:143')).not.toContain('impersonation')
    expect(codes(info({ symbol: 'LINK' }))).not.toContain('impersonation')
    expect(codes(info({ symbol: 'GRAM' }), 'eip155:1')).toContain('impersonation') // a native coin, anywhere
    expect(codes(info({ symbol: 'LDO' }), 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).not.toContain('impersonation')
    expect(codes(info({ symbol: 'LDO' }), 'eip155:1')).toContain('impersonation')
  })
  it('odd characters, no symbol, zero supply, many decimals', () => {
    expect(codes(info({ symbol: 'PEPE🐸' }))).toContain('odd-characters')
    expect(codes(info({ name: 'Pe‮pe' }))).toContain('odd-characters')
    expect(codes(info({ symbol: '' }))).toEqual(['unlisted', 'no-symbol'])
    expect(codes(info({ totalSupply: 0n }))).toContain('zero-supply')
    expect(codes(info({ decimals: 30 }))).toContain('unusual-decimals')
  })
  it('chain facts: issuer powers that can take or trap funds are danger, the rest caution', () => {
    const a = assessToken(info({ standard: 'spl-token-2022', flags: ['mint-authority', 'freeze-authority', 'permanent-delegate', 'transfer-hook', 'transfer-fee'] }))
    expect(a.level).toBe('danger')
    expect(a.risks.map((r) => [r.code, r.level])).toEqual([
      ['permanent-delegate', 'danger'], ['transfer-hook', 'danger'],
      ['unlisted', 'caution'], ['mint-authority', 'caution'], ['freeze-authority', 'caution'], ['transfer-fee', 'caution'],
    ])
    expect(assessToken(info({ flags: ['non-transferable'] })).level).toBe('danger')
    expect(assessToken(info({ flags: ['upgradeable'] })).level).toBe('caution')
  })
  it('foldSymbol', () => {
    expect(foldSymbol(' u​s d₮ ')).toBe('USDT')
  })
})

const token = (over: Partial<UserToken> = {}): UserToken => ({ chain: 'eip155:1', address: PEPE, symbol: 'PEPE', name: 'Pepe', decimals: 18, standard: 'erc20', flags: [], addedAt: 1, ...over })

describe('TokensTable', () => {
  it('add / get / list / remove, addresses matched case-insensitively on EVM only', async () => {
    const storage = memoryJsonStorage<TokensState>()
    const t = new TokensTable(storage)
    await t.load()
    await t.add(token())
    await t.add(token({ chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: BONK, symbol: 'Bonk', name: 'Bonk', decimals: 5, standard: 'spl' }))
    expect(t.get('eip155:1', PEPE.toLowerCase())!.symbol).toBe('PEPE')
    expect(t.list('solana:mainnet').map((x) => x.address)).toEqual([BONK]) // stored under the catalog key
    expect(t.get('solana:mainnet', BONK.toLowerCase())).toBeUndefined()
    // re-adding refreshes in place
    await t.add(token({ name: 'Pepe v2' }))
    expect(t.list().map((x) => x.name)).toEqual(['Bonk', 'Pepe v2'])
    expect(await t.remove('eip155:1', PEPE)).toBe(true)
    expect(await t.remove('eip155:1', PEPE)).toBe(false)
    expect(storage.value!.tokens.map((x) => x.address)).toEqual([BONK])
    // a fresh table reads what was saved
    const again = new TokensTable(storage)
    await again.load()
    expect(again.list()).toHaveLength(1)
  })
  it('refuses catalog tokens, bad entries and a full list; reads before load throw', async () => {
    const t = new TokensTable(memoryJsonStorage<TokensState>(), { maxTokens: 1 })
    expect(() => t.list()).toThrow(TokensError)
    await t.load()
    await expect(t.add(token({ address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' }))).rejects.toMatchObject({ code: 'listed' })
    await expect(t.add(token({ address: '0x123' }))).rejects.toMatchObject({ code: 'bad-token' })
    await expect(t.add(token({ chain: 'ton:-239' }))).rejects.toMatchObject({ code: 'bad-token' })
    await expect(t.add(token({ decimals: 78 }))).rejects.toMatchObject({ code: 'bad-token' })
    await expect(t.add(token({ flags: ['made-up' as never] }))).rejects.toMatchObject({ code: 'bad-token' })
    await t.add(token())
    await expect(t.add(token({ address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE' }))).rejects.toMatchObject({ code: 'full' })
    expect(t.list()).toHaveLength(1)
  })
  it('drops corrupted stored entries; a failed read leaves the table unloaded instead of empty', async () => {
    const t = new TokensTable(memoryJsonStorage<TokensState>({ v: 1, tokens: [token(), { ...token(), decimals: -1 }, { junk: true } as never, token({ address: '0x0000000000000000000000000000000000000000' })] }))
    await t.load()
    expect(t.list()).toHaveLength(1)
    let fail = true
    const flaky = { get: async () => { if (fail) throw new Error('disk'); return null }, set: async () => {} }
    const u = new TokensTable(flaky)
    await expect(u.load()).rejects.toThrow('disk')
    expect(() => u.list()).toThrow(TokensError)
    fail = false
    await u.load()
    expect(u.list()).toEqual([])
  })
  it('a failed save leaves memory as stored; listeners hear successful writes', async () => {
    let saves = 0
    const storage = memoryJsonStorage<TokensState>()
    const t = new TokensTable({ get: storage.get, set: async (v) => { if (++saves === 2) throw new Error('quota'); await storage.set(v) } })
    await t.load()
    let heard = 0
    t.subscribe(() => { heard++ })
    await t.add(token())
    await expect(t.add(token({ address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', symbol: 'SHIB' }))).rejects.toThrow('quota')
    expect(t.list().map((x) => x.symbol)).toEqual(['PEPE'])
    expect(heard).toBe(1)
  })
})

describe('inspectToken', () => {
  const account = (chain: string, read: (a: string) => Promise<TokenInfo>) => ({ chain, getTokenInfo: read })
  it('catalog tokens come back as listed, without reading the chain', async () => {
    const r = await inspectToken(account('eip155:1', async () => { throw new Error('no read') }), '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')
    expect(r.listed?.symbol).toBe('USDC')
  })
  it('an unlisted token: info, assessment and the entry to add (Solana under the catalog key)', async () => {
    const r = await inspectToken(account('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', async (a) => info({ address: a, standard: 'spl', decimals: 5, symbol: 'Bonk', name: 'Bonk', flags: ['mint-authority'] })), ` ${BONK} `, () => 42)
    if (r.listed) throw new Error('unexpected')
    expect(r.token).toEqual({ chain: 'solana:mainnet', address: BONK, symbol: 'Bonk', name: 'Bonk', decimals: 5, standard: 'spl', flags: ['mint-authority'], addedAt: 42 })
    expect(r.assessment.risks.map((x) => x.code)).toEqual(['unlisted', 'mint-authority'])
    expect(swapSource(r.token)).toEqual({ fromToken: BONK, fromTokenDecimals: 5 })
  })
  it('an EVM account that has not learned its chain id yet is asked for it', async () => {
    const lazy = { chain: 'eip155:unknown', getChainId: async () => 1, getTokenInfo: async () => { throw new Error('no read') } }
    expect((await inspectToken(lazy, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).listed?.symbol).toBe('USDC')
    await expect(inspectToken({ chain: 'eip155:unknown', getTokenInfo: async () => info() }, PEPE)).rejects.toMatchObject({ code: 'unsupported-chain' })
  })
  it('refuses other chain families, bad addresses and accounts without getTokenInfo', async () => {
    await expect(inspectToken(account('ton:-239', async () => info()), 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs')).rejects.toMatchObject({ code: 'unsupported-chain' })
    await expect(inspectToken(account('eip155:1', async () => info()), 'PEPE')).rejects.toMatchObject({ code: 'bad-address' })
    await expect(inspectToken({ chain: 'eip155:1' }, PEPE)).rejects.toMatchObject({ code: 'unsupported-chain' })
  })
})
