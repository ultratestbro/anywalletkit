/**
 * Real mainnet transactions for the official programs (System, Token, Token-2022, Associated Token, Compute Budget,
 * Address Lookup Table, Memo) in every message form (legacy, v0 with lookup tables, v1). Each fixture also carries
 * the RPC's own jsonParsed reading (`rpcInstructions`, `accountKeys`): the decoder is checked against it — names,
 * arguments, named accounts, the resolved account list and its roles — and against the fee the network charged.
 */
import { readdirSync } from 'node:fs'
import { AuthorityType } from '@solana-program/token-2022'
import { describe, expect, it } from 'vitest'
import { decodeTransaction, type DecodedInstruction, type LookupTables, type PreviewValue } from '../src/index.js'
import { decodeFixture, loadFixture, type Fixture } from './helpers.js'

/** The fixture groups this file owns (the protocol decoders have their own). */
const GROUPS = ['system', 'token', 'token-2022', 'ata', 'compute-budget', 'alt', 'memo', 'messages']
const files = GROUPS.flatMap((g) => readdirSync(new URL(`./fixtures/${g}/`, import.meta.url)).filter((f) => f.endsWith('.json')).map((f) => `${g}/${f}`))

type RpcIx = { programId: string; program?: string; parsed?: { type: string; info: Record<string, unknown> } | string }
type WithRpc = Fixture & { rpcInstructions: RpcIx[]; accountKeys: Array<{ pubkey: string; signer: boolean; writable: boolean; source: string }> }
const load = (file: string) => loadFixture(file) as WithRpc

/**
 * How the RPC's jsonParsed reading maps onto this package's: instruction name, then `[rpc field, our account name]`
 * and `[rpc field path, our arg name]` pairs. A fixture whose instruction has no row fails the suite.
 */
