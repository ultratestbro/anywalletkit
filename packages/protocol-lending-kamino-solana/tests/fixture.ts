// A Solana account that records guards instead of signing, and a fetch that
// answers Kamino's API from canned data (shapes copied from live responses on
// 2026-10-13).
import type { IWalletAccount, IWalletAccountReadOnly, TransferResult } from '@anywalletkit/core'
import { SOLANA_MAINNET } from '../src/base.js'
import type { SerializedGuard } from '../src/base.js'

export const USER = 'KUMtRazMP7vwvc2kthnGZ9Cq6ZsGRiYC97snMYepNx9'
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const SOL = 'So11111111111111111111111111111111111111112'
export const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'
export const VAULT = 'HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E'
// The vault's shares mint as the kVault program derives it: ["shares", VAULT].
export const SHARES = '7D8C5pDFxug58L9zkwK7bCiDg4kD4AygzbcZUmf5usHS'
export const FARM = 'CKTEDx5z19CntAB9B66AxuS98S1NuCgMvfpsew7TQwi'
export const MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF'
export const USDC_RESERVE = 'D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59'
export const USDC_RESERVE_SMALL = 'AWnKJ9dsiHcoDCThxE5E93ikDTAXkApoNwrKM2tp9KFJ'
export const SOL_RESERVE = 'd4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q'
export const TX = 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQAFCQS7ZAe75yGHSSVtP8oET7zHdzfsGyGxvslIPEGbW7r6JoRGoJYd6HuHUFIZgdrJ9s+bmMaqYJru9M6sS+N4CH8='

export interface FakeAccount extends IWalletAccount {
  calls: Array<{ method: string; args: unknown[] }>
  sent: unknown[]
  /** Every guard handed to checkSerialized / sendSerialized. */
  guards: Array<{ method: 'check' | 'send'; base64: string; guard: SerializedGuard }>
  checkSerialized(base64: string, guard: SerializedGuard): Promise<{ quote: { fee: bigint } }>
  sendSerialized(base64: string, guard: SerializedGuard): Promise<{ hash: string; fee: bigint }>
  getMintInfo(mint: string): Promise<{ decimals: number }>
}

export function account(opts: { chain?: string; address?: string; mintInfo?: boolean } = {}): FakeAccount {
  const calls: FakeAccount['calls'] = [], sent: unknown[] = [], guards: FakeAccount['guards'] = []
  const rec = <T>(method: string, args: unknown[], value: T): T => { calls.push({ method, args }); return value }
  const address = opts.address ?? USER
  let n = 0
  const readOnly: IWalletAccountReadOnly = {
    chain: opts.chain ?? SOLANA_MAINNET,
    getAddress: async () => rec('getAddress', [], address),
    getBalance: async () => rec('getBalance', [], 10n ** 9n),
    getTokenBalance: async (t) => rec('getTokenBalance', [t], 0n),
    quoteSendTransaction: async (tx) => rec('quoteSendTransaction', [tx], { fee: 5000n }),
    quoteTransfer: async (o) => rec('quoteTransfer', [o], { fee: 5000n }),
    getTransactionReceipt: async (hash) => rec('getTransactionReceipt', [hash], { hash, status: 1 as const }),
    verify: async () => true,
  }
  const acc: FakeAccount = {
    ...readOnly,
    calls, sent, guards,
    needsNetwork: true,
    sign: async () => 'sig',
    signTransaction: async () => 'signed',
    sendTransaction: async (tx): Promise<TransferResult> => { sent.push(tx); return { hash: `tx${++n}`, fee: 5000n } },
    transfer: async (o): Promise<TransferResult> => { sent.push(o); return { hash: `tx${++n}`, fee: 5000n } },
    checkSerialized: async (base64, guard) => { guards.push({ method: 'check', base64, guard }); return { quote: { fee: 7_500n } } },
    sendSerialized: async (base64, guard) => { guards.push({ method: 'send', base64, guard }); sent.push(base64); return { hash: `sig${++n}`, fee: 7_500n } },
    getMintInfo: async (mint) => {
      if (opts.mintInfo === false) throw new Error('no rpc')
      const d: Record<string, number> = { [USDC]: 6, [SOL]: 9, [PYUSD]: 6, [SHARES]: 6 }
      if (!(mint in d)) throw new Error(`unknown mint ${mint}`)
      return rec('getMintInfo', [mint], { decimals: d[mint]! })
    },
    toReadOnlyAccount: () => readOnly,
    dispose: () => {},
  }
  return acc
}

export const vaultRow = {
  address: VAULT, programId: 'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd',
  state: {
    name: 'Steakhouse USDC', tokenMint: USDC, tokenMintDecimals: 6, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    sharesMint: SHARES, sharesMintDecimals: 6, tokenAvailable: '80843116919', sharesIssued: '18699216460837',
    minDepositAmount: '1000', minWithdrawAmount: '1000', performanceFeeBps: 500, managementFeeBps: 0,
    vaultFarm: FARM, vaultLookupTable: '9p2oT9J6BojHigd3V5qXzrwsQf4dtgMgLxtrzLVR3rwu',
    vaultAllocationStrategy: [
      { reserve: USDC_RESERVE, targetAllocationWeight: 9000, tokenAllocationCap: '1000000000000000', ctokenAllocation: '12345' },
      { reserve: USDC_RESERVE_SMALL, targetAllocationWeight: 0, tokenAllocationCap: '1000000000000000', ctokenAllocation: '1' },
    ],
  },
}

