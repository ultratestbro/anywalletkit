import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeInstruction, JUPITER_V6_PROGRAM, KAMINO_LEND_PROGRAM, type DecodedInstruction } from '../src/index.js'
import { KAMINO_LEND_EVENTS, KAMINO_LEND_INSTRUCTIONS } from '../src/decoders/kamino.js'
import { decodeFixture, fixtureBalanceChanges, loadFixture, type Fixture } from './helpers.js'

const sha8 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)
const snake = (name: string): string => name.replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase()
const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)))
const U64_MAX = 2n ** 64n - 1n

/** The Kamino Lend instruction at `index`, decoded. */
function klend(f: Fixture, index: number): DecodedInstruction {
  const ix = decodeFixture(f).instructions[index]!
  expect(ix.programAddress).toBe(KAMINO_LEND_PROGRAM)
  expect(ix.decoded).toBe(true)
  return ix
}

const account = (ix: DecodedInstruction, name: string): string | null => ix.accounts.find((a) => a.name === name)?.address ?? null
const names = (ix: DecodedInstruction): (string | null)[] => ix.accounts.map((a) => a.name)

function tokenDelta(f: Fixture, address: string | null): bigint | undefined {
  return fixtureBalanceChanges(f)?.tokens.find((t) => t.account === address)?.delta
}

const FARMS = ['obligationFarmUserState', 'reserveFarmState', 'farmsProgram']

describe('Kamino Lend discriminators', () => {
  it('all 66 instructions are sha256("global:<snake_case>")[0..8], events sha256("event:<Name>")[0..8]', () => {
    expect(KAMINO_LEND_INSTRUCTIONS).toHaveLength(66)
    for (const [disc, name] of KAMINO_LEND_INSTRUCTIONS) expect(disc, name).toBe(sha8(`global:${snake(name)}`))
    expect(new Set(KAMINO_LEND_INSTRUCTIONS.map(([d]) => d)).size).toBe(66)
    expect(KAMINO_LEND_EVENTS).toHaveLength(5)
    for (const [disc, name] of KAMINO_LEND_EVENTS) expect(disc, name).toBe(sha8(`event:${name}`))
  })

  it('agrees with the discriminators protocol-lending-kamino-solana allows', () => {
    const byName = Object.fromEntries(KAMINO_LEND_INSTRUCTIONS.map(([d, n]) => [n, d]))
    expect(byName).toMatchObject({
      InitUserMetadata: '75a9b045c5170fa2',
      InitObligation: 'fb0ae74c1b0b9f60',
      InitObligationFarmsForReserve: '883f0fbad398a8a4',
      RefreshObligationFarmsForReserve: '8c90fd150a4af803',
      RefreshReserve: '02da8aeb4fc91966',
      RefreshObligation: '218493e497c04859',
      DepositReserveLiquidityAndObligationCollateralV2: 'd8e0bf1bcc9766af',
      WithdrawObligationCollateralAndRedeemReserveCollateralV2: 'eb34779895c51407',
      BorrowObligationLiquidityV2: 'a1808ff5abc7c206',
      RepayObligationLiquidityV2: '74aed54cb435d290',
      DepositReserveLiquidity: 'a9c91e7e06cd6644',
      RedeemReserveCollateral: 'ea75b57db98edc1d',
      RequestElevationGroup: '2477fb8122f00793',
    })
  })
})