type Row = { name: string; accounts?: Record<string, string>; args?: Record<string, string> }
const TOKEN: Record<string, Row> = {
  transfer: { name: 'Transfer', accounts: { source: 'source', destination: 'destination', authority: 'authority' }, args: { amount: 'amount' } },
  transferChecked: { name: 'TransferChecked', accounts: { source: 'source', mint: 'mint', destination: 'destination', authority: 'authority' }, args: { 'tokenAmount.amount': 'amount', 'tokenAmount.decimals': 'decimals' } },
  transferCheckedWithFee: {
    name: 'TransferCheckedWithFee', accounts: { source: 'source', mint: 'mint', destination: 'destination', authority: 'authority' },
    args: { 'tokenAmount.amount': 'amount', 'tokenAmount.decimals': 'decimals', 'feeAmount.amount': 'fee' },
  },
  approve: { name: 'Approve', accounts: { source: 'source', delegate: 'delegate', owner: 'owner' }, args: { amount: 'amount' } },
  revoke: { name: 'Revoke', accounts: { source: 'source', owner: 'owner' } },
  closeAccount: { name: 'CloseAccount', accounts: { account: 'account', destination: 'destination', owner: 'owner' } },
  syncNative: { name: 'SyncNative', accounts: { account: 'account' } },
  initializeAccount3: { name: 'InitializeAccount3', accounts: { account: 'account', mint: 'mint' }, args: { owner: 'owner' } },
  burnChecked: { name: 'BurnChecked', accounts: { account: 'account', mint: 'mint', authority: 'authority' }, args: { 'tokenAmount.amount': 'amount', 'tokenAmount.decimals': 'decimals' } },
  freezeAccount: { name: 'FreezeAccount', accounts: { account: 'account', mint: 'mint', freezeAuthority: 'owner' } },
  harvestWithheldTokensToMint: { name: 'HarvestWithheldTokensToMint', accounts: { mint: 'mint' } },
  initializeGroupMemberPointer: { name: 'InitializeGroupMemberPointer', accounts: { mint: 'mint' }, args: { authority: 'authority', memberAddress: 'memberAddress' } },
  initializeMetadataPointer: { name: 'InitializeMetadataPointer', accounts: { mint: 'mint' }, args: { authority: 'authority', metadataAddress: 'metadataAddress' } },
  initializeMint: { name: 'InitializeMint', accounts: { mint: 'mint', rentSysvar: 'rent' }, args: { decimals: 'decimals', mintAuthority: 'mintAuthority', freezeAuthority: 'freezeAuthority' } },
  initializeMint2: { name: 'InitializeMint2', accounts: { mint: 'mint' }, args: { decimals: 'decimals', mintAuthority: 'mintAuthority' } },
  initializeMintCloseAuthority: { name: 'InitializeMintCloseAuthority', accounts: { mint: 'mint' }, args: { newAuthority: 'closeAuthority' } },
  initializePermanentDelegate: { name: 'InitializePermanentDelegate', accounts: { mint: 'mint' }, args: { delegate: 'delegate' } },
  initializeImmutableOwner: { name: 'InitializeImmutableOwner', accounts: { account: 'account' } },
  initializeTokenGroupMember: {
    name: 'InitializeTokenGroupMember',
    accounts: { member: 'member', memberMint: 'memberMint', memberMintAuthority: 'memberMintAuthority', group: 'group', groupUpdateAuthority: 'groupUpdateAuthority' },
  },
  initializeTokenMetadata: {
    name: 'InitializeTokenMetadata', accounts: { metadata: 'metadata', updateAuthority: 'updateAuthority', mint: 'mint', mintAuthority: 'mintAuthority' },
    args: { name: 'name', symbol: 'symbol', uri: 'uri' },
  },
  mintTo: { name: 'MintTo', accounts: { mint: 'mint', account: 'token', mintAuthority: 'mintAuthority' }, args: { amount: 'amount' } },
  mintToChecked: { name: 'MintToChecked', accounts: { mint: 'mint', account: 'token', mintAuthority: 'mintAuthority' }, args: { 'tokenAmount.amount': 'amount', 'tokenAmount.decimals': 'decimals' } },
  setAuthority: { name: 'SetAuthority', accounts: { account: 'owned', mint: 'owned', authority: 'owner' }, args: { newAuthority: 'newAuthority', authorityType: 'authorityType' } },
  unwrapLamports: { name: 'UnwrapLamports', accounts: { source: 'source', destination: 'destination', authority: 'authority' }, args: { amount: 'amount' } },
  updateTokenMetadataAuthority: { name: 'UpdateTokenMetadataUpdateAuthority', accounts: { metadata: 'metadata', updateAuthority: 'updateAuthority' }, args: { newAuthority: 'newUpdateAuthority' } },
  withdrawWithheldTokensFromAccounts: { name: 'WithdrawWithheldTokensFromAccounts', accounts: { mint: 'mint', feeRecipient: 'feeReceiver', withdrawWithheldAuthority: 'withdrawWithheldAuthority' } },
  withdrawExcessLamports: { name: 'WithdrawExcessLamports', accounts: { source: 'source', destination: 'destination', authority: 'authority' } },
  withdrawWithheldTokensFromMint: { name: 'WithdrawWithheldTokensFromMint', accounts: { mint: 'mint', feeRecipient: 'feeReceiver', withdrawWithheldAuthority: 'withdrawWithheldAuthority' } },
}
const ROWS: Record<string, Record<string, Row>> = {
  system: {
    transfer: { name: 'TransferSol', accounts: { source: 'source', destination: 'destination' }, args: { lamports: 'amount' } },
    transferWithSeed: { name: 'TransferSolWithSeed', accounts: { source: 'source', sourceBase: 'baseAccount', destination: 'destination' }, args: { lamports: 'amount', sourceSeed: 'fromSeed', sourceOwner: 'fromOwner' } },
    advanceNonce: { name: 'AdvanceNonceAccount', accounts: { nonceAccount: 'nonceAccount', recentBlockhashesSysvar: 'recentBlockhashesSysvar', nonceAuthority: 'nonceAuthority' } },
    allocate: { name: 'Allocate', accounts: { account: 'newAccount' }, args: { space: 'space' } },
    allocateWithSeed: { name: 'AllocateWithSeed', accounts: { account: 'newAccount', base: 'baseAccount' }, args: { base: 'base', seed: 'seed', space: 'space', owner: 'programAddress' } },
    assign: { name: 'Assign', accounts: { account: 'account' }, args: { owner: 'programAddress' } },
    createAccount: { name: 'CreateAccount', accounts: { source: 'payer', newAccount: 'newAccount' }, args: { lamports: 'lamports', space: 'space', owner: 'programAddress' } },
    createAccountWithSeed: { name: 'CreateAccountWithSeed', accounts: { source: 'payer', newAccount: 'newAccount' }, args: { base: 'base', seed: 'seed', lamports: 'amount', space: 'space', owner: 'programAddress' } },
  },
  'spl-token': TOKEN,
  'spl-associated-token-account': {
    create: { name: 'CreateAssociatedToken', accounts: { source: 'payer', account: 'ata', wallet: 'owner', mint: 'mint', systemProgram: 'systemProgram', tokenProgram: 'tokenProgram' } },
    createIdempotent: { name: 'CreateAssociatedTokenIdempotent', accounts: { source: 'payer', account: 'ata', wallet: 'owner', mint: 'mint', systemProgram: 'systemProgram', tokenProgram: 'tokenProgram' } },
  },
  'address-lookup-table': {
    createLookupTable: { name: 'CreateLookupTable', accounts: { lookupTableAccount: 'address', lookupTableAuthority: 'authority', payerAccount: 'payer', systemProgram: 'systemProgram' }, args: { recentSlot: 'recentSlot', bumpSeed: 'bump' } },
    extendLookupTable: { name: 'ExtendLookupTable', accounts: { lookupTableAccount: 'address', lookupTableAuthority: 'authority', payerAccount: 'payer', systemProgram: 'systemProgram' }, args: { newAddresses: 'addresses' } },
    closeLookupTable: { name: 'CloseLookupTable', accounts: { lookupTableAccount: 'address', lookupTableAuthority: 'authority', recipient: 'recipient' } },
  },
}

