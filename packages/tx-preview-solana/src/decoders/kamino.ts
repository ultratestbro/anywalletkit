/**
 * Kamino Lend (`KLend2g…`): every instruction of its on-chain Anchor IDL (66 instructions) with its arguments and
 * named accounts — deposits, withdrawals, borrows, repays (plain and `V2`, which adds the farm accounts), flash
 * loans, liquidations, obligation orders and the admin calls alike — plus its `emit_cpi!` borrow-order events.
 *
 * Account names follow the IDL. Where an instruction nests account groups (`depositAccounts`, `farmsAccounts`…) they
 * are flattened in order; a name two groups share gets its group as a prefix (`repayOwner` / `withdrawOwner`,
 * `collateralFarmsReserveFarmState` / `debtFarmsReserveFarmState`). `RefreshObligation`'s trailing accounts (the
 * obligation's reserves) and `RefreshReservesBatch`'s (reserve, market pairs) stay unnamed.
 *
 * Tables: IDL snapshot of 2026-11-17, read from the IDL account `8qLKwp1fk8WyqmzarkuMeZEX3AzL4VDSmA2UZTKT2aCJ`
 * (kamino_lending 1.27.0). When the program upgrades, regenerate:
 *   SOLANA_RPC_URL=… node scripts/anchor-tables.mjs KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD --write src/decoders/kamino.ts
 * and update the date above.
 */
import type { InstructionDecoder } from '../types.js'
import { anchorDecoder, type AnchorEvent, type AnchorInstruction, type AnchorTypes } from './anchor.js'

export const KAMINO_LEND_PROGRAM = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'

// Discriminators: sha256("global:<snake_case name>")[0..8], events sha256("event:<Name>")[0..8]; the tests recompute
// every one of them.

