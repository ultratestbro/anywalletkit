// Programs a Kamino transaction may invoke, and the Anchor instruction names
// behind the discriminators the API's transactions were seen to carry
// (decoded from /ktx responses on 2026-10-13, names checked against the
// klend / kvault IDLs in github.com/Kamino-Finance/klend-sdk).

export const KLEND_PROGRAM = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'
export const KVAULT_PROGRAM = 'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd'
export const FARMS_PROGRAM = 'FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr'
/** A first Lend deposit creates a per-user lookup table (the user pays its rent, stays its authority). */
export const ADDRESS_LOOKUP_TABLE_PROGRAM = 'AddressLookupTab1e1111111111111111111111111'
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
export const SYSTEM_PROGRAM = '11111111111111111111111111111111'
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'

/** Every program a Kamino Earn / Lend transaction from the API may call; anything else is refused before signing. */
export const KAMINO_PROGRAM_ALLOWLIST: readonly string[] = Object.freeze([
  SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM, MEMO_PROGRAM,
  KLEND_PROGRAM, KVAULT_PROGRAM, FARMS_PROGRAM, ADDRESS_LOOKUP_TABLE_PROGRAM,
])

/** Anchor discriminator (first 8 bytes, hex) → instruction, per program. */
export const INSTRUCTION_NAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  [KLEND_PROGRAM]: Object.freeze({
    '75a9b045c5170fa2': 'initUserMetadata',
    'fb0ae74c1b0b9f60': 'initObligation',
    '883f0fbad398a8a4': 'initObligationFarmsForReserve',
    '8c90fd150a4af803': 'refreshObligationFarmsForReserve',
    '02da8aeb4fc91966': 'refreshReserve',
    '218493e497c04859': 'refreshObligation',
    'd8e0bf1bcc9766af': 'depositReserveLiquidityAndObligationCollateralV2',
    'eb34779895c51407': 'withdrawObligationCollateralAndRedeemReserveCollateralV2',
    'a1808ff5abc7c206': 'borrowObligationLiquidityV2',
    '74aed54cb435d290': 'repayObligationLiquidityV2',
    'a9c91e7e06cd6644': 'depositReserveLiquidity',
    'ea75b57db98edc1d': 'redeemReserveCollateral',
    '2477fb8122f00793': 'requestElevationGroup',
  }),
  [KVAULT_PROGRAM]: Object.freeze({
    'f223c68952e1f2b6': 'deposit',
    'b712469c946da122': 'withdraw',
    '1383709baadc2239': 'withdrawFromAvailable',
    '0df5b467feb67904': 'invest',
  }),
  [FARMS_PROGRAM]: Object.freeze({
    '6f11b9fa3c7a26fe': 'initializeUser',
    'ceb0ca12c8d1b36c': 'stake',
    '5a5f6b2acd7c32e1': 'unstake',
    '2466bb31dc248443': 'withdrawUnstakedDeposits',
    '44c8e4e9b820e2bc': 'harvestReward',
  }),
})

/** The instruction a Kamino program call is, from its data; undefined when unknown. */
export function instructionName(programId: string, data: Uint8Array): string | undefined {
  const table = INSTRUCTION_NAMES[programId]
  if (!table || data.length < 8) return undefined
  const hex = Array.from(data.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
  return table[hex]
}