const at = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o)
const named = (ix: DecodedInstruction, name: string) => ix.accounts.find((a) => a.name === name)?.address
/** The RPC writes amounts as strings or numbers and enums in camelCase; compare in one shape. */
const norm = (v: unknown): unknown => {
  if (typeof v === 'bigint' || typeof v === 'number') return String(v)
  if (Array.isArray(v)) return v.map(norm)
  return v
}

describe('official programs: every fixture against the RPC\'s own reading', () => {
  it('has fixtures for every group', () => {
    for (const g of GROUPS) expect(files.some((f) => f.startsWith(`${g}/`)), g).toBe(true)
    expect(files.length).toBeGreaterThanOrEqual(40)
  })

  it.each(files)('%s', (file) => {
    const f = load(file)
    const d = decodeFixture(f)
    expect(d.version).toBe(f.version)
    // The resolved account list and its roles are exactly the RPC's (static keys, then loaded writable, then readonly).
    expect(d.accounts.map((a) => [a.address, a.signer, a.writable])).toEqual(f.accountKeys.map((k) => [k.pubkey, k.signer, k.writable]))
    expect(d.feePayer).toBe(f.accountKeys[0]!.pubkey)
    expect(d.lookupTables.every((t) => t.resolved)).toBe(true)
    expect(d.instructions).toHaveLength(f.rpcInstructions.length)

    for (const [i, rpcIx] of f.rpcInstructions.entries()) {
      const ix = d.instructions[i]!
      expect(ix.programAddress).toBe(rpcIx.programId)
      // Protocol programs (Jupiter…) inside these transactions belong to their own suites.
      if (!rpcIx.parsed) continue
      expect(ix.error, `${file} #${i}`).toBeUndefined()
      if (typeof rpcIx.parsed === 'string') {
        // spl-memo: the RPC shows the text.
        expect(ix).toMatchObject({ name: 'Memo', args: { text: rpcIx.parsed } })
        continue
      }
      const row = ROWS[rpcIx.program!]?.[rpcIx.parsed.type]
      if (!row) throw new Error(`${file} #${i}: no mapping for ${rpcIx.program}:${rpcIx.parsed.type} — add a row`)
      expect(ix.name, `${file} #${i}`).toBe(row.name)
      const info = rpcIx.parsed.info
      for (const [field, ours] of Object.entries(row.accounts ?? {})) {
        if (typeof info[field] === 'string') expect(named(ix, ours), `${file} #${i} account ${ours}`).toBe(info[field])
      }
      for (const [path, ours] of Object.entries(row.args ?? {})) {
        let rpcValue = at(info, path)
        if (rpcValue === undefined) continue
        if (path === 'authorityType') rpcValue = AuthorityType[(String(rpcValue).charAt(0).toUpperCase() + String(rpcValue).slice(1)) as keyof typeof AuthorityType]
        expect(norm(ix.args[ours]), `${file} #${i} arg ${ours}`).toEqual(norm(rpcValue))
      }
    }
  })

  it.each(files)('%s: the fee the network charged follows from the decoded compute budget', (file) => {
    const f = load(file)
    const d = decodeFixture(f)
    const base = 5000n * BigInt(d.signers.length)
    let priority: bigint | null
    if (d.version === 1) {
      priority = d.config?.priorityFeeLamports ?? 0n
    } else {
      const cb = (name: string) => d.instructions.find((ix) => ix.programName === 'Compute Budget Program' && ix.name === name)
      const price = cb('SetComputeUnitPrice')?.args.microLamports as bigint | undefined
      const limit = cb('SetComputeUnitLimit')?.args.units as number | undefined
      // Without an explicit limit the runtime's default per-instruction allowance decides; only the explicit cases are checked.
      priority = price === undefined ? 0n : limit === undefined ? null : (BigInt(limit) * price + 999_999n) / 1_000_000n
    }
    if (priority !== null) expect(BigInt(f.meta.fee)).toBe(base + priority)
  })
})

