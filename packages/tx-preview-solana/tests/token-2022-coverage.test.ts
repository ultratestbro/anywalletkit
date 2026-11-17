/**
 * Every instruction the Token-2022 client knows (its `Token2022Instruction` enum), built with the client's own
 * `get…Instruction` builder from synthetic inputs and read back through `decodeInstruction`: same name, same
 * arguments, and every account the input named comes back under that name. The table is keyed by the enum, so a
 * client upgrade that adds an instruction fails here until it gets a row.
 */
import { createNoopSigner, getAddressDecoder, type Address, type Instruction } from '@solana/kit'
import * as t22 from '@solana-program/token-2022'
import { describe, expect, it } from 'vitest'
import { decodeInstruction, TOKEN_2022_PROGRAM, toPreviewValue, type PreviewValue, type RawInstruction } from '../src/index.js'

const addr = getAddressDecoder()
/** A distinct, valid address per number. */
const A = (n: number): Address => addr.decode(new Uint8Array(32).fill(n))
const S = (n: number) => createNoopSigner(A(n))
const db = new Uint8Array(36).fill(7) // DecryptableBalance (AES ciphertext)
const eb = new Uint8Array(64).fill(9) // EncryptedBalance (ElGamal ciphertext)

/** Accounts by input field name (a signer or an address), arguments as the builder takes them. */
interface Row { accounts: Record<string, Address | ReturnType<typeof S> | Address[]>; args?: Record<string, unknown> }

const proofCt = { instructionsSysvar: A(30), equalityRecord: A(31), ciphertextValidityRecord: A(32), rangeRecord: A(33) }
const ctBurn = { newDecryptableAvailableBalance: db, burnAmountAuditorCiphertextLo: eb, burnAmountAuditorCiphertextHi: eb, equalityProofInstructionOffset: 1, ciphertextValidityProofInstructionOffset: 2, rangeProofInstructionOffset: 3 }

