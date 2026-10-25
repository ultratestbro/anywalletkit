import { describe, expect, it } from 'vitest'
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, compressTransactionMessageUsingAddressLookupTables, createNoopSigner, createTransactionMessage,
  getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, setTransactionMessageLifetimeUsingDurableNonce,
  type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import {
  AuthorityType, TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getBatchInstruction, getBurnCheckedInstruction, getCloseAccountInstruction, getSetAuthorityInstruction, getTransferCheckedInstruction,
  getUnwrapLamportsInstruction, getWithdrawExcessLamportsInstruction,
} from '@solana-program/token'
import { getUpdateTokenGroupUpdateAuthorityInstruction, getUpdateTokenMetadataUpdateAuthorityInstruction } from '@solana-program/token-2022'
import {
  getAllocateInstruction, getAssignInstruction, getAuthorizeNonceAccountInstruction, getCreateAccountAllowPrefundInstruction, getCreateAccountInstruction, getTransferSolWithSeedInstruction,
  getWithdrawNonceAccountInstruction,
} from '@solana-program/system'
import { decodeWireTransaction, describeTransaction, WalletManagerSolana, type SolanaConfig, type SolanaRpc } from '../src/index.js'

// Audit 2026-10-25 (post-release), H1: `sendSerialized` refused System Assign/Allocate, token
// SetAuthority and CloseAccount-to-someone-else, but `sendTransaction` / `signTransaction` of a
// compiled transaction (base64 wire or kit `Transaction`) or a kit message signed them.
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' as Address
const OTHER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address
const FRESH = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo' as Address
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address
const TABLE = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' as Address
const NONCE_ACCOUNT = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' as Address
const BLOCKHASH = '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6'
const me = createNoopSigner(ADDR0)

function fakeRpc() {
  const sent: string[] = []
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    simulateTransaction: () => ({ value: { err: null, unitsConsumed: 50_000n, logs: [] } }),
    getFeeForMessage: () => ({ value: 5_000n }),
    getLatestBlockhash: () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }),
    getRecentPrioritizationFees: () => [],
    sendTransaction: (wire) => { sent.push(wire as string); return 'B'.repeat(87) },
  }
  const rpc = new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => { const h = handlers[m]; if (!h) throw new Error(`unmocked ${m}`); return h(...args) } }) })
  return { rpc, sent }
}

const account = async (config: Partial<SolanaConfig> = {}) => {
  const f = fakeRpc()
  return { f, a: await new WalletManagerSolana(SEED, { provider: f.rpc, priorityFee: false, ...config }).getAccount(0) }
}

function message(instructions: Instruction[], opts: { lookup?: Address[]; nonce?: boolean } = {}): TransactionMessage {
  let msg = pipe(
    createTransactionMessage({ version: 0 }),
    (x) => setTransactionMessageFeePayer(ADDR0, x),
    (x) => opts.nonce
      ? setTransactionMessageLifetimeUsingDurableNonce({ nonce: BLOCKHASH as never, nonceAccountAddress: NONCE_ACCOUNT, nonceAuthorityAddress: ADDR0 }, x)
      : setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 100n }, x),
    (x) => appendTransactionMessageInstructions(instructions, x),
  ) as TransactionMessage
  if (opts.lookup) msg = compressTransactionMessageUsingAddressLookupTables(msg as never, { [TABLE]: opts.lookup }) as never
  return msg
}
const wire = (instructions: Instruction[], opts: { lookup?: Address[]; nonce?: boolean } = {}) =>
  getBase64EncodedWireTransaction(compileTransaction(message(instructions, opts) as never) as Transaction)

/** Every way a caller hands the general signing path a transaction. */
const forms = (instructions: Instruction[], opts: { lookup?: Address[]; nonce?: boolean } = {}) => {
  const base64 = wire(instructions, opts)
  return { base64, compiled: decodeWireTransaction(base64), message: message(instructions, opts) }
}