describe('official programs: details the RPC does not parse', () => {
  it('Compute Budget: limit, price, loaded-data limit and heap frame', () => {
    const args = (file: string) => decodeFixture(load(file)).instructions.filter((ix) => ix.programName === 'Compute Budget Program').map((ix) => [ix.name, ix.args])
    expect(args('compute-budget/set-limit.json')).toEqual([['SetComputeUnitLimit', { units: 2026 }]])
    expect(args('compute-budget/set-price.json')).toEqual([['SetComputeUnitPrice', { microLamports: 1n }]])
    expect(args('compute-budget/set-loaded-data-limit.json')).toEqual([['SetLoadedAccountsDataSizeLimit', { accountDataSizeLimit: 256000 }], ['SetComputeUnitLimit', { units: 800 }]])
    expect(args('compute-budget/request-heap-frame.json')).toEqual([['RequestHeapFrame', { bytes: 262144 }], ['SetComputeUnitLimit', { units: 350000 }]])
    for (const ix of decodeFixture(load('compute-budget/set-limit.json')).instructions.filter((i) => i.programName === 'Compute Budget Program')) expect(ix.accounts).toEqual([])
  })

  it('ATA Create with empty data (the original form, no tag) decodes as CreateAssociatedToken with named accounts', () => {
    const f = load('ata/create-empty-data.json')
    const ix = decodeFixture(f).instructions[0]!
    expect(ix).toMatchObject({ name: 'CreateAssociatedToken', decoded: true, data: '' })
    expect(ix.accounts.map((a) => a.name)).toEqual(['payer', 'ata', 'owner', 'mint', 'systemProgram', 'tokenProgram'])
  })

  it('Memo v1 and v2', () => {
    expect(decodeFixture(load('memo/memo-v2.json')).instructions[0]).toMatchObject({ programName: 'Memo Program', name: 'Memo', args: { text: '7B1BB3214D2BF68D34932234E92503EFC162C7483A8BDCE4C96BB6B1861E5F72' } })
    expect(decodeFixture(load('memo/memo-v1.json')).instructions[3]).toMatchObject({ programName: 'Memo Program v1', name: 'Memo', args: { text: '01a1ea68-392f-7c44-a6d7-17cb88cd84a9' } })
  })

  it('Token-2022 mint creation: every extension initializer named, with its arguments', () => {
    const d = decodeFixture(load('token-2022/create-mint-extensions.json'))
    expect(d.instructions.map((ix) => ix.name)).toEqual([
      'SetComputeUnitLimit', 'SetComputeUnitPrice', 'CreateAccount', 'InitializeMetadataPointer', 'InitializePermanentDelegate', 'InitializeMintCloseAuthority',
      'InitializeGroupMemberPointer', 'InitializeMint', 'InitializeTokenGroupMember', 'CreateAssociatedTokenIdempotent', 'MintToChecked', 'FreezeAccount',
    ])
    const m = decodeFixture(load('token-2022/create-mint-metadata.json'))
    expect(m.instructions[6]).toMatchObject({ name: 'UpdateTokenMetadataUpdateAuthority', args: { newUpdateAuthority: null } })
    expect(m.instructions[9]).toMatchObject({ name: 'SetAuthority', args: { authorityType: AuthorityType.MintTokens, newAuthority: null } })
  })

  it('Token-2022 TransferCheckedWithFee keeps the fee the sender declared', () => {
    const ix = decodeFixture(load('token-2022/transfer-checked-with-fee.json')).instructions[2]!
    expect(ix).toMatchObject({ programName: 'Token-2022 Program', name: 'TransferCheckedWithFee', args: { amount: 1_960_000_000n, decimals: 6, fee: 0n } })
  })

  it('Token-2022 withheld fees: harvest to the mint, withdraw from the mint and from accounts', () => {
    const harvest = decodeFixture(load('token-2022/harvest-withheld.json')).instructions[0]!
    expect(harvest).toMatchObject({ name: 'HarvestWithheldTokensToMint', args: {} })
    // The source token accounts follow the mint as remaining accounts: listed, unnamed.
    expect(harvest.accounts.map((a) => a.name)).toEqual(['mint', null, null])
    const fromAccounts = decodeFixture(load('token-2022/withdraw-withheld-from-accounts.json')).instructions[0]!
    expect(fromAccounts).toMatchObject({ name: 'WithdrawWithheldTokensFromAccounts', args: { numTokenAccounts: 1 } })
    expect(fromAccounts.accounts.map((a) => a.name)).toEqual(['mint', 'feeReceiver', 'withdrawWithheldAuthority', null])
  })
})