// <anchor-tables program=KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD idl=kamino_lending@1.27.0>
// Generated 2026-11-17 by scripts/anchor-tables.mjs from the IDL account 8qLKwp1fk8WyqmzarkuMeZEX3AzL4VDSmA2UZTKT2aCJ;
// regenerate instead of editing by hand.
const TYPES: AnchorTypes = {
  ReserveConfigCustomizationArgs: { struct: [
    ['overrideFixedRateBps', 'u8'], ['fixedBorrowRateBps', 'u32'], ['overrideDebtTermSeconds', 'u8'], ['debtTermSeconds', 'u64'],
    ['clearElevationGroups', 'u8'],
  ] },
  UpdateConfigMode: { variants: [
    ['UpdateLoanToValuePct'], ['UpdateMaxLiquidationBonusBps'], ['UpdateLiquidationThresholdPct'], ['UpdateProtocolLiquidationFee'],
    ['UpdateProtocolTakeRate'], ['UpdateFeesOriginationFee'], ['UpdateFeesFlashLoanFee'], ['DeprecatedUpdateFeesReferralFeeBps'],
    ['UpdateDepositLimit'], ['UpdateBorrowLimit'], ['UpdateTokenInfoLowerHeuristic'], ['UpdateTokenInfoUpperHeuristic'],
    ['UpdateTokenInfoExpHeuristic'], ['UpdateTokenInfoTwapDivergence'], ['UpdateTokenInfoScopeTwap'], ['UpdateTokenInfoScopeChain'],
    ['UpdateTokenInfoName'], ['UpdateTokenInfoPriceMaxAge'], ['UpdateTokenInfoTwapMaxAge'], ['UpdateScopePriceFeed'], ['UpdatePythPrice'],
    ['UpdateSwitchboardFeed'], ['UpdateSwitchboardTwapFeed'], ['UpdateBorrowRateCurve'], ['DeprecatedUpdateEntireReserveConfig'],
    ['UpdateDebtWithdrawalCap'], ['UpdateDepositWithdrawalCap'], ['DeprecatedUpdateDebtWithdrawalCapCurrentTotal'],
    ['DeprecatedUpdateDepositWithdrawalCapCurrentTotal'], ['UpdateBadDebtLiquidationBonusBps'], ['UpdateMinLiquidationBonusBps'],
    ['UpdateDeleveragingMarginCallPeriod'], ['UpdateBorrowFactor'], ['DeprecatedUpdateAssetTier'], ['UpdateElevationGroup'],
    ['UpdateDeleveragingThresholdDecreaseBpsPerDay'], ['DeprecatedUpdateMultiplierSideBoost'], ['DeprecatedUpdateMultiplierTagBoost'],
    ['UpdateReserveStatus'], ['UpdateFarmCollateral'], ['UpdateFarmDebt'], ['UpdateDisableUsageAsCollateralOutsideEmode'],
    ['UpdateBlockBorrowingAboveUtilizationPct'], ['UpdateBlockPriceUsage'], ['UpdateBorrowLimitOutsideElevationGroup'],
    ['UpdateBorrowLimitsInElevationGroupAgainstThisReserve'], ['UpdateHostFixedInterestRateBps'], ['UpdateAutodeleverageEnabled'],
    ['UpdateDeleveragingBonusIncreaseBpsPerDay'], ['UpdateProtocolOrderExecutionFee'], ['UpdateProposerAuthorityLock'],
    ['UpdateMinDeleveragingBonusBps'], ['UpdateBlockCTokenUsage'], ['UpdateDebtMaturityTimestamp'], ['UpdateDebtTermSeconds'],
    ['UpdateEarlyRepayRemainingInterestPct'], ['UpdateReserveEmergencyMode'], ['UpdateRewardsAmountPerAccrualUnit'],
    ['UpdateReservePermissionedOps'], ['UpdateInterestRateBasis'],
  ] },
  InitObligationArgs: { struct: [['tag', 'u8'], ['id', 'u8']] },
  ObligationOrder: { struct: [
    ['conditionThresholdSf', 'u128'], ['opportunityParameterSf', 'u128'], ['minExecutionBonusBps', 'u16'], ['maxExecutionBonusBps', 'u16'],
    ['conditionType', 'u8'], ['opportunityType', 'u8'], ['padding1', { array: 'u8', len: 10 }], ['padding2', { array: 'u128', len: 5 }],
  ] },
  BorrowOrderConfigArgs: { struct: [
    ['remainingDebtAmount', 'u64'], ['maxBorrowRateBps', 'u32'], ['minDebtTermSeconds', 'u64'], ['fillableUntilTimestamp', 'u64'],
    ['enableAutoRolloverOnFilledBorrows', 'bool'],
  ] },
  UpdateObligationConfigMode: { variants: [
    ['FixedTermRolloverEnabled'], ['FixedTermRolloverMaxBorrowRateBps'], ['FixedTermRolloverMinDebtTermSeconds'],
    ['FixedTermRolloverOpenTermAllowed'], ['MigrationToFixedEnabled'], ['FixedTermRolloverWindowDurationDays'],
  ] },
  ProgressCallbackType: { variants: [['None'], ['KlendQueueAccountingHandlerOnKvault']] },
  UpdateGlobalConfigMode: { variants: [['PendingAdmin'], ['FeeCollector']] },
  ReserveFarmKind: { variants: [['Collateral'], ['Debt']] },
  FeeCalculation: { variants: [['Exclusive'], ['Inclusive']] },
  ReserveStatus: { variants: [['Active'], ['Obsolete'], ['Hidden']] },
  UpdateLendingMarketConfigValue: { variants: [
    ['Bool', [['value', 'bool']]],
    ['U8', [['value', 'u8']]],
    ['U8Array', [['value', { array: 'u8', len: 8 }]]],
    ['U16', [['value', 'u16']]],
    ['U64', [['value', 'u64']]],
    ['U128', [['value', 'u128']]],
    ['Pubkey', [['value', 'pubkey']]],
    ['ElevationGroup', [['value', { def: 'ElevationGroup' }]]],
    ['Name', [['value', { array: 'u8', len: 32 }]]],
  ] },
  ElevationGroup: { struct: [
    ['maxLiquidationBonusBps', 'u16'], ['id', 'u8'], ['ltvPct', 'u8'], ['liquidationThresholdPct', 'u8'], ['allowNewLoans', 'u8'],
    ['maxReservesAsCollateral', 'u8'], ['padding0', 'u8'], ['debtReserve', 'pubkey'], ['padding1', { array: 'u64', len: 4 }],
  ] },
  UpdateLendingMarketMode: { variants: [
    ['UpdateOwner'], ['UpdateEmergencyMode'], ['UpdateLiquidationCloseFactor'], ['UpdateLiquidationMaxValue'],
    ['DeprecatedUpdateGlobalUnhealthyBorrow'], ['UpdateGlobalAllowedBorrow'], ['UpdateEmergencyCouncil'],
    ['UpdateMinFullLiquidationThreshold'], ['UpdateInsolvencyRiskLtv'], ['UpdateElevationGroup'], ['UpdateReferralFeeBps'],
    ['DeprecatedUpdateMultiplierPoints'], ['UpdatePriceRefreshTriggerToMaxAgePct'], ['UpdateAutodeleverageEnabled'],
    ['UpdateBorrowingDisabled'], ['UpdateMinNetValueObligationPostAction'], ['UpdateMinValueLtvSkipPriorityLiqCheck'],
    ['UpdateMinValueBfSkipPriorityLiqCheck'], ['UpdatePaddingFields'], ['UpdateName'],
    ['UpdateIndividualAutodeleverageMarginCallPeriodSecs'], ['UpdateInitialDepositAmount'], ['UpdateObligationOrderExecutionEnabled'],
    ['UpdateImmutableFlag'], ['UpdateObligationOrderCreationEnabled'], ['UpdateProposerAuthority'],
    ['UpdatePriceTriggeredLiquidationDisabled'], ['UpdateMatureReserveDebtLiquidationEnabled'],
    ['UpdateObligationBorrowDebtTermLiquidationEnabled'], ['UpdateBorrowOrderCreationEnabled'], ['UpdateBorrowOrderExecutionEnabled'],
    ['UpdateMinBorrowOrderFillValue'], ['UpdateWithdrawTicketIssuanceEnabled'], ['UpdateWithdrawTicketRedemptionEnabled'],
    ['UpdateMinWithdrawQueuedLiquidityValue'], ['UpdateFixedTermRolloverWindowDurationSeconds'],
    ['UpdateOpenTermRolloverWindowDurationSeconds'], ['UpdateObligationBorrowRolloverConfigurationEnabled'],
    ['UpdateTermBasedFullLiquidationDurationSecs'], ['UpdateObligationBorrowMigrationToFixedExecutionEnabled'],
    ['UpdateMinPartialRolloverValue'], ['UpdateWithdrawTicketCancellationEnabled'], ['UpdatePermissioningAuthority'],
    ['UpdatePermissionedOps'], ['DeprecatedUpdateReserveRewardsMaxAprPct'], ['UpdateReserveRewardsMaxAprBps'], ['UpdateDisableNonceBlock'],
    ['UpdateMinObligationOrderExecutionValue'],
  ] },
  BorrowOrder: { struct: [
    ['debtLiquidityMint', 'pubkey'], ['remainingDebtAmount', 'u64'], ['filledDebtDestination', 'pubkey'], ['minDebtTermSeconds', 'u64'],
    ['fillableUntilTimestamp', 'u64'], ['placedAtTimestamp', 'u64'], ['lastUpdatedAtTimestamp', 'u64'], ['requestedDebtAmount', 'u64'],
    ['maxBorrowRateBps', 'u32'], ['active', 'u8'], ['enableAutoRolloverOnFilledBorrows', 'u8'], ['padding1', { array: 'u8', len: 2 }],
    ['endPadding', { array: 'u64', len: 5 }],
  ] },
}

