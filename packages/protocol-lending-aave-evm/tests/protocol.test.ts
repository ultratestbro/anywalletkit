import { describe, expect, it } from 'vitest'
import { decodeFunctionData, maxUint256, toFunctionSelector, type Hex } from 'viem'
import { ReadOnlyAccountError } from '@anywalletkit/core'
import { createMockAccount } from '@anywalletkit/conformance'
import { AaveProtocolEvm, AaveError, decodeAaveRevert, parseReserveConfiguration, rayToApyPct, userFlags, healthFactorToNumber, AAVE_MARKETS, listMarkets } from '../src/index.js'
import { GATEWAY_ABI, POOL_ABI, ERC20_ABI, VARIABLE_DEBT_ABI } from '../src/abi.js'
import {
  A_USDT, A_WETH, E18, E6, E8, GATEWAY, OTHER, POOL, RAY, USDT, USER, V_USDT, V_WETH, WETH,
  account, buildConfiguration, makeMarket, permitAccount, setAllowance, setBalance, setDelegation,
} from './fixture.js'

const decodeSent = (tx: unknown) => {
  const t = tx as { to: string; data: Hex; value: bigint }
  const abi = t.to === POOL ? POOL_ABI : t.to === GATEWAY ? GATEWAY_ABI : [...ERC20_ABI, ...VARIABLE_DEBT_ABI]
  const { functionName, args } = decodeFunctionData({ abi, data: t.data })
  return { to: t.to, fn: functionName, args: args as readonly unknown[], value: t.value }
}

const make = (opts: { acc?: ReturnType<typeof account> } = {}) => {
  const { chain, state } = makeMarket()
  const acc = opts.acc ?? account()
  // reserveTtlMs 0: the tests mutate reserve flags between calls
  const p = new AaveProtocolEvm(acc, { chainId: 1, provider: chain.provider, reserveTtlMs: 0 })
  return { chain, state, acc, p }
}

describe('presets & construction', () => {
  it('ships every live market from the address book, each with a distinct addresses provider per chain', () => {
    const all = listMarkets()
    expect(all.length).toBeGreaterThanOrEqual(20)
    expect(AAVE_MARKETS[1]!.core!.pool).toBe('0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2')
    expect(AAVE_MARKETS[42161]!.core!.addressesProvider).toBe(AAVE_MARKETS[10]!.core!.addressesProvider) // same deployer → same address on OP/ARB/POL/AVAX
    expect(AAVE_MARKETS[42220]!.core!.wethGateway).toBeUndefined()
  })

  it('refuses an unknown market / chain and an account on another chain', () => {
    expect(() => new AaveProtocolEvm(account(), { chainId: 1, market: 'nope' })).toThrow(/Unknown Aave market 'nope'/)
    expect(() => new AaveProtocolEvm(createMockAccount({ chain: 'eip155:999' }), {})).toThrow(/No known Aave v3 market on chain 999/)
    expect(() => new AaveProtocolEvm(account(), { chainId: 10 })).toThrow(/account is on eip155:1/)
  })

  it('reads the Pool from the addresses provider and refuses when the preset disagrees', async () => {
    const { chain, state } = makeMarket({ poolAddress: OTHER })
    const p = new AaveProtocolEvm(account(), { chainId: 1, provider: chain.provider })
    await expect(p.getMarket()).rejects.toThrow(/Pool mismatch/)
    state.poolAddress = POOL
    const m = await p.getMarket()
    expect(m).toMatchObject({ pool: POOL, baseCurrencyUnit: E8, wrappedNative: WETH, wethGateway: GATEWAY, name: 'Aave V3 Ethereum' })
  })

  it('works without a provider until a read is needed', async () => {
    const p = new AaveProtocolEvm(account(), { chainId: 1 })
    await expect(p.getMarket()).rejects.toThrow(/provider/)
  })
})

