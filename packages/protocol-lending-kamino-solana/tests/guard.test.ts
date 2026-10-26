// The Earn vault's withdrawal through the REAL wallet-solana guard (checkSerialized over a fake RPC),
// not the recording account: the guard must let the vault burn exactly the shares being redeemed and
// nothing else (audit 2026-10-25, #1.3).
import { describe, expect, it } from 'vitest'
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getAddressEncoder,
  getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token'
import { WalletManagerSolana, type SolanaRpc } from '@anywalletkit/wallet-solana'
import { KaminoVaultProtocolSolana } from '../src/index.js'
import { KVAULT_PROGRAM } from '../src/programs.js'
import { SHARES, USDC, VAULT, api } from './fixture.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ME = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' as Address
const OTHER_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' as Address
const FEE = 5_000n
const ATA_RENT = 2_039_280n
const SOL = 1_000_000_000n
const ONE_SHARE = 1_000_000n
const ASSETS = 1_062_780n // 1 share × tokensPerShare 1.06278…
const MINTS = { [SHARES]: 6, [USDC]: 6 }

type State = { lamports: bigint; owner: string; data: Uint8Array } | null
const pk = (a: string) => getAddressEncoder().encode(a as Address) as Uint8Array
function tokenAccount(mint: string, amount: bigint): State {
  const data = new Uint8Array(165)
  data.set(pk(mint), 0)
  data.set(pk(ME), 32)
  new DataView(data.buffer).setBigUint64(64, amount, true)
  data[108] = 1
  return { lamports: ATA_RENT, owner: TOKEN_PROGRAM_ADDRESS, data }
}
const sys = (lamports: bigint): State => ({ lamports, owner: '11111111111111111111111111111111', data: new Uint8Array() })
const toRpc = (s: State) => (s ? { lamports: s.lamports, owner: s.owner, data: [Buffer.from(s.data).toString('base64'), 'base64'], executable: false, rentEpoch: 0n, space: BigInt(s.data.length) } : null)

function fakeRpc(pre: Record<string, State>, post: Record<string, State>) {
  const sent: string[] = []
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    getMultipleAccounts: (addrs) => ({ value: (addrs as string[]).map((a) => toRpc(pre[a] ?? null)) }),
    simulateTransaction: (_w, cfg) => {
      const addrs = (cfg as { accounts: { addresses: string[] } }).accounts.addresses
      return { value: { err: null, unitsConsumed: 200_000n, logs: [], accounts: addrs.map((a) => toRpc(post[a] ?? null)) } }
    },
    getFeeForMessage: () => ({ value: FEE }),
    // SPL mints (decimals at byte 44): the module checks the API's decimals against them.
    getAccountInfo: (a) => {
      const decimals = (MINTS as Record<string, number>)[a as string]
      if (decimals === undefined) return { value: null }
      const data = new Uint8Array(82); data[44] = decimals; data[45] = 1
      return { value: { lamports: 1n, owner: TOKEN_PROGRAM_ADDRESS, data: [Buffer.from(data).toString('base64'), 'base64'], executable: false, rentEpoch: 0n, space: 82n } }
    },
    sendTransaction: (w) => { sent.push(w as string); return 'S'.repeat(87) },
  }
  const rpc = new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => { const h = handlers[m]; if (!h) throw new Error(`unmocked ${m}`); return h(...args) } }) })
  return { rpc, sent }
}

