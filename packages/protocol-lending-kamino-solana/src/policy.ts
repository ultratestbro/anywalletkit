// The instructions each Kamino operation may carry, with the accounts that decide where value goes
// pinned: the wallet, its vanilla obligation, the configured market or vault, the reserve and mint
// the operation names, and the wallet's own token accounts (scan 2026-10-27 modules, F1). Anything
// else — a collateral withdrawal inside a deposit, a borrow inside a repay, a token transfer, an
// `invest` or reward harvest — is refused by the wallet's guard before signing. Positions follow
// the klend / kvault / farms IDLs; the live /ktx transactions of 2026-10-13 and 2026-10-28 carry
// exactly these shapes.
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM, FARMS_PROGRAM, KLEND_PROGRAM, KVAULT_PROGRAM, MEMO_PROGRAM,
  SYSTEM_PROGRAM, TOKEN_PROGRAM,
} from './programs.js'

/** Mirrors wallet-solana's `SerializedInstructionRule`. */
export interface InstructionRule {
  program: string
  /** Hex the data starts with. */
  data?: string
  /** Exact data length in bytes. */
  dataLength?: number
  /** Accounts by position: this address or one of these. */
  accounts?: Readonly<Record<number, string | readonly string[]>>
}

/** Anchor discriminators of the instructions the rules allow. */
export const IX = Object.freeze({
  initUserMetadata: '75a9b045c5170fa2',
  initObligation: 'fb0ae74c1b0b9f60',
  initObligationFarmsForReserve: '883f0fbad398a8a4',
  refreshReserve: '02da8aeb4fc91966',
  refreshObligation: '218493e497c04859',
  refreshObligationFarmsForReserve: '8c90fd150a4af803',
  requestElevationGroup: '2477fb8122f00793',
  depositV2: 'd8e0bf1bcc9766af',
  withdrawV2: 'eb34779895c51407',
  borrowV2: 'a1808ff5abc7c206',
  repayV2: '74aed54cb435d290',
  vaultDeposit: 'f223c68952e1f2b6',
  vaultWithdraw: 'b712469c946da122',
  vaultWithdrawFromAvailable: '1383709baadc2239',
  farmInitializeUser: '6f11b9fa3c7a26fe',
  farmStake: 'ceb0ca12c8d1b36c',
  farmUnstake: '5a5f6b2acd7c32e1',
  farmWithdrawUnstaked: '2466bb31dc248443',
})

/**
 * What every Kamino transaction may carry around the protocol call: compute budget, memos, the
 * wallet's own associated token accounts, and SOL wrapped into (and unwrapped from) its wSOL account.
 */
export function plumbing(me: string, wsolAta: string): InstructionRule[] {
  return [
    { program: COMPUTE_BUDGET_PROGRAM },
    { program: MEMO_PROGRAM },
    // Create / CreateIdempotent: payer and owner are the wallet.
    { program: ASSOCIATED_TOKEN_PROGRAM, data: '', dataLength: 0, accounts: { 0: me, 2: me } },
    { program: ASSOCIATED_TOKEN_PROGRAM, data: '01', dataLength: 1, accounts: { 0: me, 2: me } },
    // System Transfer into the wallet's wSOL account, SyncNative on it, and closing it back to the wallet.
    { program: SYSTEM_PROGRAM, data: '02000000', dataLength: 12, accounts: { 0: me, 1: wsolAta } },
    { program: TOKEN_PROGRAM, data: '11', dataLength: 1, accounts: { 0: wsolAta } },
    { program: TOKEN_PROGRAM, data: '09', dataLength: 1, accounts: { 0: wsolAta, 1: me, 2: me } },
  ]
}

export interface MarketRuleAccounts {
  me: string
  market: string
  obligation: string
  reserve: string
  mint: string
  /** The wallet's token account for `mint` (the one the reserve's token program derives). */
  ata: string
  wsolAta: string
}