describe('reserve parsing & maths', () => {
  it('decodes the configuration bitmap', () => {
    const data = buildConfiguration({ ltv: 7500, liquidationThreshold: 7800, liquidationBonus: 10450, decimals: 6, frozen: true, borrowCap: 1_000_000n, supplyCap: 2_000_000n, reserveFactor: 1000 })
    expect(parseReserveConfiguration(data)).toMatchObject({
      ltv: 0.75, liquidationThreshold: 0.78, liquidationBonus: 0.045, decimals: 6, active: true, frozen: true, borrowingEnabled: true, paused: false,
      reserveFactor: 0.1, borrowCap: 1_000_000n, supplyCap: 2_000_000n,
    })
  })

  it('APY compounds the ray rate per second; health factor max → Infinity', () => {
    expect(rayToApyPct(RAY * 4n / 100n)).toBeCloseTo(4.081, 2)
    expect(healthFactorToNumber(maxUint256)).toBe(Number.POSITIVE_INFINITY)
    expect(healthFactorToNumber(15n * 10n ** 17n)).toBe(1.5)
    expect(userFlags(0b1101n, 0)).toEqual({ borrowing: true, collateral: false })
    expect(userFlags(0b1101n, 1)).toEqual({ borrowing: true, collateral: true })
  })

  it('lists reserves with rates, symbols and token addresses (through Multicall3)', async () => {
    const { p, chain } = make()
    const list = await p.getReserves()
    expect(list.map((r) => r.symbol)).toEqual(['USDT', 'WETH'])
    expect(list[0]).toMatchObject({ asset: USDT, aToken: A_USDT, variableDebtToken: V_USDT, decimals: 6, supplyApr: 4, borrowApr: 6 })
    expect(chain.of('getReserveData')).toHaveLength(2)
    expect(await p.getSupplyApy(WETH)).toBeCloseTo(2.02, 2)
    await expect(p.getReserve(OTHER)).rejects.toThrow(/not listed/)
  })
})

describe('supply', () => {
  it('ERC-20 without allowance: exact approve, wait, then Pool.supply to the account', async () => {
    const { p, acc } = make()
    const res = await p.supply({ token: USDT, amount: 5n * E6 })
    expect(acc.sent).toHaveLength(2)
    expect(decodeSent(acc.sent[0])).toMatchObject({ to: USDT, fn: 'approve', args: [POOL, 5n * E6] })
    expect(decodeSent(acc.sent[1])).toMatchObject({ to: POOL, fn: 'supply', args: [USDT, 5n * E6, USER, 0] })
    expect(res.approveHashes).toHaveLength(1)
    expect(res.fee).toBe(42_000n)
  })

  it("Ethereum USDT's non-zero → non-zero approve gets a reset to zero first", async () => {
    const { p, acc, state } = make()
    setAllowance(state, USDT, USER, POOL, 1n)
    await p.supply({ token: USDT, amount: 5n * E6 })
    expect(acc.sent.map((t) => decodeSent(t).fn)).toEqual(['approve', 'approve', 'supply'])
    expect(decodeSent(acc.sent[0]).args).toEqual([POOL, 0n])
  })

  it('enough allowance: a single supply, onBehalfOf forwarded', async () => {
    const { p, acc, state } = make()
    setAllowance(state, USDT, USER, POOL, 10n * E6)
    await p.supply({ token: USDT, amount: 5n * E6, onBehalfOf: OTHER })
    expect(acc.sent).toHaveLength(1)
    expect(decodeSent(acc.sent[0])).toMatchObject({ fn: 'supply', args: [USDT, 5n * E6, OTHER, 0] })
  })

  it('EIP-2612 token + signing account: one supplyWithPermit, no approval', async () => {
    const acc = permitAccount()
    const { p } = make({ acc })
    const res = await p.supply({ token: USDT, amount: 5n * E6 })
    expect(acc.sent).toHaveLength(1)
    const d = decodeSent(acc.sent[0])
    expect(d.fn).toBe('supplyWithPermit')
    expect(d.args.slice(0, 4)).toEqual([USDT, 5n * E6, USER, 0])
    expect(acc.permits).toHaveLength(1)
    expect((acc.permits[0] as { spender: string }).spender).toBe(POOL)
    expect(res.permit).toBe(true)
    const q = await p.quoteSupply({ token: USDT, amount: 5n * E6 })
    expect(q).toMatchObject({ permit: true, approvals: 0 })
  })

  it('token without permit support falls back to approve', async () => {
    const acc = permitAccount(false)
    const { p } = make({ acc })
    await p.supply({ token: USDT, amount: 5n * E6 })
    expect(acc.sent.map((t) => decodeSent(t).fn)).toEqual(['approve', 'supply'])
    expect(acc.permits).toHaveLength(0)
  })

  it('native: WrappedTokenGateway.depositETH with the value', async () => {
    const { p, acc } = make()
    await p.supply({ token: 'native', amount: E18 })
    expect(acc.sent).toHaveLength(1)
    expect(decodeSent(acc.sent[0])).toMatchObject({ to: GATEWAY, fn: 'depositETH', args: [POOL, USER, 0], value: E18 })
  })

  it('native without a gateway on the market refuses', async () => {
    const { chain } = makeMarket()
    const p = new AaveProtocolEvm(account(), { chainId: 1, provider: chain.provider, wethGateway: null })
    await expect(p.supply({ token: 'native', amount: 1n })).rejects.toThrow(/no WrappedTokenGateway/)
  })

  it('refuses a frozen / paused reserve and a reached supply cap before sending', async () => {
    const { p, acc, state } = make()
    state.reserves[USDT]!.frozen = true
    await expect(p.supply({ token: USDT, amount: E6 })).rejects.toThrow(/frozen/)
    state.reserves[USDT]!.frozen = false
    state.reserves[USDT]!.paused = true
    await expect(p.supply({ token: USDT, amount: E6 })).rejects.toThrow(/paused/)
    state.reserves[USDT]!.paused = false
    state.reserves[USDT]!.supplyCap = 500_001n
    await expect(p.supply({ token: USDT, amount: 2n * E6 })).rejects.toThrow(/supply cap/)
    expect(acc.sent).toHaveLength(0)
  })

  it('rejects zero / non-integer amounts', async () => {
    const { p } = make()
    await expect(p.supply({ token: USDT, amount: 0n })).rejects.toThrow(/greater than zero/)
    await expect(p.supply({ token: USDT, amount: 1.5 })).rejects.toThrow(/bigint or a safe integer/)
  })
})

