import { describe, expect, it } from 'vitest'
import { getMintEncoder, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022'
import { WalletManagerSolana, type SolanaRpc } from '../src/index.js'

// Audit 2026-10-25 round 3, M10: `transfer({ token, recipient })` derived the recipient's ATA from
// whatever address it got. A user's token account or the mint itself as recipient gives an ATA
// nobody can sign for: the tokens are locked. A recipient owned by a token program or an
// executable account is now refused; an address with no account is an ordinary wallet. The same
// holds for a native SOL `transfer` (SOL sent to a program or a mint is lost).

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const TOKEN_ACCOUNT = 'BQcdHdAQW1hczDbBi9hiegXPR7MzRYNM4gYHBJLjHCkS'
const TOKEN22_ACCOUNT = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'
const PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const WALLET = 'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb' // no account on chain
const SYSTEM_WALLET = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' // a funded wallet
const BLOCKHASH = '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6'

const mint = Buffer.from(getMintEncoder().encode({ mintAuthority: null, supply: 0n, decimals: 6, isInitialized: true, freezeAuthority: null }) as Uint8Array).toString('base64')
const accounts: Record<string, { owner: string; executable?: boolean; data?: string }> = {
  [USDC]: { owner: TOKEN_PROGRAM_ADDRESS, data: mint },
  [TOKEN_ACCOUNT]: { owner: TOKEN_PROGRAM_ADDRESS, data: Buffer.alloc(165).toString('base64') },
  [TOKEN22_ACCOUNT]: { owner: TOKEN_2022_PROGRAM_ADDRESS, data: Buffer.alloc(170).toString('base64') },
  [PROGRAM]: { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true, data: '' },
  [SYSTEM_WALLET]: { owner: '11111111111111111111111111111111', data: '' },
}

function fakeRpc() {
  const info = (a: string) => { const v = accounts[a]; return v ? { data: [v.data ?? '', 'base64'], owner: v.owner, executable: v.executable ?? false, lamports: 1_000_000n, rentEpoch: 0n, space: 0n } : null }
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    getAccountInfo: (a) => ({ value: info(String(a)) }),
    getMultipleAccounts: (list) => ({ value: (list as unknown[]).map((a) => info(String(a))) }),
    getLatestBlockhash: () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }),
    getFeeForMessage: () => ({ value: 5000n }),
    getRecentPrioritizationFees: () => [],
    simulateTransaction: (_w, cfg) => ({ value: { err: null, unitsConsumed: 20_000n, logs: [], ...((cfg as { accounts?: { addresses: unknown[] } })?.accounts ? { accounts: (cfg as { accounts: { addresses: unknown[] } }).accounts.addresses.map(() => null) } : {}) } }),
    sendTransaction: () => 'A'.repeat(87),
  }
  return new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => { const h = handlers[m]; if (!h) throw new Error(`unmocked ${m}`); return h(...args) } }) })
}
const account = () => new WalletManagerSolana(SEED, { provider: fakeRpc() }).getAccount(0)

describe('a transfer goes to a wallet, not to a token account, a mint or a program', () => {
  for (const [name, recipient] of [['a token account', TOKEN_ACCOUNT], ['a Token-2022 account', TOKEN22_ACCOUNT], ['the mint', USDC], ['a program', PROGRAM]] as const) {
    it(`SPL transfer to ${name} is refused, the quote too`, async () => {
      const a = await account()
      await expect(a.transfer({ token: USDC, recipient, amount: 1n })).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'recipient-not-wallet' })
      await expect(a.quoteTransfer({ token: USDC, recipient, amount: 1n })).rejects.toMatchObject({ code: 'recipient-not-wallet' })
    })
    it(`SOL transfer to ${name} is refused`, async () => {
      await expect((await account()).transfer({ recipient, amount: 1n })).rejects.toMatchObject({ code: 'recipient-not-wallet' })
    })
  }

  it('a wallet (no account yet, or a System account) is fine', async () => {
    const a = await account()
    await expect(a.transfer({ token: USDC, recipient: WALLET, amount: 1n })).resolves.toMatchObject({ hash: 'A'.repeat(87) })
    await expect(a.transfer({ recipient: SYSTEM_WALLET, amount: 1n })).resolves.toMatchObject({ hash: 'A'.repeat(87) })
  })
})