export const vaultMetrics = {
  apy7d: '0.0455', apy24h: '0.0494', apy30d: '0.0493', apy: '0.04515541708605886', apyActual: '0.0449684144438518', apyFarmRewards: '0',
  tokenPrice: '0.99986426', sharePrice: '1.0626357724583621359', tokensPerShare: '1.0627800342202071868',
  tokensAvailable: '80843.116919', tokensInvested: '19873153.911276426844', tokensInvestedUsd: '19870456.329364510182',
  sharesIssued: '18699216.460837', numberOfHolders: 3412,
}

export const reserves = [
  { reserve: SOL_RESERVE, liquidityToken: 'SOL', liquidityTokenMint: SOL, maxLtv: '0.74', borrowApy: '0.0594', supplyApy: '0.0457', totalSupply: '2292847.2', totalBorrow: '2089638.2', totalBorrowUsd: '224770841.8', totalSupplyUsd: '246628909.3' },
  { reserve: USDC_RESERVE_SMALL, liquidityToken: 'USDC', liquidityTokenMint: USDC, maxLtv: '0', borrowApy: '0', supplyApy: '0.1066', totalSupply: '104.18', totalBorrow: '0', totalBorrowUsd: '0', totalSupplyUsd: '104.18497866' },
  { reserve: USDC_RESERVE, liquidityToken: 'USDC', liquidityTokenMint: USDC, maxLtv: '0.8', borrowApy: '0.0612', supplyApy: '0.0474', totalSupply: '121109892.1', totalBorrow: '93000000', totalBorrowUsd: '93000000', totalSupplyUsd: '121109892.10' },
]

export const markets = [
  { name: 'SOL/BTC Market', isPrimary: true, description: 'SOL/BTC Pool', lendingMarket: MARKET, lookupTable: 'FGMSBiyVE8TvZcdQnZETAAKw28tkQJ2ccZy6pyp95URb', isCurated: false },
  { name: 'JLP Market', isPrimary: false, description: 'JLP', lendingMarket: 'DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek', lookupTable: null, isCurated: true },
]

export const obligation = {
  loanId: 'zncEB2kLmREYgbVG6aPS6D6NamMjDskXM5pwh5Ejmeu', marketId: MARKET, user: USER, elevationGroup: 0, leverage: '0',
  loanInfo: {
    collateral: { deposits: [{ tokenMint: USDC, tokenName: 'USDC', tokenAmount: '5.000123', tokenValue: '4.99' }, { tokenMint: SOL, tokenName: 'SOL', tokenAmount: '0.5', tokenValue: '53.7' }] },
    debt: { borrows: [{ tokenMint: USDC, tokenName: 'USDC', tokenAmount: '1.25', tokenValue: '1.25' }] },
    currentLtv: 0.021, maxLtv: 0.74, liquidationLtv: 0.75, closeFactor: 0.1,
  },
}

export interface FakeApi {
  fetch: typeof fetch
  requests: Array<{ url: string; method: string; body: unknown }>
  /** Override a route: path prefix → status + body. */
  routes: Map<string, { status: number; body: unknown }>
  position: { stakedShares: string; unstakedShares: string; totalShares: string } | null
  obligations: unknown
  /** What `/kvaults/vaults/<VAULT>` answers (default: the recorded row). */
  vault?: unknown
}

export function api(): FakeApi {
  const requests: FakeApi['requests'] = []
  const routes = new Map<string, { status: number; body: unknown }>()
  const f: FakeApi = {
    requests, routes, position: null, obligations: [],
    fetch: (async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input), path = url.replace('https://api.kamino.finance', '')
      const body = init?.body ? JSON.parse(init.body) : undefined
      requests.push({ url: path, method: init?.method ?? 'GET', body })
      const reply = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
      for (const [prefix, r] of routes) if (path.startsWith(prefix)) return reply(r.status, r.body)
      if (path === '/v2/kamino-market') return reply(200, markets)
      if (path === `/kamino-market/${MARKET}/reserves/metrics`) return reply(200, reserves)
      if (path === '/kvaults/vaults') return reply(200, [vaultRow])
      if (path === `/kvaults/vaults/${VAULT}`) return reply(200, f.vault ?? vaultRow)
      if (path === `/kvaults/vaults/${VAULT}/metrics`) return reply(200, vaultMetrics)
      if (path === `/kvaults/users/${USER}/positions/${VAULT}`) return f.position ? reply(200, { vaultAddress: VAULT, ...f.position }) : reply(404, { metadata: 'Account could not be found' })
      if (path === `/kamino-market/${MARKET}/users/${USER}/obligations`) return reply(200, f.obligations)
      if (path.startsWith('/ktx/')) return reply(200, { transaction: TX })
      return reply(404, { error: `no fixture for ${path}` })
    }) as unknown as typeof fetch,
  }
  return f
}