const INSTRUCTIONS: readonly AnchorInstruction[] = [
  ['22a2740e65895eef', 'InitLendingMarket', [['quoteCurrency', { array: 'u8', len: 32 }]],
    ['lendingMarketOwner', 'lendingMarket', 'lendingMarketAuthority', 'systemProgram', 'rent', 'instructionSysvarAccount']],
  ['d19d35d261b41f2d', 'UpdateLendingMarket', [['mode', 'u64'], ['value', { array: 'u8', len: 72 }]],
    ['signer', 'lendingMarket', 'instructionSysvarAccount']],
  ['76e00a3ec4e6b859', 'UpdateLendingMarketOwner', [], ['lendingMarketOwnerCached', 'lendingMarket', 'instructionSysvarAccount']],
  ['8af547e19904032b', 'InitReserve', [],
    [
      'signer', 'lendingMarket', 'lendingMarketAuthority', 'reserve', 'reserveLiquidityMint', 'reserveLiquiditySupply', 'feeReceiver',
      'reserveCollateralMint', 'reserveCollateralSupply', 'initialLiquiditySource', 'rent', 'liquidityTokenProgram',
      'collateralTokenProgram', 'systemProgram', 'instructionSysvarAccount',
    ]],
  ['f405c671110a4721', 'CloneReserveConfig', [['customizations', { def: 'ReserveConfigCustomizationArgs' }]],
    ['signer', 'targetLendingMarket', 'sourceReserve', 'targetReserve', 'instructionSysvarAccount']],
  ['da063ee90121e852', 'InitFarmsForReserve', [['mode', 'u8']],
    [
      'lendingMarketOwner', 'lendingMarket', 'lendingMarketAuthority', 'reserve', 'farmsProgram', 'farmsGlobalConfig', 'farmState',
      'farmsVaultAuthority', 'rent', 'systemProgram', 'instructionSysvarAccount',
    ]],
  ['3d9464468f6b110d', 'UpdateReserveConfig', [
    ['mode', { def: 'UpdateConfigMode' }], ['value', 'bytes'], ['skipConfigIntegrityValidation', 'bool'],
  ],
    ['signer', 'globalConfig', 'lendingMarket', 'reserve', 'instructionSysvarAccount']],
  ['d727b429ad2ef8dc', 'RedeemFees', [],
    [
      'reserve', 'reserveLiquidityMint', 'reserveLiquidityFeeReceiver', 'reserveSupplyLiquidity', 'lendingMarket', 'lendingMarketAuthority',
      'tokenProgram',
    ]],
  ['9ec99ebd215da267', 'WithdrawProtocolFee', [['amount', 'u64']],
    [
      'globalConfig', 'lendingMarket', 'reserve', 'reserveLiquidityMint', 'lendingMarketAuthority', 'feeVault', 'feeCollectorAta',
      'tokenProgram', 'instructionSysvarAccount',
    ]],
  ['fec5e476b7ce3ee2', 'SeedDepositOnInitReserve', [],
    [
      'signer', 'lendingMarket', 'reserve', 'reserveLiquidityMint', 'reserveLiquiditySupply', 'initialLiquiditySource',
      'liquidityTokenProgram',
    ]],
  ['3fff82d36ed858ad', 'TopupReserveRewards', [['amount', 'u64']],
    ['signer', 'lendingMarket', 'reserve', 'reserveLiquidityMint', 'reserveLiquiditySupply', 'sourceLiquidity', 'liquidityTokenProgram']],
  ['f54b5b00ec611303', 'SocializeLoss', [['liquidityAmount', 'u64']],
    ['lendingMarketOwner', 'obligation', 'lendingMarket', 'reserve', 'instructionSysvarAccount']],
  ['ee5f62dcbb28cc9a', 'SocializeLossV2', [['liquidityAmount', 'u64']],
    [
      'lendingMarketOwner', 'obligation', 'lendingMarket', 'reserve', 'instructionSysvarAccount', 'obligationFarmUserState',
      'reserveFarmState', 'lendingMarketAuthority', 'farmsProgram',
    ]],
  ['a423b6130074f37f', 'MarkObligationForDeleveraging', [['autodeleverageTargetLtvPct', 'u8']],
    ['lendingMarketOwner', 'obligation', 'lendingMarket', 'instructionSysvarAccount']],
  ['02da8aeb4fc91966', 'RefreshReserve', [],
    ['reserve', 'lendingMarket', 'pythOracle', 'switchboardPriceOracle', 'switchboardTwapOracle', 'scopePrices']],
  ['906e1a67a2ccfc93', 'RefreshReservesBatch', [['skipPriceUpdates', 'bool']], []],
  ['20fddc0d13a583bc', 'CalculateCtokenExchangeRate', [], ['reserve']],
  ['a9c91e7e06cd6644', 'DepositReserveLiquidity', [['liquidityAmount', 'u64']],
    [
      'owner', 'reserve', 'lendingMarket', 'lendingMarketAuthority', 'reserveLiquidityMint', 'reserveLiquiditySupply',
      'reserveCollateralMint', 'userSourceLiquidity', 'userDestinationCollateral', 'collateralTokenProgram', 'liquidityTokenProgram',
      'instructionSysvarAccount',
    ]],
  ['ea75b57db98edc1d', 'RedeemReserveCollateral', [['collateralAmount', 'u64']],
    [
      'owner', 'lendingMarket', 'reserve', 'lendingMarketAuthority', 'reserveLiquidityMint', 'reserveCollateralMint',
      'reserveLiquiditySupply', 'userSourceCollateral', 'userDestinationLiquidity', 'collateralTokenProgram', 'liquidityTokenProgram',
      'instructionSysvarAccount',
    ]],
  ['fb0ae74c1b0b9f60', 'InitObligation', [['args', { def: 'InitObligationArgs' }]],
    [
      'obligationOwner', 'feePayer', 'obligation', 'lendingMarket', 'seed1Account', 'seed2Account', 'ownerUserMetadata', 'rent',
      'systemProgram',
    ]],
  ['883f0fbad398a8a4', 'InitObligationFarmsForReserve', [['mode', 'u8']],
    [
      'payer', 'owner', 'obligation', 'lendingMarketAuthority', 'reserve', 'reserveFarmState', 'obligationFarm', 'lendingMarket',
      'farmsProgram', 'rent', 'systemProgram',
    ]],
  ['8c90fd150a4af803', 'RefreshObligationFarmsForReserve', [['mode', 'u8']],
    [
      'crank', 'obligation', 'lendingMarketAuthority', 'reserve', 'reserveFarmState', 'obligationFarmUserState', 'lendingMarket',
      'farmsProgram', 'rent', 'systemProgram',
    ]],
  ['218493e497c04859', 'RefreshObligation', [], ['lendingMarket', 'obligation']],
  ['6cd1044815167685', 'DepositObligationCollateral', [['collateralAmount', 'u64']],
    [
      'owner', 'obligation', 'lendingMarket', 'depositReserve', 'reserveDestinationCollateral', 'userSourceCollateral', 'tokenProgram',
      'instructionSysvarAccount',
    ]],
  ['8991975ea7710491', 'DepositObligationCollateralV2', [['collateralAmount', 'u64']],
    [
      'owner', 'obligation', 'lendingMarket', 'depositReserve', 'reserveDestinationCollateral', 'userSourceCollateral', 'tokenProgram',
      'instructionSysvarAccount', 'lendingMarketAuthority', 'obligationFarmUserState', 'reserveFarmState', 'farmsProgram',
    ]],
  ['2574cd67f3c05cc6', 'WithdrawObligationCollateral', [['collateralAmount', 'u64']],
    [
      'owner', 'obligation', 'lendingMarket', 'lendingMarketAuthority', 'withdrawReserve', 'reserveSourceCollateral',
      'userDestinationCollateral', 'tokenProgram', 'instructionSysvarAccount',
    ]],
  ['caf97572e7c02f8a', 'WithdrawObligationCollateralV2', [['collateralAmount', 'u64']],
    [
      'owner', 'obligation', 'lendingMarket', 'lendingMarketAuthority', 'withdrawReserve', 'reserveSourceCollateral',
      'userDestinationCollateral', 'tokenProgram', 'instructionSysvarAccount', 'obligationFarmUserState', 'reserveFarmState',
      'farmsProgram',
    ]],
  ['797f12cc49f5e141', 'BorrowObligationLiquidity', [['liquidityAmount', 'u64']],
    [
      'owner', 'obligation', 'lendingMarket', 'lendingMarketAuthority', 'borrowReserve', 'borrowReserveLiquidityMint',
      'reserveSourceLiquidity', 'borrowReserveLiquidityFeeReceiver', 'userDestinationLiquidity', 'referrerTokenState', 'tokenProgram',
      'instructionSysvarAccount',
    ]],
  ['a1808ff5abc7c206', 'BorrowObligationLiquidityV2', [['liquidityAmount', 'u64']],
    [
      'owner', 'obligation', 'lendingMarket', 'lendingMarketAuthority', 'borrowReserve', 'borrowReserveLiquidityMint',
      'reserveSourceLiquidity', 'borrowReserveLiquidityFeeReceiver', 'userDestinationLiquidity', 'referrerTokenState', 'tokenProgram',
      'instructionSysvarAccount', 'obligationFarmUserState', 'reserveFarmState', 'farmsProgram',
    ]],
  ['91b20de14cf09348', 'RepayObligationLiquidity', [['liquidityAmount', 'u64']],
    [
      'owner', 'obligation', 'lendingMarket', 'repayReserve', 'reserveLiquidityMint', 'reserveDestinationLiquidity', 'userSourceLiquidity',
      'tokenProgram', 'instructionSysvarAccount',
    ]],
  ['74aed54cb435d290', 'RepayObligationLiquidityV2', [['liquidityAmount', 'u64']],
    [
      'owner', 'obligation', 'lendingMarket', 'repayReserve', 'reserveLiquidityMint', 'reserveDestinationLiquidity', 'userSourceLiquidity',
      'tokenProgram', 'instructionSysvarAccount', 'obligationFarmUserState', 'reserveFarmState', 'lendingMarketAuthority', 'farmsProgram',
    ]],
  ['0236980394606dda', 'RepayAndWithdrawAndRedeem', [['repayAmount', 'u64'], ['withdrawCollateralAmount', 'u64']],
    [
      'repayOwner', 'repayObligation', 'repayLendingMarket', 'repayReserve', 'repayReserveLiquidityMint', 'reserveDestinationLiquidity',
      'userSourceLiquidity', 'tokenProgram', 'repayInstructionSysvarAccount', 'withdrawOwner', 'withdrawObligation',
      'withdrawLendingMarket', 'lendingMarketAuthority', 'withdrawReserve', 'withdrawReserveLiquidityMint', 'reserveSourceCollateral',
      'reserveCollateralMint', 'reserveLiquiditySupply', 'userDestinationLiquidity', 'placeholderUserDestinationCollateral',
      'collateralTokenProgram', 'liquidityTokenProgram', 'withdrawInstructionSysvarAccount', 'collateralFarmsObligationFarmUserState',
      'collateralFarmsReserveFarmState', 'debtFarmsObligationFarmUserState', 'debtFarmsReserveFarmState', 'farmsProgram',
    ]],
  ['8d99270f403d5854', 'DepositAndWithdraw', [['liquidityAmount', 'u64'], ['withdrawCollateralAmount', 'u64']],
    [
      'depositOwner', 'depositObligation', 'depositLendingMarket', 'depositLendingMarketAuthority', 'reserve',
      'depositReserveLiquidityMint', 'depositReserveLiquiditySupply', 'depositReserveCollateralMint', 'reserveDestinationDepositCollateral',
      'userSourceLiquidity', 'depositPlaceholderUserDestinationCollateral', 'depositCollateralTokenProgram', 'depositLiquidityTokenProgram',
      'depositInstructionSysvarAccount', 'withdrawOwner', 'withdrawObligation', 'withdrawLendingMarket', 'withdrawLendingMarketAuthority',
      'withdrawReserve', 'withdrawReserveLiquidityMint', 'reserveSourceCollateral', 'withdrawReserveCollateralMint',
      'withdrawReserveLiquiditySupply', 'userDestinationLiquidity', 'withdrawPlaceholderUserDestinationCollateral',
      'withdrawCollateralTokenProgram', 'withdrawLiquidityTokenProgram', 'withdrawInstructionSysvarAccount',
      'depositFarmsObligationFarmUserState', 'depositFarmsReserveFarmState', 'withdrawFarmsObligationFarmUserState',
      'withdrawFarmsReserveFarmState', 'farmsProgram',
    ]],
  ['81c70402de271a2e', 'DepositReserveLiquidityAndObligationCollateral', [['liquidityAmount', 'u64']],
    [
      'owner', 'obligation', 'lendingMarket', 'lendingMarketAuthority', 'reserve', 'reserveLiquidityMint', 'reserveLiquiditySupply',
      'reserveCollateralMint', 'reserveDestinationDepositCollateral', 'userSourceLiquidity', 'placeholderUserDestinationCollateral',
      'collateralTokenProgram', 'liquidityTokenProgram', 'instructionSysvarAccount',
    ]],
  ['d8e0bf1bcc9766af', 'DepositReserveLiquidityAndObligationCollateralV2', [['liquidityAmount', 'u64']],
    [
      'owner', 'obligation', 'lendingMarket', 'lendingMarketAuthority', 'reserve', 'reserveLiquidityMint', 'reserveLiquiditySupply',
      'reserveCollateralMint', 'reserveDestinationDepositCollateral', 'userSourceLiquidity', 'placeholderUserDestinationCollateral',
      'collateralTokenProgram', 'liquidityTokenProgram', 'instructionSysvarAccount', 'obligationFarmUserState', 'reserveFarmState',
      'farmsProgram',
    ]],
  ['4b5d5ddc2296dac4', 'WithdrawObligationCollateralAndRedeemReserveCollateral', [['collateralAmount', 'u64']],
    [
      'owner', 'obligation', 'lendingMarket', 'lendingMarketAuthority', 'withdrawReserve', 'reserveLiquidityMint',
      'reserveSourceCollateral', 'reserveCollateralMint', 'reserveLiquiditySupply', 'userDestinationLiquidity',
      'placeholderUserDestinationCollateral', 'collateralTokenProgram', 'liquidityTokenProgram', 'instructionSysvarAccount',
    ]],
  ['eb34779895c51407', 'WithdrawObligationCollateralAndRedeemReserveCollateralV2', [['collateralAmount', 'u64']],
    [
      'owner', 'obligation', 'lendingMarket', 'lendingMarketAuthority', 'withdrawReserve', 'reserveLiquidityMint',
      'reserveSourceCollateral', 'reserveCollateralMint', 'reserveLiquiditySupply', 'userDestinationLiquidity',
      'placeholderUserDestinationCollateral', 'collateralTokenProgram', 'liquidityTokenProgram', 'instructionSysvarAccount',
      'obligationFarmUserState', 'reserveFarmState', 'farmsProgram',
    ]],
  ['b1479abce2854a37', 'LiquidateObligationAndRedeemReserveCollateral', [
    ['liquidityAmount', 'u64'], ['minReceivedLiquidityAmount', 'u64'], ['maxAllowedLtvOverridePercent', 'u64'],
  ],
    [
      'liquidator', 'obligation', 'lendingMarket', 'lendingMarketAuthority', 'repayReserve', 'repayReserveLiquidityMint',
      'repayReserveLiquiditySupply', 'withdrawReserve', 'withdrawReserveLiquidityMint', 'withdrawReserveCollateralMint',
      'withdrawReserveCollateralSupply', 'withdrawReserveLiquiditySupply', 'withdrawReserveLiquidityFeeReceiver', 'userSourceLiquidity',
      'userDestinationCollateral', 'userDestinationLiquidity', 'collateralTokenProgram', 'repayLiquidityTokenProgram',
      'withdrawLiquidityTokenProgram', 'instructionSysvarAccount',
    ]],
  ['a2a1238f1ebbb967', 'LiquidateObligationAndRedeemReserveCollateralV2', [
    ['liquidityAmount', 'u64'], ['minReceivedLiquidityAmount', 'u64'], ['maxAllowedLtvOverridePercent', 'u64'],
  ],
    [
      'liquidator', 'obligation', 'lendingMarket', 'lendingMarketAuthority', 'repayReserve', 'repayReserveLiquidityMint',
      'repayReserveLiquiditySupply', 'withdrawReserve', 'withdrawReserveLiquidityMint', 'withdrawReserveCollateralMint',
      'withdrawReserveCollateralSupply', 'withdrawReserveLiquiditySupply', 'withdrawReserveLiquidityFeeReceiver', 'userSourceLiquidity',
      'userDestinationCollateral', 'userDestinationLiquidity', 'collateralTokenProgram', 'repayLiquidityTokenProgram',
      'withdrawLiquidityTokenProgram', 'instructionSysvarAccount', 'collateralFarmsObligationFarmUserState',
      'collateralFarmsReserveFarmState', 'debtFarmsObligationFarmUserState', 'debtFarmsReserveFarmState', 'farmsProgram',
    ]],
  ['b97500cb60f5b4ba', 'FlashRepayReserveLiquidity', [['liquidityAmount', 'u64'], ['borrowInstructionIndex', 'u8']],
    [
      'userTransferAuthority', 'lendingMarketAuthority', 'lendingMarket', 'reserve', 'reserveLiquidityMint', 'reserveDestinationLiquidity',
      'userSourceLiquidity', 'reserveLiquidityFeeReceiver', 'referrerTokenState', 'referrerAccount', 'sysvarInfo', 'tokenProgram',
    ]],
  ['87e734a70734d4c1', 'FlashBorrowReserveLiquidity', [['liquidityAmount', 'u64']],
    [
      'userTransferAuthority', 'lendingMarketAuthority', 'lendingMarket', 'reserve', 'reserveLiquidityMint', 'reserveSourceLiquidity',
      'userDestinationLiquidity', 'reserveLiquidityFeeReceiver', 'referrerTokenState', 'referrerAccount', 'sysvarInfo', 'tokenProgram',
    ]],
  ['2477fb8122f00793', 'RequestElevationGroup', [['elevationGroup', 'u8']], ['owner', 'obligation', 'lendingMarket']],
  ['742d42943a0dda73', 'InitReferrerTokenState', [],
    ['payer', 'lendingMarket', 'reserve', 'referrer', 'referrerTokenState', 'rent', 'systemProgram']],
  ['75a9b045c5170fa2', 'InitUserMetadata', [['userLookupTable', 'pubkey']],
    ['owner', 'feePayer', 'userMetadata', 'referrerUserMetadata', 'rent', 'systemProgram']],
  ['ab7679c9e98c17e4', 'WithdrawReferrerFees', [],
    [
      'referrer', 'referrerTokenState', 'reserve', 'reserveLiquidityMint', 'reserveSupplyLiquidity', 'referrerTokenAccount',
      'lendingMarket', 'lendingMarketAuthority', 'tokenProgram',
    ]],
  ['a513197f64371f5a', 'InitReferrerStateAndShortUrl', [['shortUrl', 'string']],
    ['referrer', 'referrerState', 'referrerShortUrl', 'referrerUserMetadata', 'rent', 'systemProgram']],
  ['99b9631ce4b3bb96', 'DeleteReferrerStateAndShortUrl', [], ['referrer', 'referrerState', 'shortUrl', 'rent', 'systemProgram']],
  ['5101639cd3534e2e', 'SetObligationOrder', [['index', 'u8'], ['order', { def: 'ObligationOrder' }]],
    ['owner', 'obligation', 'lendingMarket']],
  ['b1ba2d3deb5b448b', 'SetBorrowOrder', [
    ['orderConfig', { def: 'BorrowOrderConfigArgs' }], ['minExpectedCurrentRemainingDebtAmount', 'u64'],
  ],
    [
      'owner', 'obligation', 'lendingMarket', 'reserve', 'filledDebtDestination', 'debtLiquidityMint', 'instructionSysvarAccount',
      'eventAuthority', 'program',
    ]],
  ['57ff1e049ce6a77e', 'SetBorrowOrderV2', [
    ['orderIdx', 'u8'], ['orderConfig', { def: 'BorrowOrderConfigArgs' }], ['minExpectedCurrentRemainingDebtAmount', 'u64'],
  ],
    [
      'owner', 'obligation', 'lendingMarket', 'reserve', 'filledDebtDestination', 'debtLiquidityMint', 'instructionSysvarAccount',
      'eventAuthority', 'program',
    ]],
  ['5298d545fa009dbc', 'UpdateObligationConfig', [['mode', { def: 'UpdateObligationConfigMode' }], ['value', 'bytes']],
    ['owner', 'obligation', 'borrowReserve', 'depositReserve', 'lendingMarket']],
  ['551e9be1e0ba8d94', 'RolloverFixedTermBorrow', [],
    [
      'payer', 'obligation', 'lendingMarket', 'lendingMarketAuthority', 'sourceBorrowReserve', 'targetBorrowReserve', 'liquidityMint',
      'sourceBorrowReserveLiquidity', 'targetBorrowReserveLiquidity', 'tokenProgram', 'sourceFarmsObligationFarmUserState',
      'sourceFarmsReserveFarmState', 'targetFarmsObligationFarmUserState', 'targetFarmsReserveFarmState', 'farmsProgram',
    ]],
  ['6604a74c83aa5d13', 'FillBorrowOrder', [],
    [
      'payer', 'obligation', 'lendingMarket', 'lendingMarketAuthority', 'borrowReserve', 'borrowReserveLiquidityMint',
      'reserveSourceLiquidity', 'borrowReserveLiquidityFeeReceiver', 'userDestinationLiquidity', 'referrerTokenState', 'tokenProgram',
      'instructionSysvarAccount', 'obligationFarmUserState', 'reserveFarmState', 'farmsProgram', 'eventAuthority', 'program',
    ]],
  ['c555c18b285ec28f', 'FillBorrowOrderV2', [['orderIdx', 'u8']],
    [
      'payer', 'obligation', 'lendingMarket', 'lendingMarketAuthority', 'borrowReserve', 'borrowReserveLiquidityMint',
      'reserveSourceLiquidity', 'borrowReserveLiquidityFeeReceiver', 'userDestinationLiquidity', 'referrerTokenState', 'tokenProgram',
      'instructionSysvarAccount', 'obligationFarmUserState', 'reserveFarmState', 'farmsProgram', 'eventAuthority', 'program',
    ]],
  ['7f2a51da93ab4c99', 'InitiateObligationOwnershipTransfer', [['newOwner', 'pubkey']],
    ['owner', 'obligation', 'instructionSysvarAccount']],
  ['3de3e72ec47c3ca1', 'ApproveObligationOwnershipTransfer', [],
    ['globalAdmin', 'globalConfig', 'obligation', 'pendingOwner', 'instructionSysvarAccount']],
  ['f98246b097bbef06', 'AcceptObligationOwnership', [], ['pendingOwner', 'obligation', 'instructionSysvarAccount']],
  ['67d95341a405c3e3', 'AbortObligationOwnershipTransfer', [], ['owner', 'obligation', 'instructionSysvarAccount']],
  ['8671a0cf5a4bd5db', 'EnqueueToWithdraw', [['collateralAmount', 'u64'], ['progressCallbackType', { def: 'ProgressCallbackType' }]],
    [
      'owner', 'lendingMarket', 'lendingMarketAuthority', 'reserve', 'userSourceCollateralTa', 'userDestinationLiquidityTa',
      'reserveLiquidityMint', 'reserveCollateralMint', 'collateralTokenProgram', 'withdrawTicket', 'ownerQueuedCollateralVault',
      'systemProgram', 'progressCallbackCustomAccount0', 'progressCallbackCustomAccount1', 'instructionSysvarAccount',
    ]],
  ['4295bbc94abfae78', 'WithdrawQueuedLiquidity', [],
    [
      'payer', 'lendingMarket', 'lendingMarketAuthority', 'reserve', 'reserveLiquidityMint', 'reserveCollateralMint',
      'reserveLiquiditySupply', 'ownerQueuedCollateralVault', 'userDestinationLiquidity', 'collateralTokenProgram', 'liquidityTokenProgram',
      'withdrawTicket', 'withdrawTicketOwner', 'associatedTokenProgram', 'systemProgram', 'progressCallbackProgram',
      'progressCallbackCustomAccount0', 'progressCallbackCustomAccount1', 'instructionSysvarAccount',
    ]],
  ['1c30b0669fced2f6', 'RecoverInvalidTicketCollateral', [['ticketSequenceNumber', 'u64']],
    [
      'payer', 'lendingMarket', 'lendingMarketAuthority', 'reserve', 'reserveCollateralMint', 'ownerQueuedCollateralVault',
      'userSourceCollateral', 'collateralTokenProgram', 'withdrawTicket', 'withdrawTicketOwner', 'instructionSysvarAccount',
    ]],
  ['b4537a2c78d32f16', 'CancelWithdrawTicket', [['ticketSequenceNumber', 'u64'], ['collateralAmountToCancel', 'u64']],
    [
      'owner', 'lendingMarket', 'lendingMarketAuthority', 'reserve', 'reserveCollateralMint', 'ownerQueuedCollateralVault',
      'userDestinationCollateral', 'collateralTokenProgram', 'withdrawTicket',
    ]],
  ['8c88d630570078ff', 'InitGlobalConfig', [],
    ['payer', 'globalConfig', 'programData', 'systemProgram', 'rent', 'instructionSysvarAccount']],
  ['a45482bd6f3afac8', 'UpdateGlobalConfig', [['mode', { def: 'UpdateGlobalConfigMode' }], ['value', 'bytes']],
    ['globalAdmin', 'globalConfig', 'instructionSysvarAccount']],
  ['b85717c19ceeaf77', 'UpdateGlobalConfigAdmin', [], ['pendingAdmin', 'globalConfig', 'instructionSysvarAccount']],
  ['8250269950d4b6fd', 'IdlMissingTypes', [
    ['reserveFarmKind', { def: 'ReserveFarmKind' }], ['feeCalculation', { def: 'FeeCalculation' }],
    ['reserveStatus', { def: 'ReserveStatus' }], ['updateConfigMode', { def: 'UpdateConfigMode' }],
    ['updateLendingMarketConfigValue', { def: 'UpdateLendingMarketConfigValue' }],
    ['updateLendingMarketConfigMode', { def: 'UpdateLendingMarketMode' }],
  ],
    ['signer', 'globalConfig', 'lendingMarket', 'reserve', 'instructionSysvarAccount']],
]