/** A kvault `withdraw` touching the wallet's share and USDC accounts, as /ktx/kvault/withdraw builds it. */
function withdrawTx(sharesAta: Address, usdcAta: Address, extra: Address[] = []): string {
  const ix = {
    programAddress: KVAULT_PROGRAM as Address,
    accounts: [{ address: ME, role: AccountRole.WRITABLE_SIGNER }, ...[sharesAta, usdcAta, ...extra].map((address) => ({ address, role: AccountRole.WRITABLE }))],
    data: Uint8Array.from([0xb7, 0x12, 0x46, 0x9c, 0x94, 0x6d, 0xa1, 0x22, 1, 0, 0, 0, 0, 0, 0, 0]),
  }
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (x) => setTransactionMessageFeePayer(ME, x),
    (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6' as never, lastValidBlockHeight: 100n }, x),
    (x) => appendTransactionMessageInstructions([ix], x),
  ) as TransactionMessage
  return getBase64EncodedWireTransaction(compileTransaction(msg as never) as Transaction)
}

async function setup(post: (a: { sharesAta: Address; usdcAta: Address; otherAta: Address }) => Record<string, State>, extra = false) {
  const [sharesAta] = await findAssociatedTokenPda({ mint: SHARES as Address, owner: ME, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const [usdcAta] = await findAssociatedTokenPda({ mint: USDC as Address, owner: ME, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const [otherAta] = await findAssociatedTokenPda({ mint: OTHER_MINT, owner: ME, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const pre = { [ME]: sys(SOL), [sharesAta]: tokenAccount(SHARES, ONE_SHARE), [usdcAta]: tokenAccount(USDC, 0n), [otherAta]: tokenAccount(OTHER_MINT, 500n) }
  const rpc = fakeRpc(pre, { ...pre, ...post({ sharesAta, usdcAta, otherAta }) })
  const kamino = api()
  kamino.routes.set(`/kvaults/users/${ME}/positions/${VAULT}`, { status: 200, body: { vaultAddress: VAULT, stakedShares: '0', unstakedShares: '1', totalShares: '1' } })
  kamino.routes.set('/ktx/kvault/withdraw', { status: 200, body: { transaction: withdrawTx(sharesAta, usdcAta, extra ? [otherAta] : []) } })
  const account = await new WalletManagerSolana(SEED, { provider: rpc.rpc }).getAccount(0)
  return { vault: new KaminoVaultProtocolSolana(account, { vault: VAULT, fetch: kamino.fetch }), rpc }
}

describe('Kamino vault withdrawal through the wallet-solana guard', () => {
  it('burning the redeemed shares for the asset is allowed: quote and withdraw both pass, one send', async () => {
    const { vault, rpc } = await setup(({ sharesAta, usdcAta }) => ({ [ME]: sys(SOL - FEE), [sharesAta]: tokenAccount(SHARES, 0n), [usdcAta]: tokenAccount(USDC, ASSETS) }))
    const q = await vault.quoteWithdraw({ amount: 'max' })
    expect(q.shares).toBe(ONE_SHARE)
    await expect(vault.withdraw({ amount: 'max' })).resolves.toMatchObject({ hash: 'S'.repeat(87) })
    expect(rpc.sent).toHaveLength(1)
  })

  it('burning more shares than redeemed is refused', async () => {
    const { vault, rpc } = await setup(({ sharesAta, usdcAta }) => ({ [ME]: sys(SOL - FEE), [sharesAta]: tokenAccount(SHARES, 0n), [usdcAta]: tokenAccount(USDC, ASSETS) }))
    // the wallet asks for half its position: half the shares may go, not all
    await expect(vault.withdraw({ amount: ASSETS / 2n })).rejects.toMatchObject({ code: 'token-out' })
    expect(rpc.sent).toHaveLength(0)
  })

  it('any other token leaving the wallet is still refused', async () => {
    const { vault, rpc } = await setup(({ sharesAta, usdcAta, otherAta }) => ({ [ME]: sys(SOL - FEE), [sharesAta]: tokenAccount(SHARES, 0n), [usdcAta]: tokenAccount(USDC, ASSETS), [otherAta]: tokenAccount(OTHER_MINT, 0n) }), true)
    await expect(vault.withdraw({ amount: 'max' })).rejects.toMatchObject({ code: 'token-drain' })
    expect(rpc.sent).toHaveLength(0)
  })
})
