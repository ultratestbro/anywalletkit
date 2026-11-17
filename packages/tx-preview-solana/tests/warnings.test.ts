/**
 * Every code `collectWarnings` (and `describeTransaction`) emits, one table row per trigger, built from the official
 * clients' instruction builders. The Stake program's line is tested with the stake decoder.
 */
import {
  compileTransaction, createNoopSigner, createTransactionMessage, getAddressDecoder, pipe, appendTransactionMessageInstructions, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, type Address, type Blockhash, type Instruction, type Transaction,
} from '@solana/kit'
import { getCloseLookupTableInstruction } from '@solana-program/address-lookup-table'
import { getAdvanceNonceAccountInstruction, getAssignInstruction, getAuthorizeNonceAccountInstruction, getTransferSolInstruction, getTransferSolWithSeedInstruction } from '@solana-program/system'
import * as token from '@solana-program/token'
import * as t22 from '@solana-program/token-2022'
import { describe, expect, it } from 'vitest'
import { collectWarnings, decodeTransaction, describeTransaction, MAX_U64, type PreviewRpc, type PreviewWarningCode } from '../src/index.js'
import { loadFixture } from './helpers.js'

const A = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n)) as Address
const ME = A(1)
const me = createNoopSigner(ME)
const ZERO = '11111111111111111111111111111111' as Address
const BLOCKHASH = { blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' as Blockhash, lastValidBlockHeight: 0n }

const message = (ixs: Instruction[], payer: Address = ME) => pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayer(payer, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash(BLOCKHASH, m),
  (m) => appendTransactionMessageInstructions(ixs, m),
)
const codes = (ixs: Instruction[], signer: string = ME) => decodeTransaction(message(ixs), { signer }).warnings.map((w) => [w.code, w.instruction ?? null])

type Row = [PreviewWarningCode | 'none', string, () => Array<[string, number | null]>, Array<[string, number | null]>]
const rows: Row[] = [
  ['none', 'a plain SOL transfer', () => codes([getTransferSolInstruction({ source: me, destination: A(2), amount: 1n })]) as never, []],
  ['unknown-program', 'a program with no decoder', () => codes([{ programAddress: A(9), accounts: [], data: new Uint8Array([1]) }]) as never, [['unknown-program', 0]]],
  ['undecoded-instruction', 'a known program, data it does not define', () => codes([{ programAddress: token.TOKEN_PROGRAM_ADDRESS, accounts: [], data: new Uint8Array([200]) }]) as never, [['undecoded-instruction', 0]]],
  ['undecoded-instruction', 'a known instruction with truncated data', () => codes([{ programAddress: token.TOKEN_PROGRAM_ADDRESS, accounts: [], data: new Uint8Array([3, 1]) }]) as never, [['undecoded-instruction', 0]]],
  ['durable-nonce', 'AdvanceNonceAccount first', () => codes([getAdvanceNonceAccountInstruction({ nonceAccount: A(3), nonceAuthority: me }), getTransferSolInstruction({ source: me, destination: A(2), amount: 1n })]) as never, [['durable-nonce', null]]],
  ['none', 'AdvanceNonceAccount not first is not a durable-nonce transaction', () => codes([getTransferSolInstruction({ source: me, destination: A(2), amount: 1n }), getAdvanceNonceAccountInstruction({ nonceAccount: A(3), nonceAuthority: me })]) as never, []],
  ['sets-authority', 'Token SetAuthority', () => codes([token.getSetAuthorityInstruction({ owned: A(4), owner: me, authorityType: token.AuthorityType.AccountOwner, newAuthority: A(5) })]) as never, [['sets-authority', 0]]],
  ['sets-authority', 'Token-2022 SetAuthority', () => codes([t22.getSetAuthorityInstruction({ owned: A(4), owner: me, authorityType: t22.AuthorityType.CloseAccount, newAuthority: null })]) as never, [['sets-authority', 0]]],
  ['sets-authority', 'Token-2022 UpdateTokenMetadataUpdateAuthority', () => codes([t22.getUpdateTokenMetadataUpdateAuthorityInstruction({ metadata: A(4), updateAuthority: me, newUpdateAuthority: A(5) })]) as never, [['sets-authority', 0]]],
  ['sets-authority', 'System Assign', () => codes([getAssignInstruction({ account: me, programAddress: A(6) })]) as never, [['sets-authority', 0]]],
  ['sets-authority', 'System AuthorizeNonceAccount', () => codes([getAuthorizeNonceAccountInstruction({ nonceAccount: A(3), nonceAuthority: me, newNonceAuthority: A(7) })]) as never, [['sets-authority', 0]]],
  ['closes-account', 'Token CloseAccount', () => codes([token.getCloseAccountInstruction({ account: A(4), destination: A(5), owner: me })]) as never, [['closes-account', 0]]],
  ['closes-account', 'Token-2022 CloseAccount', () => codes([t22.getCloseAccountInstruction({ account: A(4), destination: A(5), owner: me })]) as never, [['closes-account', 0]]],
  ['closes-account', 'Address Lookup Table CloseLookupTable', () => codes([getCloseLookupTableInstruction({ address: A(4), authority: me, recipient: ME })]) as never, [['closes-account', 0]]],
  ['approves-delegate', 'Token Approve, a set amount', () => codes([token.getApproveInstruction({ source: A(4), delegate: A(5), owner: me, amount: 10n })]) as never, [['approves-delegate', 0]]],
  ['unlimited-approve', 'Token ApproveChecked for u64::MAX', () => codes([token.getApproveCheckedInstruction({ source: A(4), mint: A(8), delegate: A(5), owner: me, amount: MAX_U64, decimals: 6 })]) as never, [['approves-delegate', 0], ['unlimited-approve', 0]]],
  ['unlimited-approve', 'Token-2022 Approve for u64::MAX', () => codes([t22.getApproveInstruction({ source: A(4), delegate: A(5), owner: me, amount: MAX_U64 })]) as never, [['approves-delegate', 0], ['unlimited-approve', 0]]],
  ['burn-address', 'TransferSol to the all-zero address', () => codes([getTransferSolInstruction({ source: me, destination: ZERO, amount: 1n })]) as never, [['burn-address', 0]]],
  ['burn-address', 'TransferSolWithSeed to the all-zero address', () => codes([getTransferSolWithSeedInstruction({ source: A(4), baseAccount: me, destination: ZERO, amount: 1n, fromSeed: 's', fromOwner: A(6) })]) as never, [['burn-address', 0]]],
  ['burn-address', 'Token TransferChecked to the all-zero address', () => codes([token.getTransferCheckedInstruction({ source: A(4), mint: A(8), destination: ZERO, authority: me, amount: 1n, decimals: 6 })]) as never, [['burn-address', 0]]],
  ['burn-address', 'Token-2022 TransferCheckedWithFee to the all-zero address', () => codes([t22.getTransferCheckedWithFeeInstruction({ source: A(4), mint: A(8), destination: ZERO, authority: me, amount: 1n, decimals: 6, fee: 0n })]) as never, [['burn-address', 0]]],
  ['approves-delegate', 'an Approve inside a Token-2022 Batch', () => codes([t22.getBatchInstruction([
    t22.getTransferCheckedInstruction({ source: A(4), mint: A(8), destination: A(5), authority: me, amount: 1n, decimals: 6 }),
    t22.getApproveInstruction({ source: A(4), delegate: A(9), owner: me, amount: MAX_U64 }),
    t22.getSetAuthorityInstruction({ owned: A(4), owner: me, authorityType: t22.AuthorityType.AccountOwner, newAuthority: A(9) }),
  ])]) as never, [['approves-delegate', 0], ['unlimited-approve', 0], ['sets-authority', 0]]],
]

describe('collectWarnings: one row per trigger', () => {
  it.each(rows.map((r) => [r[0], r[1], r[2], r[3]] as const))('%s — %s', (_code, _what, run, want) => {
    expect(run()).toEqual(want)
  })

  it('every code the type knows (except the stake line\'s reuse of sets-authority) has a row or a test below', () => {
    const covered = new Set<string>([...rows.map((r) => r[0]), 'unresolved-lookup-tables', 'foreign-fee-payer', 'missing-signers', 'simulation-failed', 'simulation-unavailable', 'balances-unavailable'])
    const all: PreviewWarningCode[] = [
      'unresolved-lookup-tables', 'foreign-fee-payer', 'missing-signers', 'durable-nonce', 'unknown-program', 'undecoded-instruction', 'sets-authority', 'closes-account',
      'approves-delegate', 'unlimited-approve', 'burn-address', 'simulation-failed', 'simulation-unavailable', 'balances-unavailable',
    ]
    expect(all.filter((c) => !covered.has(c))).toEqual([])
  })

  it('foreign-fee-payer: the signer is not the fee payer', () => {
    const w = decodeTransaction(message([getTransferSolInstruction({ source: me, destination: A(2), amount: 1n })], A(9)), { signer: ME }).warnings
    expect(w).toEqual([{ code: 'foreign-fee-payer', message: `The fee payer is ${A(9)}, not ${ME}.` }])
    // No signer given: nothing to compare against.
    expect(decodeTransaction(message([getTransferSolInstruction({ source: me, destination: A(2), amount: 1n })], A(9))).warnings).toEqual([])
  })

  it('missing-signers: a compiled transaction with another signer\'s slot still empty', () => {
    const tx = compileTransaction(message([getTransferSolInstruction({ source: createNoopSigner(A(2)), destination: A(3), amount: 1n })])) as Transaction
    const partly = { ...tx, signatures: { ...tx.signatures, [ME]: new Uint8Array(64).fill(1) } } as unknown as Transaction
    const w = decodeTransaction(partly, { signer: ME }).warnings
    expect(w.map((x) => x.code)).toEqual(['missing-signers'])
    expect(w[0]!.message).toContain(A(2))
    // The signer's own empty slot is not "missing" (it is about to sign); the fee payer's is.
    expect(decodeTransaction(tx, { signer: A(2) }).warnings.map((x) => x.code)).toEqual(['foreign-fee-payer', 'missing-signers'])
    // A message (no signature slots yet) never reports it.
    expect(decodeTransaction(message([getTransferSolInstruction({ source: createNoopSigner(A(2)), destination: A(3), amount: 1n })]), { signer: ME }).warnings).toEqual([])
  })

  it('unresolved-lookup-tables: names each table once', () => {
    const f = loadFixture('compute-budget/request-heap-frame.json')
    const w = decodeTransaction(f.wire).warnings.filter((x) => x.code === 'unresolved-lookup-tables')
    expect(w).toHaveLength(1)
    for (const t of Object.keys(f.lookupTables)) expect(w[0]!.message).toContain(t)
  })

  it('collectWarnings is usable on its own (a decoded transaction without warnings)', () => {
    const { warnings, ...rest } = decodeTransaction(message([token.getCloseAccountInstruction({ account: A(4), destination: A(5), owner: me })]), { signer: ME })
    expect(collectWarnings(rest, ME)).toEqual(warnings)
    expect(warnings[0]!.message).toBe(`Closes token account ${A(4)}; its rent goes to ${A(5)}.`)
  })
})

describe('describeTransaction: the simulation codes', () => {
  const f = loadFixture('token/transfer.json')
  const rpcWith = (value: unknown) => ({
    simulateTransaction: () => ({ send: async () => ({ context: { slot: 1n }, value }) }),
    getMultipleAccounts: () => ({ send: async () => ({ context: { slot: 1n }, value: [] }) }),
  }) as unknown as PreviewRpc
  const base = { logs: [], unitsConsumed: 1n, preBalances: [1n], postBalances: [1n], preTokenBalances: [], postTokenBalances: [], loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [] }

  it('simulation-failed', async () => {
    const p = await describeTransaction(f.wire, { rpc: rpcWith({ ...base, err: 'AccountNotFound' }) })
    expect(p.warnings.map((w) => w.code)).toEqual(['simulation-failed'])
    expect(p.warnings[0]!.message).toBe('The simulation failed: "AccountNotFound".')
  })

  it('balances-unavailable', async () => {
    const p = await describeTransaction(f.wire, { rpc: rpcWith({ ...base, err: null, preBalances: null, postBalances: null }) })
    expect(p.warnings.map((w) => w.code)).toEqual(['balances-unavailable'])
  })

  it('simulation-unavailable', async () => {
    const msg = pipe(createTransactionMessage({ version: 0 }), (m) => appendTransactionMessageInstructions([getTransferSolInstruction({ source: me, destination: A(2), amount: 1n })], m))
    const p = await describeTransaction(msg, { rpc: rpcWith({ ...base, err: null }) })
    expect(p.warnings.map((w) => w.code)).toEqual(['simulation-unavailable'])
  })
})