const EVENTS: readonly AnchorEvent[] = [
  ['58e4e7e6eaf84590', 'BorrowOrderCancelEvent', [['before', { def: 'BorrowOrder' }]]],
  ['b1f1edfa8f140eb7', 'BorrowOrderFullFillEvent', [['before', { def: 'BorrowOrder' }]]],
  ['7151fcc198186354', 'BorrowOrderPartialFillEvent', [['before', { def: 'BorrowOrder' }], ['after', { def: 'BorrowOrder' }]]],
  ['2bd3d0ba5ee3dac6', 'BorrowOrderPlaceEvent', [['after', { def: 'BorrowOrder' }]]],
  ['1521438330b85a40', 'BorrowOrderUpdateEvent', [['before', { def: 'BorrowOrder' }], ['after', { def: 'BorrowOrder' }]]],
]
// </anchor-tables>

/** Every instruction name of the Kamino Lend IDL, with its discriminator (hex). */
export const KAMINO_LEND_INSTRUCTIONS: ReadonlyArray<readonly [string, string]> = INSTRUCTIONS.map(([d, n]) => [d, n] as const)
/** Every event of the Kamino Lend IDL, with its discriminator (hex). */
export const KAMINO_LEND_EVENTS: ReadonlyArray<readonly [string, string]> = EVENTS.map(([d, n]) => [d, n] as const)

export const kaminoLendDecoder: InstructionDecoder = anchorDecoder({
  programAddress: KAMINO_LEND_PROGRAM,
  programName: 'Kamino Lend',
  instructions: INSTRUCTIONS,
  events: EVENTS,
  types: TYPES,
})
