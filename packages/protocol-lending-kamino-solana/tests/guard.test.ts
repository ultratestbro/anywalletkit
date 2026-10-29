// The Earn vault's withdrawal through the REAL wallet-solana guard (checkSerialized over a fake RPC),
// not the recording account: the guard must let the vault burn exactly the shares being redeemed and
// nothing else (audit 2026-10-25, #1.3).
import { describe, expect, it } from 'vitest'
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getAddressEncoder,
  getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  createNoopSigner, type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCloseAccountInstruction } from '@solana-program/token'
import { WalletManagerSolana, decodeWireTransaction, resolveCompiledAccounts, unexpectedInstruction, type SolanaRpc } from '@anywalletkit/wallet-solana'
import { KaminoVaultProtocolSolana } from '../src/index.js'
import { vaultRules } from '../src/policy.js'
import { associatedTokenAddress } from '../src/pda.js'
import { KLEND_PROGRAM, KVAULT_PROGRAM, TOKEN_2022_PROGRAM } from '../src/programs.js'
import { SHARES, USDC, USDC_RESERVE, VAULT, api } from './fixture.js'
import { defaultChain } from './chain-fixture.js'

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

/** A kvault `withdraw` laid out as /ktx/kvault/withdraw builds it (user, vault, …, the wallet's USDC and shares accounts, the mints), extra writable accounts after. */
function withdrawTx(sharesAta: Address, usdcAta: Address, extra: Address[] = [], after: Instruction[] = []): string {
  const w = (address: string) => ({ address: address as Address, role: AccountRole.WRITABLE })
  const r = (address: string) => ({ address: address as Address, role: AccountRole.READONLY })
  const ix = {
    programAddress: KVAULT_PROGRAM as Address,
    accounts: [
      // global config, token vault, base vault authority: the live transaction's (2026-10-28)
      { address: ME, role: AccountRole.WRITABLE_SIGNER }, w(VAULT), r('BKyTcUe6daNG8HbgBix2ugdRHbykG2dK9hPBBqhUyoEX'), w('CKTEDx5z19CntAB9B66AxuS98S1NuCgMvfpsew7TQwi'),
      r('AyY6VCkHfTWdFs7SqBbu6AnCqLUhgzVHBzW3WcJu5Jc8'), w(usdcAta), w(USDC), w(sharesAta), w(SHARES), r(TOKEN_PROGRAM_ADDRESS), r(TOKEN_PROGRAM_ADDRESS), r(KLEND_PROGRAM),
      ...extra.map(w),
    ],
    data: Uint8Array.from([0xb7, 0x12, 0x46, 0x9c, 0x94, 0x6d, 0xa1, 0x22, 1, 0, 0, 0, 0, 0, 0, 0]),
  }
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (x) => setTransactionMessageFeePayer(ME, x),
    (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6' as never, lastValidBlockHeight: 100n }, x),
    (x) => appendTransactionMessageInstructions([ix, ...after], x),
  ) as TransactionMessage
  return getBase64EncodedWireTransaction(compileTransaction(msg as never) as Transaction)
}

type Atas = { sharesAta: Address; usdcAta: Address; otherAta: Address }
/** SPL Token CloseAccount (data 09): `account`'s rent to `destination`, signed by `owner`. */
const closeIx = (account: Address, destination: Address, owner: Address = ME, programAddress?: Address) =>
  getCloseAccountInstruction({ account, destination, owner: createNoopSigner(owner) }, programAddress ? { programAddress } : undefined)