const rows: Record<keyof typeof t22.Token2022Instruction, Row> = {
  InitializeMint: { accounts: { mint: A(1), rent: A(2) }, args: { decimals: 6, mintAuthority: A(3), freezeAuthority: A(4) } },
  InitializeAccount: { accounts: { account: A(1), mint: A(2), owner: A(3), rent: A(4) } },
  InitializeMultisig: { accounts: { multisig: A(1), rent: A(2), signers: [A(3), A(4)] }, args: { m: 2 } },
  Transfer: { accounts: { source: A(1), destination: A(2), authority: S(3) }, args: { amount: 5n } },
  Approve: { accounts: { source: A(1), delegate: A(2), owner: S(3) }, args: { amount: 5n } },
  Revoke: { accounts: { source: A(1), owner: S(2) } },
  SetAuthority: { accounts: { owned: A(1), owner: S(2) }, args: { authorityType: t22.AuthorityType.TransferFeeConfig, newAuthority: A(3) } },
  MintTo: { accounts: { mint: A(1), token: A(2), mintAuthority: S(3) }, args: { amount: 5n } },
  Burn: { accounts: { account: A(1), mint: A(2), authority: S(3) }, args: { amount: 5n } },
  CloseAccount: { accounts: { account: A(1), destination: A(2), owner: S(3) } },
  FreezeAccount: { accounts: { account: A(1), mint: A(2), owner: S(3) } },
  ThawAccount: { accounts: { account: A(1), mint: A(2), owner: S(3) } },
  TransferChecked: { accounts: { source: A(1), mint: A(2), destination: A(3), authority: S(4) }, args: { amount: 5n, decimals: 6 } },
  ApproveChecked: { accounts: { source: A(1), mint: A(2), delegate: A(3), owner: S(4) }, args: { amount: 5n, decimals: 6 } },
  MintToChecked: { accounts: { mint: A(1), token: A(2), mintAuthority: S(3) }, args: { amount: 5n, decimals: 6 } },
  BurnChecked: { accounts: { account: A(1), mint: A(2), authority: S(3) }, args: { amount: 5n, decimals: 6 } },
  InitializeAccount2: { accounts: { account: A(1), mint: A(2), rent: A(3) }, args: { owner: A(4) } },
  SyncNative: { accounts: { account: A(1) } },
  InitializeAccount3: { accounts: { account: A(1), mint: A(2) }, args: { owner: A(3) } },
  InitializeMultisig2: { accounts: { multisig: A(1), signers: [A(2), A(3)] }, args: { m: 1 } },
  InitializeMint2: { accounts: { mint: A(1) }, args: { decimals: 9, mintAuthority: A(2), freezeAuthority: null } },
  GetAccountDataSize: { accounts: { mint: A(1) } },
  InitializeImmutableOwner: { accounts: { account: A(1) } },
  AmountToUiAmount: { accounts: { mint: A(1) }, args: { amount: 5n } },
  UiAmountToAmount: { accounts: { mint: A(1) }, args: { uiAmount: '1.5' } },
  InitializeMintCloseAuthority: { accounts: { mint: A(1) }, args: { closeAuthority: A(2) } },
  InitializeTransferFeeConfig: { accounts: { mint: A(1) }, args: { transferFeeConfigAuthority: A(2), withdrawWithheldAuthority: A(3), transferFeeBasisPoints: 50, maximumFee: 10n ** 12n } },
  TransferCheckedWithFee: { accounts: { source: A(1), mint: A(2), destination: A(3), authority: S(4) }, args: { amount: 1000n, decimals: 6, fee: 5n } },
  WithdrawWithheldTokensFromMint: { accounts: { mint: A(1), feeReceiver: A(2), withdrawWithheldAuthority: S(3) } },
  WithdrawWithheldTokensFromAccounts: { accounts: { mint: A(1), feeReceiver: A(2), withdrawWithheldAuthority: S(3), sources: [A(4), A(5)] }, args: { numTokenAccounts: 2 } },
  HarvestWithheldTokensToMint: { accounts: { mint: A(1), sources: [A(2), A(3)] } },
  SetTransferFee: { accounts: { mint: A(1), transferFeeConfigAuthority: S(2) }, args: { transferFeeBasisPoints: 100, maximumFee: 7n } },
  InitializeConfidentialTransferMint: { accounts: { mint: A(1) }, args: { authority: A(2), autoApproveNewAccounts: true, auditorElgamalPubkey: A(3) } },
  UpdateConfidentialTransferMint: { accounts: { mint: A(1), authority: S(2) }, args: { autoApproveNewAccounts: false, auditorElgamalPubkey: null } },
  ConfigureConfidentialTransferAccount: { accounts: { token: A(1), mint: A(2), instructionsSysvarOrContextState: A(3), authority: S(4) }, args: { decryptableZeroBalance: db, maximumPendingBalanceCreditCounter: 65536n, proofInstructionOffset: 1 } },
  ApproveConfidentialTransferAccount: { accounts: { token: A(1), mint: A(2), authority: S(3) } },
  EmptyConfidentialTransferAccount: { accounts: { token: A(1), instructionsSysvarOrContextState: A(2), authority: S(3) }, args: { proofInstructionOffset: 1 } },
  ConfidentialDeposit: { accounts: { token: A(1), mint: A(2), authority: S(3) }, args: { amount: 5n, decimals: 6 } },
  ConfidentialWithdraw: { accounts: { token: A(1), mint: A(2), instructionsSysvar: A(30), equalityRecord: A(31), rangeRecord: A(33), authority: S(3) }, args: { amount: 5n, decimals: 6, newDecryptableAvailableBalance: db, equalityProofInstructionOffset: 1, rangeProofInstructionOffset: 2 } },
  ConfidentialTransfer: {
    accounts: { sourceToken: A(1), mint: A(2), destinationToken: A(3), ...proofCt, authority: S(4) },
    args: { newSourceDecryptableAvailableBalance: db, transferAmountAuditorCiphertextLo: eb, transferAmountAuditorCiphertextHi: eb, equalityProofInstructionOffset: 1, ciphertextValidityProofInstructionOffset: 2, rangeProofInstructionOffset: 3 },
  },
  ApplyConfidentialPendingBalance: { accounts: { token: A(1), authority: S(2) }, args: { expectedPendingBalanceCreditCounter: 3n, newDecryptableAvailableBalance: db } },
  EnableConfidentialCredits: { accounts: { token: A(1), authority: S(2) } },
  DisableConfidentialCredits: { accounts: { token: A(1), authority: S(2) } },
  EnableNonConfidentialCredits: { accounts: { token: A(1), authority: S(2) } },
  DisableNonConfidentialCredits: { accounts: { token: A(1), authority: S(2) } },
  ConfidentialTransferWithFee: {
    accounts: { sourceToken: A(1), mint: A(2), destinationToken: A(3), instructionsSysvar: A(30), equalityRecord: A(31), transferAmountCiphertextValidityRecord: A(32), feeSigmaRecord: A(34), feeCiphertextValidityRecord: A(35), rangeRecord: A(33), authority: S(4) },
    args: {
      newSourceDecryptableAvailableBalance: db, transferAmountAuditorCiphertextLo: eb, transferAmountAuditorCiphertextHi: eb, equalityProofInstructionOffset: 1,
      transferAmountCiphertextValidityProofInstructionOffset: 2, feeSigmaProofInstructionOffset: 3, feeCiphertextValidityProofInstructionOffset: 4, rangeProofInstructionOffset: 5,
    },
  },
  ConfigureConfidentialTransferAccountWithRegistry: { accounts: { token: A(1), mint: A(2), elgamalRegistry: A(3), payer: S(4), systemProgram: A(5) } },
  InitializeDefaultAccountState: { accounts: { mint: A(1) }, args: { state: t22.AccountState.Frozen } },
  UpdateDefaultAccountState: { accounts: { mint: A(1), freezeAuthority: S(2) }, args: { state: t22.AccountState.Initialized } },
  Reallocate: { accounts: { token: A(1), payer: S(2), systemProgram: A(3), owner: S(4) }, args: { newExtensionTypes: [t22.ExtensionType.MemoTransfer, t22.ExtensionType.CpiGuard] } },
  EnableMemoTransfers: { accounts: { token: A(1), owner: S(2) } },
  DisableMemoTransfers: { accounts: { token: A(1), owner: S(2) } },
  CreateNativeMint: { accounts: { payer: S(1), nativeMint: A(2), systemProgram: A(3) } },
  InitializeNonTransferableMint: { accounts: { mint: A(1) } },
  InitializeInterestBearingMint: { accounts: { mint: A(1) }, args: { rateAuthority: A(2), rate: -25 } },
  UpdateRateInterestBearingMint: { accounts: { mint: A(1), rateAuthority: S(2) }, args: { rate: 300 } },
  EnableCpiGuard: { accounts: { token: A(1), owner: S(2) } },
  DisableCpiGuard: { accounts: { token: A(1), owner: S(2) } },
  InitializePermanentDelegate: { accounts: { mint: A(1) }, args: { delegate: A(2) } },
  InitializeTransferHook: { accounts: { mint: A(1) }, args: { authority: A(2), programId: A(3) } },
  UpdateTransferHook: { accounts: { mint: A(1), authority: S(2) }, args: { programId: null } },
  InitializeConfidentialTransferFee: { accounts: { mint: A(1) }, args: { authority: A(2), withdrawWithheldAuthorityElGamalPubkey: A(3) } },
  WithdrawWithheldTokensFromMintForConfidentialTransferFee: { accounts: { mint: A(1), destination: A(2), instructionsSysvarOrContextState: A(3), authority: S(4) }, args: { proofInstructionOffset: 1, newDecryptableAvailableBalance: db } },
  WithdrawWithheldTokensFromAccountsForConfidentialTransferFee: { accounts: { mint: A(1), destination: A(2), instructionsSysvarOrContextState: A(3), authority: S(4) }, args: { numTokenAccounts: 0, proofInstructionOffset: 1, newDecryptableAvailableBalance: db } },
  HarvestWithheldTokensToMintForConfidentialTransferFee: { accounts: { mint: A(1), sources: [A(2)] } },
  EnableHarvestToMint: { accounts: { mint: A(1), authority: S(2) } },
  DisableHarvestToMint: { accounts: { mint: A(1), authority: S(2) } },
  WithdrawExcessLamports: { accounts: { source: A(1), destination: A(2), authority: S(3) } },
  InitializeMetadataPointer: { accounts: { mint: A(1) }, args: { authority: A(2), metadataAddress: A(1) } },
  UpdateMetadataPointer: { accounts: { mint: A(1), metadataPointerAuthority: S(2) }, args: { metadataAddress: A(3) } },
  InitializeGroupPointer: { accounts: { mint: A(1) }, args: { authority: A(2), groupAddress: A(3) } },
  UpdateGroupPointer: { accounts: { mint: A(1), groupPointerAuthority: S(2) }, args: { groupAddress: null } },
  InitializeGroupMemberPointer: { accounts: { mint: A(1) }, args: { authority: null, memberAddress: A(3) } },
  UpdateGroupMemberPointer: { accounts: { mint: A(1), groupMemberPointerAuthority: S(2) }, args: { memberAddress: A(3) } },
  InitializeConfidentialMintBurn: { accounts: { mint: A(1) }, args: { supplyElgamalPubkey: A(2), decryptableSupply: db } },
  RotateSupplyElgamalPubkey: { accounts: { mint: A(1), instructionsSysvarOrContextState: A(2), authority: S(3) }, args: { newSupplyElgamalPubkey: A(4), proofInstructionOffset: 1 } },
  UpdateConfidentialMintBurnDecryptableSupply: { accounts: { mint: A(1), authority: S(2) }, args: { newDecryptableSupply: db } },
  ConfidentialMint: {
    accounts: { token: A(1), mint: A(2), ...proofCt, authority: S(3) },
    args: { newDecryptableSupply: db, mintAmountAuditorCiphertextLo: eb, mintAmountAuditorCiphertextHi: eb, equalityProofInstructionOffset: 1, ciphertextValidityProofInstructionOffset: 2, rangeProofInstructionOffset: 3 },
  },
  ConfidentialBurn: { accounts: { token: A(1), mint: A(2), ...proofCt, authority: S(3) }, args: ctBurn },
  ApplyConfidentialPendingBurn: { accounts: { mint: A(1), authority: S(2) } },
  InitializeScaledUiAmountMint: { accounts: { mint: A(1) }, args: { authority: A(2), multiplier: 1.5 } },
  UpdateMultiplierScaledUiMint: { accounts: { mint: A(1), authority: S(2) }, args: { multiplier: 2.25, effectiveTimestamp: 1_800_000_000n } },
  InitializePausableConfig: { accounts: { mint: A(1) }, args: { authority: A(2) } },
  Pause: { accounts: { mint: A(1), authority: S(2) } },
  Resume: { accounts: { mint: A(1), authority: S(2) } },
  InitializeTokenMetadata: { accounts: { metadata: A(1), updateAuthority: A(2), mint: A(3), mintAuthority: S(4) }, args: { name: 'Name ✓', symbol: 'SYM', uri: 'https://example.com/m.json' } },
  UpdateTokenMetadataField: { accounts: { metadata: A(1), updateAuthority: S(2) }, args: { field: t22.tokenMetadataField('Key', ['color']), value: 'violet' } },
  RemoveTokenMetadataKey: { accounts: { metadata: A(1), updateAuthority: S(2) }, args: { idempotent: true, key: 'color' } },
  UpdateTokenMetadataUpdateAuthority: { accounts: { metadata: A(1), updateAuthority: S(2) }, args: { newUpdateAuthority: A(3) } },
  EmitTokenMetadata: { accounts: { metadata: A(1) }, args: { start: 0n, end: 10n } },
  InitializeTokenGroup: { accounts: { group: A(1), mint: A(2), mintAuthority: S(3) }, args: { updateAuthority: A(4), maxSize: 100n } },
  UpdateTokenGroupMaxSize: { accounts: { group: A(1), updateAuthority: S(2) }, args: { maxSize: 200n } },
  UpdateTokenGroupUpdateAuthority: { accounts: { group: A(1), updateAuthority: S(2) }, args: { newUpdateAuthority: null } },
  InitializeTokenGroupMember: { accounts: { member: A(1), memberMint: A(2), memberMintAuthority: S(3), group: A(4), groupUpdateAuthority: S(5) } },
  UnwrapLamports: { accounts: { source: A(1), destination: A(2), authority: S(3) }, args: { amount: 1_000_000n } },
  InitializePermissionedBurn: { accounts: { mint: A(1) }, args: { authority: A(2) } },
  PermissionedBurn: { accounts: { account: A(1), mint: A(2), permissionedBurnAuthority: S(3), authority: S(4) }, args: { amount: 5n } },
  PermissionedBurnChecked: { accounts: { account: A(1), mint: A(2), permissionedBurnAuthority: S(3), authority: S(4) }, args: { amount: 5n, decimals: 6 } },
  PermissionedConfidentialBurn: { accounts: { token: A(1), mint: A(2), ...proofCt, permissionedBurnAuthority: S(5), authority: S(3) }, args: ctBurn },
  // Built from its inner instructions (below); its own data is the list, checked in its own test.
  Batch: { accounts: {} },
}