describe('withdraw', () => {
  it("'max' sends uint256.max; an amount above the aToken balance refuses", async () => {
    const { p, acc, state } = make()
    setBalance(state, A_USDT, USER, 7n * E6)
    const res = await p.withdraw({ token: USDT, amount: 'max' })
    expect(decodeSent(acc.sent[0])).toMatchObject({ fn: 'withdraw', args: [USDT, maxUint256, USER] })
    expect(res.amount).toBe(7n * E6)
    await expect(p.withdraw({ token: USDT, amount: 8n * E6 })).rejects.toThrow(/exceeds the supplied balance/)
    await p.withdraw({ token: USDT, amount: 2n * E6, to: OTHER })
    expect(decodeSent(acc.sent[1]).args).toEqual([USDT, 2n * E6, OTHER])
  })

  it('nothing supplied refuses', async () => {
    const { p } = make()
    await expect(p.withdraw({ token: USDT, amount: 1n })).rejects.toThrow(/nothing supplied/)
  })

  it('native: approve aWETH to the gateway, then withdrawETH', async () => {
    const { p, acc, state } = make()
    setBalance(state, A_WETH, USER, 2n * E18)
    await p.withdraw({ token: 'native', amount: E18 })
    expect(acc.sent.map((t) => decodeSent(t))).toMatchObject([
      { to: A_WETH, fn: 'approve', args: [GATEWAY, E18] },
      { to: GATEWAY, fn: 'withdrawETH', args: [POOL, E18, USER] },
    ])
  })

  it("Aave's revert is translated — numeric code (≤3.3) and custom error (3.4+)", async () => {
    const { p, state } = make()
    setBalance(state, A_USDT, USER, 7n * E6)
    state.revertOn.set('withdraw', 'HealthFactorLowerThanLiquidationThreshold')
    await expect(p.withdraw({ token: USDT, amount: E6 })).rejects.toThrow(/Health factor would fall below the liquidation threshold \(Aave error 35\)/)
    state.dialect = 'custom'
    const e = await p.quoteWithdraw({ token: USDT, amount: E6 }).catch((x) => x)
    expect(e).toBeInstanceOf(AaveError)
    expect(e.code).toBe('HealthFactorLowerThanLiquidationThreshold')
  })
})