async function setup(post: (a: Atas) => Record<string, State>, extra = false, after: (a: Atas) => Instruction[] = () => []) {
  const [sharesAta] = await findAssociatedTokenPda({ mint: SHARES as Address, owner: ME, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const [usdcAta] = await findAssociatedTokenPda({ mint: USDC as Address, owner: ME, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const [otherAta] = await findAssociatedTokenPda({ mint: OTHER_MINT, owner: ME, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  // The vault and its reserve as the chain has them (the module prices the shares from these).
  const chain = defaultChain()
  const pre = { [ME]: sys(SOL), [VAULT]: chain.get(VAULT)!, [USDC_RESERVE]: chain.get(USDC_RESERVE)!, [sharesAta]: tokenAccount(SHARES, ONE_SHARE), [usdcAta]: tokenAccount(USDC, 0n), [otherAta]: tokenAccount(OTHER_MINT, 500n) }
  const rpc = fakeRpc(pre, { ...pre, ...post({ sharesAta, usdcAta, otherAta }) })
  const kamino = api()
  kamino.routes.set(`/kvaults/users/${ME}/positions/${VAULT}`, { status: 200, body: { vaultAddress: VAULT, stakedShares: '0', unstakedShares: '1', totalShares: '1' } })
  kamino.routes.set('/ktx/kvault/withdraw', { status: 200, body: { transaction: withdrawTx(sharesAta, usdcAta, extra ? [otherAta] : [], after({ sharesAta, usdcAta, otherAta })) } })
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

  // Owner 2026-10-29: a full withdrawal from the API ends with CloseAccount on the emptied shares
  // account (rent back to the wallet); it was refused as "Instruction 1 (Tokenkeg…, data 09…)".
  it('a full withdrawal that closes the emptied shares account, rent to the wallet, passes', async () => {
    const { vault, rpc } = await setup(
      ({ usdcAta }) => ({ [ME]: sys(SOL - FEE + ATA_RENT), [usdcAta]: tokenAccount(USDC, ASSETS) }), // the shares account is gone
      false,
      ({ sharesAta }) => [closeIx(sharesAta, ME)],
    )
    await expect(vault.quoteWithdraw({ amount: 'max' })).resolves.toMatchObject({ shares: ONE_SHARE })
    await expect(vault.withdraw({ amount: 'max' })).resolves.toMatchObject({ hash: 'S'.repeat(87) })
    expect(rpc.sent).toHaveLength(1)
  })

  it('closing to another destination, or closing an account that is not the shares account, is refused', async () => {
    const post = ({ usdcAta }: Atas) => ({ [ME]: sys(SOL - FEE), [usdcAta]: tokenAccount(USDC, ASSETS) })
    const ATTACKER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address
    for (const after of [
      ({ sharesAta }: Atas) => [closeIx(sharesAta, ATTACKER)],
      ({ otherAta }: Atas) => [closeIx(otherAta, ME)],
      ({ usdcAta }: Atas) => [closeIx(usdcAta, ME)],
      // The Token-2022 program on the Token program's shares account.
      ({ sharesAta }: Atas) => [closeIx(sharesAta, ME, ME, TOKEN_2022_PROGRAM as Address)],
    ]) {
      const { vault, rpc } = await setup(post, false, after)
      // The wallet's own close check or the operation's rules, whichever sees it first.
      await expect(vault.withdraw({ amount: 'max' })).rejects.toMatchObject({ code: expect.stringMatching(/^(unexpected-instruction|closes-account)$/) })
      expect(rpc.sent).toHaveLength(0)
    }
  })

  it('the close is a withdrawal step only: a deposit may not carry it; a partial withdrawal may (the token program refuses a non-empty close)', async () => {
    const sharesAtas = [associatedTokenAddress(ME, SHARES, TOKEN_PROGRAM_ADDRESS), associatedTokenAddress(ME, SHARES, TOKEN_2022_PROGRAM)] as Address[]
    const accounts = { me: ME, vault: VAULT, mint: USDC, sharesMint: SHARES, tokenAta: associatedTokenAddress(ME, USDC, TOKEN_PROGRAM_ADDRESS), sharesAtas, farm: null, wsolAta: associatedTokenAddress(ME, 'So11111111111111111111111111111111111111112', TOKEN_PROGRAM_ADDRESS) }
    const odd = (ixs: Instruction[], op: 'deposit' | 'withdraw') => {
      const msg = pipe(
        createTransactionMessage({ version: 0 }),
        (x) => setTransactionMessageFeePayer(ME, x),
        (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6' as never, lastValidBlockHeight: 100n }, x),
        (x) => appendTransactionMessageInstructions(ixs, x),
      ) as TransactionMessage
      const layout = resolveCompiledAccounts(decodeWireTransaction(getBase64EncodedWireTransaction(compileTransaction(msg as never) as Transaction)))
      return unexpectedInstruction(layout.compiled, layout.accounts, vaultRules(op, accounts, { stake: false }))
    }
    expect(odd([closeIx(sharesAtas[0]!, ME)], 'deposit')).toMatchObject({ index: 0, program: TOKEN_PROGRAM_ADDRESS })
    expect(odd([closeIx(sharesAtas[1]!, ME, ME, TOKEN_2022_PROGRAM as Address)], 'deposit')).toMatchObject({ index: 0 })
    // Withdrawals (the rules do not know full from partial): each program on its own derivation passes, the owner must be the wallet.
    expect(odd([closeIx(sharesAtas[0]!, ME)], 'withdraw')).toBeUndefined()
    expect(odd([closeIx(sharesAtas[1]!, ME, ME, TOKEN_2022_PROGRAM as Address)], 'withdraw')).toBeUndefined()
    expect(odd([closeIx(sharesAtas[1]!, ME)], 'withdraw')).toMatchObject({ index: 0 })
    expect(odd([closeIx(sharesAtas[0]!, ME, 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address)], 'withdraw')).toMatchObject({ index: 0 })
  })
})