/** A Lend operation: refreshes, the obligation's farm set-up, and the one call the operation is — on this obligation, reserve, mint and ATA. */
export function marketRules(op: 'deposit' | 'withdraw' | 'borrow' | 'repay', a: MarketRuleAccounts): InstructionRule[] {
  const { me, market, obligation, reserve, mint, ata } = a
  const owner = { 0: me, 1: obligation, 2: market }
  const rules: InstructionRule[] = [
    ...plumbing(me, a.wsolAta),
    { program: KLEND_PROGRAM, data: IX.refreshReserve, dataLength: 8, accounts: { 1: market } },
    { program: KLEND_PROGRAM, data: IX.refreshObligation, dataLength: 8, accounts: { 0: market, 1: obligation } },
    { program: KLEND_PROGRAM, data: IX.refreshObligationFarmsForReserve, dataLength: 9, accounts: { 1: obligation, 6: market } },
    { program: KLEND_PROGRAM, data: IX.initObligationFarmsForReserve, dataLength: 9, accounts: { 0: me, 1: me, 2: obligation, 7: market } },
  ]
  if (op === 'deposit') {
    rules.push(
      // A first deposit: user metadata, the vanilla obligation (tag 0, id 0) and the user's lookup table, all paid by the wallet.
      { program: KLEND_PROGRAM, data: IX.initUserMetadata, dataLength: 40, accounts: { 0: me, 1: me } },
      { program: KLEND_PROGRAM, data: `${IX.initObligation}0000`, dataLength: 10, accounts: { 0: me, 1: me, 2: obligation, 3: market } },
      { program: ADDRESS_LOOKUP_TABLE_PROGRAM, data: '00000000', dataLength: 13, accounts: { 1: me, 2: me } },
      { program: ADDRESS_LOOKUP_TABLE_PROGRAM, data: '02000000', accounts: { 1: me } },
      { program: KLEND_PROGRAM, data: IX.depositV2, dataLength: 16, accounts: { ...owner, 4: reserve, 5: mint, 9: ata } },
    )
  } else if (op === 'withdraw') {
    rules.push({ program: KLEND_PROGRAM, data: IX.withdrawV2, dataLength: 16, accounts: { ...owner, 4: reserve, 5: mint, 9: ata } })
  } else if (op === 'borrow') {
    rules.push(
      { program: KLEND_PROGRAM, data: IX.requestElevationGroup, dataLength: 9, accounts: owner },
      { program: KLEND_PROGRAM, data: IX.borrowV2, dataLength: 16, accounts: { ...owner, 4: reserve, 5: mint, 8: ata } },
    )
  } else {
    rules.push({ program: KLEND_PROGRAM, data: IX.repayV2, dataLength: 16, accounts: { ...owner, 3: reserve, 4: mint, 6: ata } })
  }
  return rules
}

export interface VaultRuleAccounts {
  me: string
  vault: string
  mint: string
  sharesMint: string
  /** The wallet's token account for the vault's asset. */
  tokenAta: string
  /** The wallet's shares account (either token program's derivation). */
  sharesAtas: readonly string[]
  /** The vault's farm and the wallet's state in it, when the vault has a farm. */
  farm: { farm: string; userState: string } | null
  wsolAta: string
}

/** An Earn vault operation: the deposit or redemption on this vault with the wallet's accounts, and the farm steps around it. */
export function vaultRules(op: 'deposit' | 'withdraw', a: VaultRuleAccounts, opts: { stake: boolean }): InstructionRule[] {
  const { me, vault, mint, sharesMint, tokenAta, sharesAtas, farm } = a
  const rules: InstructionRule[] = plumbing(me, a.wsolAta)
  if (op === 'deposit') {
    rules.push({ program: KVAULT_PROGRAM, data: IX.vaultDeposit, dataLength: 16, accounts: { 0: me, 1: vault, 3: mint, 5: sharesMint, 6: tokenAta, 7: sharesAtas } })
    if (opts.stake && farm) {
      rules.push(
        { program: FARMS_PROGRAM, data: IX.farmInitializeUser, dataLength: 8, accounts: { 0: me, 1: me, 2: me, 3: me, 4: farm.userState, 5: farm.farm } },
        { program: FARMS_PROGRAM, data: IX.farmStake, dataLength: 16, accounts: { 0: me, 1: farm.userState, 2: farm.farm, 4: sharesAtas, 5: sharesMint } },
      )
    }
  } else {
    const redeem = { 0: me, 1: vault, 5: tokenAta, 6: mint, 7: sharesAtas, 8: sharesMint }
    rules.push(
      { program: KVAULT_PROGRAM, data: IX.vaultWithdrawFromAvailable, dataLength: 16, accounts: redeem },
      { program: KVAULT_PROGRAM, data: IX.vaultWithdraw, dataLength: 16, accounts: redeem },
    )
    if (farm) {
      rules.push(
        { program: FARMS_PROGRAM, data: IX.farmUnstake, dataLength: 24, accounts: { 0: me, 1: farm.userState, 2: farm.farm } },
        { program: FARMS_PROGRAM, data: IX.farmWithdrawUnstaked, dataLength: 8, accounts: { 0: me, 1: farm.userState, 2: farm.farm, 3: sharesAtas } },
      )
    }
  }
  return rules
}