describe('borrow', () => {
  const funded = () => {
    const ctx = make()
    ctx.state.account = { collateral: 10_000n * E8, debt: 0n, available: 7_500n * E8, lt: 7800n, ltv: 7500n, hf: maxUint256 }
    return ctx
  }

  it('variable rate, within the borrowing power', async () => {
    const { p, acc } = funded()
    await p.borrow({ token: USDT, amount: 1_000n * E6 })
    expect(decodeSent(acc.sent[0])).toMatchObject({ to: POOL, fn: 'borrow', args: [USDT, 1_000n * E6, 2n, 0, USER] })
    const q = await p.quoteBorrow({ token: WETH, amount: E18 })
    expect(q.borrowApy).toBeCloseTo(3.045, 2)
  })

  it('refuses beyond the borrowing power, without collateral, and when borrowing is disabled', async () => {
    const { p, acc, state } = funded()
    await expect(p.borrow({ token: USDT, amount: 8_000n * E6 })).rejects.toThrow(/Borrowing power exceeded/)
    await expect(p.borrow({ token: WETH, amount: 3n * E18 })).rejects.toThrow(/Borrowing power exceeded/) // 9000 USD > 7500
    state.reserves[USDT]!.borrowingEnabled = false
    await expect(p.borrow({ token: USDT, amount: E6 })).rejects.toThrow(/borrowing is not enabled/)
    state.reserves[USDT]!.borrowingEnabled = true
    state.account.collateral = 0n
    await expect(p.borrow({ token: USDT, amount: E6 })).rejects.toThrow(/No collateral/)
    expect(acc.sent).toHaveLength(0)
  })

  it('borrow cap and credit delegation are checked', async () => {
    const { p, state } = funded()
    state.reserves[USDT]!.borrowCap = 300_500n
    await expect(p.borrow({ token: USDT, amount: 1_000n * E6 })).rejects.toThrow(/borrow cap/)
    state.reserves[USDT]!.borrowCap = 0n
    await expect(p.borrow({ token: USDT, amount: E6, onBehalfOf: OTHER })).rejects.toThrow(/delegated 0/)
    setDelegation(state, V_USDT, OTHER, USER, 2n * E6)
    await expect(p.borrow({ token: USDT, amount: E6, onBehalfOf: OTHER })).resolves.toMatchObject({ approveHashes: [] })
  })

  it('native: approveDelegation on the WETH debt token, then borrowETH', async () => {
    const { p, acc } = funded()
    await p.borrow({ token: 'native', amount: E18 })
    expect(acc.sent.map((t) => decodeSent(t))).toMatchObject([
      { to: V_WETH, fn: 'approveDelegation', args: [GATEWAY, E18] },
      { to: GATEWAY, fn: 'borrowETH', args: [POOL, E18, 0] },
    ])
  })
})

describe('repay', () => {
  it("no debt refuses; 'max' approves debt + 0.1 % and repays uint256.max", async () => {
    const { p, acc, state } = make()
    await expect(p.repay({ token: USDT, amount: 'max' })).rejects.toThrow(/no variable debt/)
    setBalance(state, V_USDT, USER, 1_000n * E6)
    const res = await p.repay({ token: USDT, amount: 'max' })
    expect(acc.sent.map((t) => decodeSent(t))).toMatchObject([
      { to: USDT, fn: 'approve', args: [POOL, 1_001n * E6 + 1n] },
      { to: POOL, fn: 'repay', args: [USDT, maxUint256, 2n, USER] },
    ])
    expect(res.debt).toBe(1_000n * E6)
  })

  it("'max' on behalf of someone else passes the exact debt (Aave forbids max there)", async () => {
    const { p, acc, state } = make()
    setBalance(state, V_USDT, OTHER, 50n * E6)
    await p.repay({ token: USDT, amount: 'max', onBehalfOf: OTHER })
    expect(decodeSent(acc.sent[1]).args).toEqual([USDT, 50n * E6, 2n, OTHER])
  })

  it('partial repay approves exactly the amount; permit road gives one repayWithPermit', async () => {
    const { p, acc, state } = make()
    setBalance(state, V_USDT, USER, 1_000n * E6)
    await p.repay({ token: USDT, amount: 100n * E6 })
    expect(decodeSent(acc.sent[0]).args).toEqual([POOL, 100n * E6])
    const pa = permitAccount()
    const ctx = make({ acc: pa })
    setBalance(ctx.state, V_USDT, USER, 1_000n * E6)
    await ctx.p.repay({ token: USDT, amount: 100n * E6 })
    expect(pa.sent).toHaveLength(1)
    expect(decodeSent(pa.sent[0]).fn).toBe('repayWithPermit')
  })

  it('native: repayETH carries the value (debt + buffer for max; the gateway refunds the rest)', async () => {
    const { p, acc, state } = make()
    setBalance(state, V_WETH, USER, E18)
    await p.repay({ token: 'native', amount: 'max' })
    expect(decodeSent(acc.sent[0])).toMatchObject({ to: GATEWAY, fn: 'repayETH', args: [POOL, maxUint256, USER], value: E18 + E18 / 1000n + 1n })
  })

  it('withATokens burns aTokens, needs enough of them, no approval', async () => {
    const { p, acc, state } = make()
    setBalance(state, V_USDT, USER, 100n * E6)
    await expect(p.repay({ token: USDT, amount: 100n * E6, withATokens: true })).rejects.toThrow(/aTokens held/)
    setBalance(state, A_USDT, USER, 200n * E6)
    await p.repay({ token: USDT, amount: 'max', withATokens: true })
    expect(acc.sent).toHaveLength(1)
    expect(decodeSent(acc.sent[0])).toMatchObject({ fn: 'repayWithATokens', args: [USDT, maxUint256, 2n] })
  })
})