const toRaw = (ix: Instruction): RawInstruction => ({
  programAddress: ix.programAddress,
  accounts: (ix.accounts ?? []).map((a) => ({ address: a.address, signer: a.role >= 2, writable: (a.role & 1) === 1 })),
  data: new Uint8Array(ix.data ?? []),
})

/** The builder's args as the preview shows them: options unwrapped, bytes base64, enums as numbers. */
const expectedArgs = (args: Record<string, unknown> = {}): Record<string, PreviewValue> => toPreviewValue(args) as Record<string, PreviewValue>

const batchOf = () => t22.getBatchInstruction([
  t22.getTransferCheckedInstruction({ source: A(1), mint: A(2), destination: A(3), authority: S(4), amount: 7n, decimals: 6 }),
  t22.getApproveInstruction({ source: A(1), delegate: A(5), owner: S(4), amount: 0xffffffffffffffffn }),
])

const build = (name: string, row: Row): Instruction => {
  if (name === 'Batch') return batchOf()
  const builder = (t22 as unknown as Record<string, (input: unknown) => Instruction>)[`get${name}Instruction`]
  if (!builder) throw new Error(`no builder for ${name}`)
  return builder({ ...row.accounts, ...row.args })
}

const names = Object.keys(t22.Token2022Instruction).filter((k) => Number.isNaN(Number(k)))