describe('compiled and message transactions get the authority guards of sendSerialized', async () => {
  const [ata] = await findAssociatedTokenPda({ mint: USDC, owner: ADDR0, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const [otherAta] = await findAssociatedTokenPda({ mint: USDC, owner: OTHER, tokenProgram: TOKEN_PROGRAM_ADDRESS })

  const refused: Array<[string, Instruction[], string]> = [
    ['System Assign of this wallet', [getAssignInstruction({ account: me, programAddress: OTHER })], 'core-instruction'],
    ['System Allocate of this wallet', [getAllocateInstruction({ newAccount: me, space: 8n })], 'core-instruction'],
    ['nonce authority handed away', [getAuthorizeNonceAccountInstruction({ nonceAccount: NONCE_ACCOUNT, nonceAuthority: me, newNonceAuthority: OTHER })], 'core-instruction'],
    ['an undecodable System instruction', [{ programAddress: '11111111111111111111111111111111' as Address, accounts: [{ address: ADDR0, role: AccountRole.WRITABLE_SIGNER }], data: new Uint8Array([99, 0, 0, 0]) }], 'core-instruction'],
    ['token account owner changed', [getSetAuthorityInstruction({ owned: ata, owner: me, authorityType: AuthorityType.AccountOwner, newAuthority: OTHER })], 'sets-authority'],
    ['token account closed to someone else', [getCloseAccountInstruction({ account: ata, destination: OTHER, owner: me })], 'closes-account'],
    // Review round (same day): shapes the first cut let through.
    ['a token Batch (it can carry a SetAuthority)', [getBatchInstruction([getSetAuthorityInstruction({ owned: ata, owner: me, authorityType: AuthorityType.AccountOwner, newAuthority: OTHER })])], 'core-instruction'],
    ['a token Batch carrying only a transfer', [getBatchInstruction([getTransferCheckedInstruction({ source: ata, mint: USDC, destination: otherAta, authority: me, amount: 1n, decimals: 6 })])], 'core-instruction'],
    ['CreateAccountAllowPrefund of this wallet', [getCreateAccountAllowPrefundInstruction({ newAccount: me, payer: me, lamports: 0n, space: 0n, programAddress: OTHER })], 'core-instruction'],
    ['CreateAccount of this wallet (a 0-lamport wallet behind a relayer)', [getCreateAccountInstruction({ newAccount: me, payer: createNoopSigner(OTHER), lamports: 1n, space: 0n, programAddress: OTHER })], 'core-instruction'],
    ['token metadata update authority handed away', [getUpdateTokenMetadataUpdateAuthorityInstruction({ metadata: USDC, updateAuthority: me, newUpdateAuthority: OTHER })], 'sets-authority'],
    ['token group update authority handed away', [getUpdateTokenGroupUpdateAuthorityInstruction({ group: USDC, updateAuthority: me, newUpdateAuthority: OTHER })], 'sets-authority'],
    ['excess lamports withdrawn to someone else', [getWithdrawExcessLamportsInstruction({ source: ata, destination: OTHER, authority: me })], 'moves-lamports'],
    ['wrapped SOL unwrapped to someone else', [getUnwrapLamportsInstruction({ source: ata, destination: OTHER, authority: me, amount: null })], 'moves-lamports'],
    ['a nonce account withdrawn to someone else', [getWithdrawNonceAccountInstruction({ nonceAccount: NONCE_ACCOUNT, recipientAccount: OTHER, nonceAuthority: me, withdrawAmount: 1n })], 'moves-lamports'],
    ['a seed account emptied to someone else', [getTransferSolWithSeedInstruction({ source: FRESH, baseAccount: me, destination: OTHER, amount: 1n, fromSeed: 's', fromOwner: '11111111111111111111111111111111' as Address })], 'moves-lamports'],
  ]

  for (const [name, ixs, code] of refused) {
    it(`refuses ${name} — base64, kit Transaction and message, sign and send — before signing`, async () => {
      const { f, a } = await account()
      const tx = forms(ixs)
      for (const input of [tx.base64, tx.compiled, tx.message]) {
        await expect(a.sendTransaction(input)).rejects.toMatchObject({ name: 'UnsafeTransactionError', code })
        await expect(a.signTransaction(input)).rejects.toMatchObject({ name: 'UnsafeTransactionError', code })
        await expect(a.quoteSendTransaction(input)).rejects.toMatchObject({ code })
      }
      expect(f.sent).toHaveLength(0)
    })
  }

  it('refuses a close whose destination sits in an unresolved lookup table (it cannot be this wallet)', async () => {
    const { f, a } = await account()
    const { base64 } = forms([getCloseAccountInstruction({ account: ata, destination: OTHER, owner: me })], { lookup: [OTHER] })
    expect(describeTransaction(base64, { account: ADDR0 }).items.some((i) => i.type === 'unknown')).toBe(true)
    await expect(a.sendTransaction(base64)).rejects.toMatchObject({ code: 'closes-account' })
    await expect(a.signTransaction(base64)).rejects.toMatchObject({ code: 'closes-account' })
    expect(f.sent).toHaveLength(0)
  })

  it('still signs the everyday shapes: transfers (also through a lookup table), burns, closes to self, durable nonces, fresh accounts', async () => {
    const { f, a } = await account()
    const transfer = getTransferCheckedInstruction({ source: ata, mint: USDC, destination: otherAta, authority: me, amount: 1n, decimals: 6 })
    const ok: Array<[Instruction[], { lookup?: Address[]; nonce?: boolean }]> = [
      [[transfer], {}],
      [[transfer], { lookup: [otherAta] }],
      [[getBurnCheckedInstruction({ account: ata, mint: USDC, authority: me, amount: 1n, decimals: 6 })], {}],
      [[getCloseAccountInstruction({ account: ata, destination: ADDR0, owner: me })], {}],
      [[getWithdrawExcessLamportsInstruction({ source: ata, destination: ADDR0, authority: me })], {}],
      [[getUnwrapLamportsInstruction({ source: ata, destination: ADDR0, authority: me, amount: null })], {}],
      [[getWithdrawNonceAccountInstruction({ nonceAccount: NONCE_ACCOUNT, recipientAccount: ADDR0, nonceAuthority: me, withdrawAmount: 1n })], {}],
      [[transfer], { nonce: true }],
      // Allocate + Assign of a FRESH keypair (another signer) is how programs create accounts that already hold lamports
      [[getAllocateInstruction({ newAccount: createNoopSigner(FRESH), space: 8n }), getAssignInstruction({ account: createNoopSigner(FRESH), programAddress: OTHER })], {}],
    ]
    for (const [ixs, opts] of ok) {
      const tx = forms(ixs, opts)
      await expect(a.signTransaction(tx.message)).resolves.toBeTypeOf('string')
      if (!ixs.some((ix) => ix.accounts?.some((m) => m.address === FRESH))) {
        await expect(a.sendTransaction(tx.base64)).resolves.toMatchObject({ hash: 'B'.repeat(87) })
        await expect(a.signTransaction(tx.compiled)).resolves.toBeTypeOf('string')
      }
    }
    expect(f.sent.length).toBeGreaterThan(0)
  })

  it('allowAuthorityChanges opts the general path out; sendSerialized stays strict', async () => {
    const { f, a } = await account({ allowAuthorityChanges: true })
    const assign = forms([getAssignInstruction({ account: me, programAddress: OTHER })])
    await expect(a.sendTransaction(assign.base64)).resolves.toMatchObject({ hash: 'B'.repeat(87) })
    await expect(a.signTransaction(assign.message)).resolves.toBeTypeOf('string')
    await expect(a.sendSerialized(assign.base64, { expect: { maxLamportsOut: 1_000_000n } })).rejects.toMatchObject({ code: 'core-instruction' })
    expect(f.sent).toHaveLength(1)
  })
})