describe('message forms', () => {
  it('legacy: blockhash lifetime, no tables, no config', () => {
    const d = decodeFixture(load('token/transfer-checked.json'))
    expect(d).toMatchObject({ version: 'legacy', lookupTables: [], config: null, lifetime: { kind: 'blockhash' } })
    expect(d.signers[0]).toEqual({ address: d.feePayer, signed: true })
    expect(d.signers.every((s) => s.signed === true)).toBe(true)
  })

  it('durable nonce: AdvanceNonceAccount first makes the lifetime durable-nonce, with the warning', () => {
    const f = load('system/advance-nonce.json')
    const d = decodeFixture(f)
    expect(d.lifetime.kind).toBe('durable-nonce')
    expect(d.instructions[0]).toMatchObject({ name: 'AdvanceNonceAccount' })
    expect(d.warnings.map((w) => w.code)).toContain('durable-nonce')
  })

  it('v0 with lookup tables: resolved from the fixture, every lookup account known', () => {
    const f = load('messages/v0-lookup-tables.json')
    const d = decodeFixture(f)
    expect(d.version).toBe(0)
    expect(d.lookupTables).toEqual(Object.keys(f.lookupTables).map((address) => ({ address, resolved: true })))
    const fromTables = d.accounts.filter((a) => a.lookupTable)
    expect(fromTables.length).toBe(f.meta.loadedAddresses.writable.length + f.meta.loadedAddresses.readonly.length)
    expect(fromTables.map((a) => a.address)).toEqual([...f.meta.loadedAddresses.writable, ...f.meta.loadedAddresses.readonly])
    expect(d.warnings.map((w) => w.code)).not.toContain('unresolved-lookup-tables')
  })

  it('v0 without its tables: a warning, null addresses, and the instructions still decode', () => {
    const f = load('compute-budget/request-heap-frame.json')
    const d = decodeTransaction(f.wire)
    expect(d.lookupTables.every((t) => !t.resolved)).toBe(true)
    expect(d.warnings.map((w) => w.code)).toContain('unresolved-lookup-tables')
    expect(d.accounts.filter((a) => a.lookupTable).every((a) => a.address === null)).toBe(true)
    expect(d.accounts.filter((a) => !a.lookupTable).every((a) => typeof a.address === 'string')).toBe(true)
    // Compute Budget takes no accounts: unaffected.
    expect(d.instructions[1]).toMatchObject({ name: 'RequestHeapFrame', args: { bytes: 262144 } })
    // A table resolved partially (one entry missing) still counts as unresolved.
    const [table, entries] = Object.entries(f.lookupTables)[0]!
    const partial: LookupTables = { ...(f.lookupTables as LookupTables), [table]: entries.map((e, i) => (i === entries.findIndex((x) => x) ? null : e)) as string[] }
    expect(decodeTransaction(f.wire, { lookupTables: partial }).lookupTables.find((t) => t.address === table)!.resolved).toBe(false)
  })

  it('v0 without tables: instructions keep their names and args; the accounts from tables come back null, flagged by role', () => {
    const f = load('token/unwrap-lamports.json')
    const d = decodeTransaction(f.wire)
    expect(d.instructions[3]).toMatchObject({ name: 'UnwrapLamports', args: { amount: 6203n } })
    const swap = d.instructions[2]!
    const statics = new Set(d.accounts.filter((a) => !a.lookupTable).map((a) => a.address))
    const fromTables = decodeFixture(f).instructions[2]!.accounts.filter((a) => !statics.has(a.address)).length
    expect(fromTables).toBeGreaterThan(0)
    expect(swap.accounts.filter((a) => a.address === null).length).toBe(fromTables)
    // The roles of a lookup entry are known even when its address is not (writable section vs readonly section).
    expect(d.accounts.filter((a) => a.lookupTable).map((a) => a.writable)).toEqual(f.accountKeys.filter((k) => k.source === 'lookupTable').map((k) => k.writable))
  })

  it('v1: the compute budget comes from the message config (priority fee, CU limit, loaded-data limit, heap)', () => {
    const cfg = (file: string) => decodeFixture(load(file)).config
    expect(cfg('system/transfer-sol-v1.json')).toEqual({ computeUnitLimit: 150, loadedAccountsDataSizeLimit: 20450 })
    expect(cfg('system/create-account-with-seed.json')).toEqual({ priorityFeeLamports: 700n, computeUnitLimit: 3579, loadedAccountsDataSizeLimit: 3342336 })
    expect(cfg('token-2022/transfer-checked-v1.json')).toEqual({ priorityFeeLamports: 2000n, computeUnitLimit: 520000, loadedAccountsDataSizeLimit: 33554432, heapSize: 262144 })
    expect(cfg('token-2022/rent-reclaim.json')).toEqual({ priorityFeeLamports: 4800n, computeUnitLimit: 48000, loadedAccountsDataSizeLimit: 67108864 })
    // A v1 message with no instructions at all (it only pays a fee).
    const empty = decodeFixture(load('messages/v1-empty.json'))
    expect(empty).toMatchObject({ version: 1, instructions: [], config: { priorityFeeLamports: 195000n, computeUnitLimit: 0, loadedAccountsDataSizeLimit: 32768 } })
    // Legacy and v0 carry their budget in instructions instead.
    expect(cfg('compute-budget/set-price.json')).toBeNull()
  })

  it('v1: instructions decode as in any other version', () => {
    const d = decodeFixture(load('token-2022/rent-reclaim.json'))
    expect(d.instructions.map((ix) => ix.name)).toEqual(['CloseAccount', 'CloseAccount', 'CloseAccount', 'HarvestWithheldTokensToMint', ...Array(12).fill('CloseAccount')])
    expect(d.instructions.slice(0, 2).every((ix) => ix.programName === 'Token Program')).toBe(true)
    expect(d.instructions.slice(2).every((ix) => ix.programName === 'Token-2022 Program')).toBe(true)
  })

  it('every value in a decoded fixture is plain data (survives structuredClone)', () => {
    for (const file of files) {
      const d = decodeFixture(load(file))
      expect(structuredClone(d) as unknown).toEqual(d as unknown)
    }
  })
})