describe('Token-2022: every instruction of every extension round-trips through the decoder', () => {
  it('the table covers the whole enum (100 instructions in token-2022 0.20)', () => {
    expect(names.length).toBeGreaterThanOrEqual(100)
    expect(names.filter((n) => !(n in rows))).toEqual([])
  })

  it.each(names)('%s', (name) => {
    const row = rows[name as keyof typeof rows]!
    const ix = build(name, row)
    expect(ix.programAddress).toBe(TOKEN_2022_PROGRAM)
    const d = decodeInstruction(toRaw(ix), 0)
    expect(d.error).toBeUndefined()
    expect(d).toMatchObject({ decoded: true, programName: 'Token-2022 Program', name })
    if (name !== 'Batch') expect(d.args).toEqual(expectedArgs(row.args))
    // Every single account the input named comes back under that name; list inputs (multisig signers, sources) stay unnamed.
    for (const [field, value] of Object.entries(row.accounts)) {
      if (Array.isArray(value)) {
        for (const a of value) expect(d.accounts.find((x) => x.address === a)?.name, `${name}.${field}[]`).toBeNull()
        continue
      }
      const address = typeof value === 'string' ? value : value.address
      expect(d.accounts.find((x) => x.address === address)?.name, `${name}.${field}`).toBe(field)
    }
    if (d.accounts.length > 0 && Object.values(row.accounts).some((v) => !Array.isArray(v))) expect(d.accounts.some((a) => a.name !== null)).toBe(true)
  })

  it('an omitted optional account does not shift the names after it (ConfidentialTransfer with context-state proofs only)', () => {
    const ix = t22.getConfidentialTransferInstruction({
      sourceToken: A(1), mint: A(2), destinationToken: A(3), authority: S(4),
      newSourceDecryptableAvailableBalance: db, transferAmountAuditorCiphertextLo: eb, transferAmountAuditorCiphertextHi: eb,
      equalityProofInstructionOffset: 0, ciphertextValidityProofInstructionOffset: 0, rangeProofInstructionOffset: 0,
    })
    const d = decodeInstruction(toRaw(ix), 0)
    expect(d.accounts.map((a) => a.name)).toEqual(['sourceToken', 'mint', 'destinationToken', 'authority'])
  })

  it('Batch opens up: each inner instruction decoded with its own slice of the accounts', () => {
    const d = decodeInstruction(toRaw(batchOf()), 0)
    expect(d).toMatchObject({ name: 'Batch', decoded: true })
    const inner = d.args.instructions as Array<{ name: string; args: Record<string, PreviewValue>; accounts: Array<{ address: string; name: string | null }> }>
    expect(inner.map((i) => i.name)).toEqual(['TransferChecked', 'Approve'])
    expect(inner[0]!.args).toEqual({ amount: 7n, decimals: 6 })
    expect(inner[0]!.accounts.map((a) => a.name)).toEqual(['source', 'mint', 'destination', 'authority'])
    expect(inner[1]!.accounts.map((a) => [a.name, a.address])).toEqual([['source', A(1)], ['delegate', A(5)], ['owner', A(4)]])
    expect(inner[1]!.args.amount).toBe(0xffffffffffffffffn)
  })

  it('multisig signers past the named accounts stay unnamed', () => {
    const ix = t22.getTransferCheckedInstruction({ source: A(1), mint: A(2), destination: A(3), authority: A(9), amount: 1n, decimals: 0, multiSigners: [S(10), S(11)] })
    const d = decodeInstruction(toRaw(ix), 0)
    expect(d.accounts.map((a) => a.name)).toEqual(['source', 'mint', 'destination', 'authority', null, null])
  })
})