describe('Kamino Lend from mainnet', () => {
  it('a first deposit: user metadata (with the lookup table created next to it), obligation, farm, deposit', () => {
    const f = loadFixture('kamino/first-deposit.json')
    const tx = decodeFixture(f)
    const alt = tx.instructions[2]!
    expect(alt.name).toBe('CreateLookupTable')

    const meta = klend(f, 3)
    expect(meta.name).toBe('InitUserMetadata')
    expect(meta.args).toEqual({ userLookupTable: alt.accounts[0]!.address })
    expect(names(meta)).toEqual(['owner', 'feePayer', 'userMetadata', 'referrerUserMetadata', 'rent', 'systemProgram'])
    expect(account(meta, 'owner')).toBe(tx.feePayer)
    expect(account(meta, 'referrerUserMetadata')).toBe(KAMINO_LEND_PROGRAM) // no referrer: Anchor's None

    const obligation = klend(f, 4)
    expect(obligation).toMatchObject({ name: 'InitObligation', args: { args: { tag: 0, id: 0 } } })
    expect(account(obligation, 'ownerUserMetadata')).toBe(account(meta, 'userMetadata'))

    expect(klend(f, 5)).toMatchObject({ name: 'InitObligationFarmsForReserve', args: { mode: 0 } })
    expect(klend(f, 7).name).toBe('RefreshObligation')
    expect(klend(f, 8)).toMatchObject({ name: 'RefreshObligationFarmsForReserve', args: { mode: 0 } })
    expect(names(klend(f, 8))).toEqual(['crank', 'obligation', 'lendingMarketAuthority', 'reserve', 'reserveFarmState', 'obligationFarmUserState', 'lendingMarket', 'farmsProgram', 'rent', 'systemProgram'])

    const deposit = klend(f, 9)
    expect(deposit).toMatchObject({ name: 'DepositReserveLiquidityAndObligationCollateral', args: { liquidityAmount: 2000000n } })
    expect(names(deposit)).toEqual([
      'owner', 'obligation', 'lendingMarket', 'lendingMarketAuthority', 'reserve', 'reserveLiquidityMint', 'reserveLiquiditySupply',
      'reserveCollateralMint', 'reserveDestinationDepositCollateral', 'userSourceLiquidity', 'placeholderUserDestinationCollateral',
      'collateralTokenProgram', 'liquidityTokenProgram', 'instructionSysvarAccount',
    ])
    expect(account(deposit, 'obligation')).toBe(account(obligation, 'obligation'))
    expect(account(deposit, 'reserveLiquidityMint')).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
    expect(tokenDelta(f, account(deposit, 'userSourceLiquidity'))).toBe(-2000000n)
    expect(tokenDelta(f, account(deposit, 'reserveLiquiditySupply'))).toBe(2000000n)
  })

  it('a leveraged position: flash borrow, deposit V2, borrow V2, flash repay pointing back at the borrow', () => {
    const f = loadFixture('kamino/deposit-borrow-v2.json')
    const borrowFlash = klend(f, 3)
    expect(borrowFlash).toMatchObject({ name: 'FlashBorrowReserveLiquidity', args: { liquidityAmount: 446982121642n } })
    const repayFlash = klend(f, 13)
    expect(repayFlash).toMatchObject({ name: 'FlashRepayReserveLiquidity', args: { liquidityAmount: 446982121642n, borrowInstructionIndex: 3 } })
    expect(account(repayFlash, 'reserve')).toBe(account(borrowFlash, 'reserve'))
    expect(names(repayFlash)).toEqual([
      'userTransferAuthority', 'lendingMarketAuthority', 'lendingMarket', 'reserve', 'reserveLiquidityMint', 'reserveDestinationLiquidity',
      'userSourceLiquidity', 'reserveLiquidityFeeReceiver', 'referrerTokenState', 'referrerAccount', 'sysvarInfo', 'tokenProgram',
    ])

    const refresh = klend(f, 6)
    expect(refresh.name).toBe('RefreshObligation')
    expect(refresh.accounts.length).toBeGreaterThan(2)
    expect(names(refresh).slice(2).every((n) => n === null)).toBe(true) // the obligation's reserves

    const deposit = klend(f, 7)
    expect(deposit).toMatchObject({ name: 'DepositReserveLiquidityAndObligationCollateralV2', args: { liquidityAmount: 719084205178n } })
    expect(names(deposit).slice(-3)).toEqual(FARMS)
    expect(tokenDelta(f, account(deposit, 'reserveLiquiditySupply'))).toBe(719084205178n)

    const borrow = klend(f, 11)
    expect(borrow).toMatchObject({ name: 'BorrowObligationLiquidityV2', args: { liquidityAmount: 520277189n } })
    expect(names(borrow).slice(0, 15)).toEqual([
      'owner', 'obligation', 'lendingMarket', 'lendingMarketAuthority', 'borrowReserve', 'borrowReserveLiquidityMint',
      'reserveSourceLiquidity', 'borrowReserveLiquidityFeeReceiver', 'userDestinationLiquidity', 'referrerTokenState', 'tokenProgram',
      'instructionSysvarAccount', ...FARMS,
    ])
    // Remaining accounts past the IDL's list (the obligation's deposit reserves) stay unnamed.
    expect(names(borrow).slice(15)).toEqual([null])
    expect(tokenDelta(f, account(borrow, 'reserveSourceLiquidity'))).toBe(-520277189n)
    expect(account(borrow, 'obligation')).toBe(account(deposit, 'obligation'))
  })

  it('a repay of everything: u64::MAX as the amount, the actual debt leaves the user', () => {
    const f = loadFixture('kamino/repay-v2.json')
    const ix = klend(f, 3)
    expect(ix).toMatchObject({ name: 'RepayObligationLiquidityV2', args: { liquidityAmount: U64_MAX } })
    expect(names(ix)).toEqual([
      'owner', 'obligation', 'lendingMarket', 'repayReserve', 'reserveLiquidityMint', 'reserveDestinationLiquidity', 'userSourceLiquidity',
      'tokenProgram', 'instructionSysvarAccount', 'obligationFarmUserState', 'reserveFarmState', 'lendingMarketAuthority', 'farmsProgram',
    ])
    expect(tokenDelta(f, account(ix, 'userSourceLiquidity'))).toBe(-150436158n)
    expect(tokenDelta(f, account(ix, 'reserveDestinationLiquidity'))).toBe(150436158n)
  })

  it('a withdraw V2: collateral burned from the reserve, capped at what the obligation holds', () => {
    const f = loadFixture('kamino/withdraw-v2.json')
    const ix = klend(f, 8)
    expect(ix).toMatchObject({ name: 'WithdrawObligationCollateralAndRedeemReserveCollateralV2', args: { collateralAmount: 1724079798n } })
    expect(names(ix).slice(-3)).toEqual(FARMS)
    expect(account(ix, 'reserveLiquidityMint')).toBe('So11111111111111111111111111111111111111112')
    const burned = -tokenDelta(f, account(ix, 'reserveSourceCollateral'))!
    expect(burned).toBe(1724079797n)
    expect(burned <= 1724079798n).toBe(true)
  })

  it('a pre-farm withdraw wrapped in RefreshObligationFarmsForReserve calls', () => {
    const f = loadFixture('kamino/withdraw-farms-refresh.json')
    const ix = klend(f, 6)
    expect(ix).toMatchObject({ name: 'WithdrawObligationCollateralAndRedeemReserveCollateral', args: { collateralAmount: 16793861659n } })
    expect(tokenDelta(f, account(ix, 'reserveSourceCollateral'))).toBe(-16793861659n)
    expect(tokenDelta(f, account(ix, 'userDestinationLiquidity'))).toBe(20000000311n)
    for (const i of [5, 7, 8, 9]) expect(klend(f, i)).toMatchObject({ name: 'RefreshObligationFarmsForReserve', args: { mode: 0 } })
  })

  it('a flash loan pair in a v1 transaction', () => {
    const f = loadFixture('kamino/flash-loan.json')
    expect(decodeFixture(f).version).toBe(1)
    expect(klend(f, 0)).toMatchObject({ name: 'FlashBorrowReserveLiquidity', args: { liquidityAmount: 88080184n } })
    expect(klend(f, 2)).toMatchObject({ name: 'FlashRepayReserveLiquidity', args: { liquidityAmount: 88080184n, borrowInstructionIndex: 0 } })
    expect(account(klend(f, 2), 'reserve')).toBe(account(klend(f, 0), 'reserve'))
  })

  it('a liquidation V2 funded by a flash loan and swapped through Jupiter', () => {
    const f = loadFixture('kamino/liquidate-v2.json')
    const ix = klend(f, 8)
    expect(ix).toMatchObject({
      name: 'LiquidateObligationAndRedeemReserveCollateralV2',
      args: { liquidityAmount: 21283940n, minReceivedLiquidityAmount: 7795806n, maxAllowedLtvOverridePercent: 0n },
    })
    expect(names(ix).slice(0, 25)).toEqual([
      'liquidator', 'obligation', 'lendingMarket', 'lendingMarketAuthority', 'repayReserve', 'repayReserveLiquidityMint',
      'repayReserveLiquiditySupply', 'withdrawReserve', 'withdrawReserveLiquidityMint', 'withdrawReserveCollateralMint',
      'withdrawReserveCollateralSupply', 'withdrawReserveLiquiditySupply', 'withdrawReserveLiquidityFeeReceiver', 'userSourceLiquidity',
      'userDestinationCollateral', 'userDestinationLiquidity', 'collateralTokenProgram', 'repayLiquidityTokenProgram',
      'withdrawLiquidityTokenProgram', 'instructionSysvarAccount', 'collateralFarmsObligationFarmUserState', 'collateralFarmsReserveFarmState',
      'debtFarmsObligationFarmUserState', 'debtFarmsReserveFarmState', 'farmsProgram',
    ])
    expect(names(ix).slice(25)).toEqual([null, null, null])
    expect(account(ix, 'liquidator')).toBe(decodeFixture(f).feePayer)
    expect(tokenDelta(f, account(ix, 'repayReserveLiquiditySupply'))).toBe(21283940n)
    expect(klend(f, 3).args).toEqual({ liquidityAmount: 21283940n })
    expect(klend(f, 12).args).toEqual({ liquidityAmount: 21283940n, borrowInstructionIndex: 3 })
    const swap = decodeFixture(f).instructions[11]!
    expect(swap).toMatchObject({ programAddress: JUPITER_V6_PROGRAM, name: 'Route', decoded: true })
  })

  it('DepositReserveLiquidity and RedeemReserveCollateral: kTokens without an obligation', () => {
    const f = loadFixture('kamino/deposit-reserve-liquidity.json')
    const deposit = klend(f, 4)
    expect(deposit).toMatchObject({ name: 'DepositReserveLiquidity', args: { liquidityAmount: 1000000000n } })
    expect(tokenDelta(f, account(deposit, 'userSourceLiquidity'))).toBe(-1000000000n)
    expect(tokenDelta(f, account(deposit, 'userDestinationCollateral'))).toBe(935678951n)

    const g = loadFixture('kamino/redeem-reserve-collateral.json')
    const redeem = klend(g, 3)
    expect(redeem).toMatchObject({ name: 'RedeemReserveCollateral', args: { collateralAmount: 861243522n } })
    expect(names(redeem)).toEqual([
      'owner', 'lendingMarket', 'reserve', 'lendingMarketAuthority', 'reserveLiquidityMint', 'reserveCollateralMint', 'reserveLiquiditySupply',
      'userSourceCollateral', 'userDestinationLiquidity', 'collateralTokenProgram', 'liquidityTokenProgram', 'instructionSysvarAccount',
    ])
    expect(tokenDelta(g, account(redeem, 'userSourceCollateral'))).toBe(-861243522n)
  })

  it('RefreshReserve: optional oracles the reserve does not use hold the program id', () => {
    const ix = klend(loadFixture('kamino/deposit-borrow-v2.json'), 4)
    expect(ix.name).toBe('RefreshReserve')
    expect(names(ix)).toEqual(['reserve', 'lendingMarket', 'pythOracle', 'switchboardPriceOracle', 'switchboardTwapOracle', 'scopePrices'])
    expect(account(ix, 'pythOracle')).toBe(KAMINO_LEND_PROGRAM)
  })
})

