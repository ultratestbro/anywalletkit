import { describe, expect, it } from 'vitest'
import { derivationVectors } from '@anywalletkit/conformance'
import { balancesWallet, formatAmount, portfolio, readBalances, tokenList, valued, type ListedToken, type PriceSource } from '../src/balances.ts'

const SEED = derivationVectors.seeds['bip39-abandon-12']!
const BASE = 'eip155:8453'
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const LIVE = process.env.LIVE === '1'

/** An EIP-1193 node stand-in: a native balance, ERC-20 balances by contract, and optionally a broken token. */
function fakeNode(chainId: number, native: bigint, tokens: Record<string, bigint>, broken?: string) {
  return {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      switch (method) {
        case 'eth_chainId': return '0x' + chainId.toString(16)
        case 'eth_getBalance': return '0x' + native.toString(16)
        case 'eth_call': {
          const to = String((params![0] as { to: string }).to).toLowerCase()
          if (to === broken) throw Object.assign(new Error('execution reverted'), { code: 3 })
          return '0x' + (tokens[to] ?? 0n).toString(16).padStart(64, '0')
        }
        default: throw new Error(`fake node: ${method} not served`)
      }
    },
  }
}

describe('Balances guide (docs) — offline', () => {
  it('the token list is the gas coin, the catalog tokens, then the user tokens without duplicates', () => {
    const own: ListedToken[] = [
      { chain: BASE, token: '0x0000000000000000000000000000000000000abc', symbol: 'MINE', decimals: 18, source: 'user' },
      { chain: BASE, token: BASE_USDC.toUpperCase().replace('0X', '0x'), symbol: 'USDC?', decimals: 6, source: 'user' },
    ]
    const list = tokenList(BASE, own)
    expect(list[0]).toMatchObject({ token: null, symbol: 'ETH', decimals: 18 })
    expect(list.find((t) => t.token === BASE_USDC)).toMatchObject({ symbol: 'USDC', decimals: 6, source: 'catalog' })
    expect(list.filter((t) => t.source === 'user').map((t) => t.symbol)).toEqual(['MINE']) // USDC is already in
  })

  it('reads native and token balances; one broken token does not hide the rest', async () => {
    const wallet = balancesWallet(SEED, { 8453: [fakeNode(8453, 1_500_000_000_000_000n, { [BASE_USDC]: 12_345_678n }, '0x0000000000000000000000000000000000000abc') as never] })
    try {
      const account = await wallet.getAccount(BASE)
      const rows = await readBalances(account, tokenList(BASE, [{ chain: BASE, token: '0x0000000000000000000000000000000000000abc', symbol: 'MINE', decimals: 18, source: 'user' }]))
      expect(rows[0]).toMatchObject({ symbol: 'ETH', amount: 1_500_000_000_000_000n })
      expect(rows.find((r) => r.symbol === 'USDC')!.amount).toBe(12_345_678n)
      const mine = rows.find((r) => r.symbol === 'MINE')!
      expect(mine.amount).toBeNull()
      expect(mine.error).toBeTruthy()
    } finally {
      wallet.dispose()
    }
  })

  it('formats exactly, without Number, above 2^53', () => {
    expect(formatAmount(12_345_678n, 6)).toBe('12.345678')
    expect(formatAmount(1_500_000_000_000_000n, 18)).toBe('0.0015')
    expect(formatAmount(10n ** 30n + 1n, 18)).toBe('1,000,000,000,000')
    expect(formatAmount(123_456_789_012_345_678_901_234_567n, 18, 2)).toBe('123,456,789.01')
    expect(formatAmount(0n, 6)).toBe('0')
  })

  it('a chain whose RPC is down comes back with its error, the others still load', async () => {
    const down = { request: async () => { throw new Error('connection refused') } }
    const wallet = balancesWallet(SEED, { 1: [down as never], 8453: [fakeNode(8453, 7n, {}) as never] })
    try {
      const [eth, base] = await portfolio(wallet, ['eip155:1', BASE])
      expect(eth!.rows.every((r) => r.amount === null)).toBe(true)
      expect(base!.rows[0]!.amount).toBe(7n)
    } finally {
      wallet.dispose()
    }
  })

  it('values rows with your price source; an unpriced token is null and stays out of the total', async () => {
    const prices: PriceSource = async (keys) => {
      expect(keys).not.toContain(`${BASE}/0x0000000000000000000000000000000000000abc`) // zero balances are not priced
      return { [`${BASE}/native`]: 3000, [`${BASE}/${BASE_USDC}`]: 1 }
    }
    const rows = [
      { chain: BASE, token: null, symbol: 'ETH', decimals: 18, source: 'catalog' as const, amount: 2n * 10n ** 18n },
      { chain: BASE, token: BASE_USDC, symbol: 'USDC', decimals: 6, source: 'catalog' as const, amount: 5_000_000n },
      { chain: BASE, token: '0x0000000000000000000000000000000000000def', symbol: 'NEW', decimals: 18, source: 'user' as const, amount: 10n ** 18n },
      { chain: BASE, token: '0x0000000000000000000000000000000000000abc', symbol: 'MINE', decimals: 18, source: 'user' as const, amount: 0n },
    ]
    const v = await valued(rows, prices)
    expect(v.totalUsd).toBe(6005)
    expect(v.rows.find((r) => r.symbol === 'NEW')!.usd).toBeNull()
    expect(v.unpriced).toBe(1)
  })
})

describe.skipIf(!LIVE)('Balances guide (docs) — live Base', () => {
  it('reads ETH and the catalog tokens over a public RPC', async () => {
    const wallet = balancesWallet(SEED, { 8453: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'] })
    try {
      const rows = await readBalances(await wallet.getAccount(BASE), tokenList(BASE))
      expect(rows.length).toBeGreaterThan(2)
      for (const r of rows) expect(typeof r.amount === 'bigint' || r.error).toBeTruthy()
      expect(typeof rows[0]!.amount).toBe('bigint')
    } finally {
      wallet.dispose()
    }
  }, 30_000)
})