describe('position, collateral, read-only', () => {
  it('getPosition lists supplies with the collateral flag and borrows', async () => {
    const { p, state } = make()
    setBalance(state, A_USDT, USER, 100n * E6)
    setBalance(state, V_WETH, USER, E18 / 10n)
    state.userConfig = 0b0110n // reserve 0 (USDT): collateral; reserve 1 (WETH): borrowing
    state.account = { collateral: 100n * E8, debt: 300n * E8, available: 0n, lt: 7800n, ltv: 7500n, hf: 26n * 10n ** 17n }
    const pos = await p.getPosition()
    expect(pos.supplies).toMatchObject([{ token: USDT, symbol: 'USDT', amount: 100n * E6, collateral: true }])
    expect(pos.borrows).toMatchObject([{ token: WETH, amount: E18 / 10n }])
    expect(pos.account.healthFactor).toBe(2.6)
    expect(pos.account.ltv).toBe(0.75)
  })

  it('setCollateral encodes the switch and refuses zero-LTV assets', async () => {
    const { p, acc, state } = make()
    await p.setCollateral({ token: USDT, enabled: false })
    expect(decodeSent(acc.sent[0])).toMatchObject({ fn: 'setUserUseReserveAsCollateral', args: [USDT, false] })
    state.reserves[USDT]!.ltv = 0
    await expect(p.setCollateral({ token: USDT, enabled: true })).rejects.toThrow(/zero LTV/)
  })

  it('quotes never send and sum the fee of every leg; read-only accounts cannot write', async () => {
    const { p, acc, state } = make()
    setBalance(state, A_USDT, USER, 7n * E6)
    setBalance(state, V_USDT, USER, 7n * E6)
    state.account = { collateral: 10_000n * E8, debt: 0n, available: 7_500n * E8, lt: 7800n, ltv: 7500n, hf: maxUint256 }
    expect(await p.quoteSupply({ token: USDT, amount: E6 })).toMatchObject({ fee: 42_000n, approvals: 1, supplyApy: expect.any(Number) })
    expect(await p.quoteWithdraw({ token: USDT, amount: 'max' })).toMatchObject({ fee: 21_000n, amount: 7n * E6 })
    expect(await p.quoteBorrow({ token: USDT, amount: E6 })).toMatchObject({ fee: 21_000n })
    expect(await p.quoteRepay({ token: USDT, amount: E6 })).toMatchObject({ fee: 42_000n, debt: 7n * E6 })
    expect(acc.sent).toHaveLength(0)
    const ro = new AaveProtocolEvm(acc.toReadOnlyAccount(), { chainId: 1, provider: makeMarket().chain.provider })
    await expect(ro.supply({ token: USDT, amount: E6 })).rejects.toBeInstanceOf(ReadOnlyAccountError)
    expect(await ro.getSupplyApy(USDT)).toBeCloseTo(4.08, 1)
  })
})

describe('revert decoding', () => {
  it('maps numeric codes, custom errors and unknown selectors', () => {
    expect(decodeAaveRevert('0x08c379a0' + '0000000000000000000000000000000000000000000000000000000000000020' + '0000000000000000000000000000000000000000000000000000000000000002' + '3335000000000000000000000000000000000000000000000000000000000000' as Hex))
      .toEqual({ message: 'Health factor would fall below the liquidation threshold (Aave error 35)', code: '35' })
    expect(decodeAaveRevert(toFunctionSelector('SupplyCapExceeded()'))).toEqual({ message: 'Supply cap is exceeded (Aave error SupplyCapExceeded)', code: 'SupplyCapExceeded' })
    expect(decodeAaveRevert('0xdeadbeef')).toEqual({ message: 'reverted with custom error 0xdeadbeef' })
  })
})
describe('round 3: max with permit / native max withdraw', () => {
  // Audit 2026-10-25 round 3, M20: withdraw('max') through the WETH gateway approved exactly the aWETH held at planning; the
  // gateway pulls the balance at execution, which interest has grown, and transferFrom fails.
  it("native withdraw('max') approves the held aWETH plus 0.1 % headroom", async () => {
    const { p, acc, state } = make()
    setBalance(state, A_WETH, USER, 2n * E18)
    await p.withdraw({ token: 'native', amount: 'max' })
    expect(decodeSent(acc.sent[0])).toMatchObject({ to: A_WETH, fn: 'approve', args: [GATEWAY, 2n * E18 + (2n * E18) / 1000n + 1n] })
  })
})