describe('Kamino Lend argument layouts beyond the fixtures', () => {
  const raw = (hex: string) => ({ programAddress: KAMINO_LEND_PROGRAM, accounts: [], data: fromHex(hex) })
  const disc = (name: string) => KAMINO_LEND_INSTRUCTIONS.find(([, n]) => n === name)![0]

  it('enums, byte vectors, strings and structs decode from the IDL', () => {
    // UpdateReserveConfig(mode = UpdateLoanToValuePct, value = [0x05], skipConfigIntegrityValidation = true)
    expect(decodeInstruction(raw(`${disc('UpdateReserveConfig')}00` + '0100000005' + '01'), 0)).toMatchObject({
      name: 'UpdateReserveConfig', args: { mode: 'UpdateLoanToValuePct', value: 'BQ==', skipConfigIntegrityValidation: true },
    })
    // InitReferrerStateAndShortUrl("abc")
    expect(decodeInstruction(raw(`${disc('InitReferrerStateAndShortUrl')}03000000616263`), 0).args).toEqual({ shortUrl: 'abc' })
    // SetBorrowOrderV2(orderIdx 1, BorrowOrderConfigArgs, minExpectedCurrentRemainingDebtAmount)
    const u64 = (n: bigint) => n.toString(16).padStart(16, '0').match(/../g)!.reverse().join('')
    const u32 = (n: number) => n.toString(16).padStart(8, '0').match(/../g)!.reverse().join('')
    const order = decodeInstruction(raw(`${disc('SetBorrowOrderV2')}01${u64(5000000n)}${u32(900)}${u64(86400n)}${u64(1900000000n)}01${u64(7n)}`), 0)
    expect(order.args).toEqual({
      orderIdx: 1,
      orderConfig: { remainingDebtAmount: 5000000n, maxBorrowRateBps: 900, minDebtTermSeconds: 86400n, fillableUntilTimestamp: 1900000000n, enableAutoRolloverOnFilledBorrows: true },
      minExpectedCurrentRemainingDebtAmount: 7n,
    })
    expect(decodeInstruction(raw(`${disc('RequestElevationGroup')}02`), 0).args).toEqual({ elevationGroup: 2 })
  })

  it('an enum value newer than the IDL is reported, not guessed; truncated data is an error; unknown data is undecoded', () => {
    const newer = decodeInstruction(raw(`${disc('UpdateReserveConfig')}c8` + '0100000005' + '01'), 0)
    expect(newer).toMatchObject({ decoded: true, name: 'UpdateReserveConfig', args: { mode: null, value: null, skipConfigIntegrityValidation: null } })
    expect(newer.partial).toMatch(/UpdateConfigMode variant 200 is not in the IDL/)

    const cut = decodeInstruction(raw(`${disc('DepositReserveLiquidityAndObligationCollateralV2')}e803`), 0)
    expect(cut).toMatchObject({ decoded: false, name: null, programName: 'Kamino Lend' })
    expect(cut.error).toBeTruthy()
    expect(decodeInstruction(raw('ffffffffffffffff00'), 0)).toMatchObject({ decoded: false, name: null })
    expect(decodeInstruction(raw('02da8a'), 0)).toMatchObject({ decoded: false, name: null })
  })
})