// Keep the type import used: PreviewValue is the args' element type.
export type { PreviewValue }

describe('warnings on real transactions', () => {
  it('durable nonce + authority hand-over + approve/revoke around a Jupiter swap (5BGJRbDb…)', () => {
    const d = decodeFixture(load('token/revoke.json'))
    expect(d.lifetime.kind).toBe('durable-nonce')
    expect(d.instructions[10]).toMatchObject({ name: 'Revoke', accounts: [{ name: 'source' }, { name: 'owner' }] })
    // Instruction 8 is the Jupiter route (its own suite).
    expect(d.warnings.filter((w) => w.instruction !== 8).map((w) => [w.code, w.instruction ?? null])).toEqual([
      ['durable-nonce', null],
      ['sets-authority', 2], ['sets-authority', 3], ['sets-authority', 4], ['sets-authority', 5],
      ['approves-delegate', 6], ['unlimited-approve', 6],
      ['sets-authority', 11], ['sets-authority', 12], ['sets-authority', 13], ['sets-authority', 14],
    ])
  })

  it('rent reclaim: one closes-account per CloseAccount, none for the harvest', () => {
    const d = decodeFixture(load('token-2022/rent-reclaim.json'))
    expect(d.warnings.map((w) => w.instruction)).toEqual([0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    expect(d.warnings.every((w) => w.code === 'closes-account')).toBe(true)
  })
})
