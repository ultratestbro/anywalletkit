import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotImplementedError } from '@anywalletkit/core'
import { decodeFunctionData, encodeFunctionData, parseAbi, toFunctionSelector, type Hex } from 'viem'
import { CurveLendingError, ScrvUsdProtocolEvm, ScrvUsdVerificationError, VaultShutdownError, eip1167Code } from '../src/index.js'
import { ERC20_ABI, VAULT_V3_ABI } from '../src/abi.js'
import { account, CRVUSD, E18, IMPL, IMPL_CODE, makeScrvUsd, OTHER, ROLE_MANAGER, setAllowance, setShares, USER, VAULT } from './fixture.js'

const make = (overrides = {}, config: Record<string, unknown> = {}) => {
  const { chain, state } = makeScrvUsd(overrides)
  const acct = account()
  const p = new ScrvUsdProtocolEvm(acct, { provider: chain.provider, api: null, ...config })
  return { chain, state, acct, p }
}
const decode = (data: unknown) => decodeFunctionData({ abi: [...VAULT_V3_ABI, ...ERC20_ABI], data: data as Hex })
const sent = (acct: ReturnType<typeof account>) => acct.sent as Array<{ to: string; data: Hex; value: bigint }>

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('identity checks', () => {
  it('passes on the real clone + implementation code, apiVersion 3.0.4 and crvUSD', async () => {
    const { p } = make()
    const v = await p.getVault()
    expect(v).toMatchObject({ vault: VAULT, implementation: IMPL, apiVersion: '3.0.4', asset: { address: CRVUSD, symbol: 'crvUSD', decimals: 18 }, isShutdown: false, totalDebt: 0n, roleManager: ROLE_MANAGER, profitMaxUnlockTime: 604_800n })
    expect(v.totalIdle).toBe(v.totalAssets)
    expect(v.pricePerShare).toBe(1_111_893_746_570_523_025n) // the live 2026-11-05 figure
  })

  it('refuses a vault whose code is a clone of another implementation', async () => {
    const { chain, p, acct } = make()
    chain.codes.set(VAULT.toLowerCase(), eip1167Code(OTHER))
    const e = await p.supply({ amount: E18 }).catch((x) => x)
    expect(e).toBeInstanceOf(ScrvUsdVerificationError)
    expect(e).toMatchObject({ check: 'clone', code: 'ScrvUsdVerificationFailed' })
    expect(acct.sent).toHaveLength(0)
  })

  it('refuses a vault with no code at all', async () => {
    const { chain, p } = make()
    chain.codes.delete(VAULT.toLowerCase())
    await expect(p.getVault()).rejects.toMatchObject({ check: 'clone', observed: 'no code' })
  })

  // A real node answers an eth_call to an address without code with no data, so the vault's views
  // cannot be decoded there: the chain / code checks must win over that decode error.
  it('a read RPC on another chain, where nothing lives at the address, fails the chain check (typed)', async () => {
    const { chain, p, acct } = make()
    chain.chainId = 8453
    chain.codes.delete(VAULT.toLowerCase())
    chain.codes.delete(IMPL.toLowerCase())
    chain.contracts.delete(VAULT.toLowerCase())
    const e = await p.supply({ amount: E18 }).catch((x) => x)
    expect(e).toBeInstanceOf(ScrvUsdVerificationError)
    expect(e).toMatchObject({ check: 'chain', observed: 'eip155:8453' })
    expect(acct.sent).toHaveLength(0)
  })

  it('an address with no code on Ethereum fails the clone check (typed), not a view-call decode error', async () => {
    const { chain, p } = make()
    chain.codes.delete(VAULT.toLowerCase())
    chain.contracts.delete(VAULT.toLowerCase())
    await expect(p.withdraw({ amount: 'max' })).rejects.toMatchObject({ name: 'ScrvUsdVerificationError', check: 'clone', observed: 'no code' })
  })

  it('refuses when the implementation code differs from the pinned VaultV3 3.0.4', async () => {
    const { chain, p, acct } = make()
    chain.codes.set(IMPL.toLowerCase(), `${IMPL_CODE.slice(0, -2)}00` as Hex)
    await expect(p.withdraw({ amount: 'max' })).rejects.toMatchObject({ name: 'ScrvUsdVerificationError', check: 'implementation' })
    expect(acct.sent).toHaveLength(0)
  })

  it('refuses another apiVersion', async () => {
    const { p } = make({ apiVersion: '3.0.5' })
    await expect(p.getVault()).rejects.toMatchObject({ check: 'apiVersion', expected: '3.0.4', observed: '3.0.5' })
  })

  it('refuses an asset that is not crvUSD', async () => {
    const { p } = make({ asset: OTHER })
    await expect(p.quoteSupply({ amount: E18 })).rejects.toMatchObject({ check: 'asset' })
  })

  it('refuses a read RPC that is not on Ethereum', async () => {
    const { chain, p } = make()
    chain.chainId = 8453
    await expect(p.getVault()).rejects.toMatchObject({ check: 'chain', observed: 'eip155:8453' })
  })

  it('an RPC failure during the checks refuses the operation (never a silent pass) and is retried next time', async () => {
    const { chain, p, acct } = make()
    chain.failOn.add('apiVersion')
    const e = await p.supply({ amount: E18 }).catch((x) => x)
    expect(e).toBeInstanceOf(Error)
    expect(e).not.toBeInstanceOf(ScrvUsdVerificationError)
    expect(acct.sent).toHaveLength(0)
    chain.failOn.delete('apiVersion')
    await expect(p.quoteSupply({ amount: E18 })).resolves.toMatchObject({ approvals: 1 })
  }, 20_000)

  it('verifies once per instance', async () => {
    const { chain, p } = make()
    await p.getVault()
    await p.getVault()
    expect(chain.of('apiVersion')).toHaveLength(1)
  })

  it('refuses another chain at construction (scrvUSD is a vault on Ethereum only)', () => {
    const { chain } = makeScrvUsd()
    expect(() => new ScrvUsdProtocolEvm(account(), { chainId: 8453, provider: chain.provider })).toThrow(CurveLendingError)
  })
})

describe('supply', () => {
  it('approves exactly the amount, then deposit(assets, me)', async () => {
    const { p, acct } = make()
    const amount = 1_000n * E18
    const r = await p.supply({ amount })
    expect(r.approveHashes).toHaveLength(1)
    const [approve, deposit] = sent(acct)
    expect(approve!.to).toBe(CRVUSD)
    expect(decode(approve!.data)).toMatchObject({ functionName: 'approve', args: [VAULT, amount] })
    expect(deposit!.to).toBe(VAULT)
    expect(deposit!.data.slice(0, 10)).toBe(toFunctionSelector('function deposit(uint256,address)'))
    expect(decode(deposit!.data)).toMatchObject({ functionName: 'deposit', args: [amount, USER] })
    // 1000 crvUSD at 1.1119 per share
    expect(r.sharesOut).toBe((amount * 13_452_475_871_734_876_233_205_548n) / 14_957_723_797_672_854_293_931_291n)
  })

  it('resets a smaller non-zero allowance to 0 first, and sends no approval when it suffices', async () => {
    const a = make()
    setAllowance(a.state, USER, 5n)
    await a.p.supply({ amount: E18 })
    expect(sent(a.acct).map((t) => [t.to, decode(t.data).functionName, ...(decode(t.data).args ?? [])])).toEqual([
      [CRVUSD, 'approve', VAULT, 0n], [CRVUSD, 'approve', VAULT, E18], [VAULT, 'deposit', E18, USER],
    ])
    const b = make()
    setAllowance(b.state, USER, 2n * E18)
    await b.p.supply({ amount: E18 })
    expect(sent(b.acct)).toHaveLength(1)
    expect(decode(sent(b.acct)[0]!.data).functionName).toBe('deposit')
  })

  it('credits onBehalfOf as the receiver', async () => {
    const { p, acct } = make()
    await p.supply({ amount: E18, onBehalfOf: OTHER })
    expect(decode(sent(acct).at(-1)!.data).args).toEqual([E18, OTHER])
  })

  it('refuses a shut-down vault (VaultShutdownError) and nothing is approved', async () => {
    const { p, acct } = make({ isShutdown: true })
    await expect(p.supply({ amount: E18 })).rejects.toBeInstanceOf(VaultShutdownError)
    expect(acct.sent).toHaveLength(0)
  })

  it('refuses above maxDeposit with what is possible', async () => {
    const { p } = make({ maxDeposit: 10n })
    await expect(p.quoteSupply({ amount: E18 })).rejects.toMatchObject({ code: 'ExceededMaxDeposit', message: expect.stringContaining('at most 10') })
  })

  it('refuses while the vault lends to strategies unless allowStrategies', async () => {
    await expect(make({ totalDebt: 1n }).p.quoteSupply({ amount: E18 })).rejects.toMatchObject({ code: 'StrategiesInUse' })
    await expect(make({ totalDebt: 1n }, { allowStrategies: true }).p.quoteSupply({ amount: E18 })).resolves.toMatchObject({ approvals: 1 })
  })

  it('a failed isShutdown read refuses the deposit', async () => {
    const { chain, p, acct } = make()
    await p.getVault()
    chain.failOn.add('isShutdown')
    await expect(p.supply({ amount: E18 })).rejects.toThrow(/upstream timeout|fetch failed|HTTP|RPC/i)
    expect(acct.sent).toHaveLength(0)
  }, 20_000)

  it('turns a VaultV3 revert in the proof into a readable error', async () => {
    const { state, p } = make()
    setAllowance(state, USER, E18)
    state.revertOn.set('deposit', 'exceed deposit limit')
    await expect(p.quoteSupply({ amount: E18 })).rejects.toMatchObject({ name: 'CurveLendingError', code: 'exceed deposit limit', message: expect.stringContaining('deposit limit') })
  })

  it('takes crvUSD only', async () => {
    const { p } = make()
    await expect(p.quoteSupply({ token: OTHER, amount: E18 })).rejects.toThrow(/crvUSD/)
    await expect(p.quoteSupply({ token: 'native', amount: E18 })).rejects.toThrow(/crvUSD only/)
    await expect(p.quoteSupply({ amount: 0n })).rejects.toThrow(/greater than zero/)
    await expect(p.quoteSupply({ amount: 1.5 as never })).rejects.toThrow(/bigint/)
  })
})

describe('withdraw', () => {
  const SHARES = 677_457_969_866_222_208_833_493n // the fixture deposit's shares

  it("'max' redeems every share with max_loss = 0 (the 4-argument redeem)", async () => {
    const { state, p, acct } = make()
    setShares(state, USER, SHARES)
    const r = await p.withdraw({ amount: 'max' })
    const tx = sent(acct)[0]!
    expect(tx.data.slice(0, 10)).toBe(toFunctionSelector('function redeem(uint256,address,address,uint256)'))
    expect(decode(tx.data).args).toEqual([SHARES, USER, USER, 0n])
    expect(r).toMatchObject({ sharesIn: SHARES, complete: true })
    // 18-decimal shares → 18-decimal crvUSD at the live share price, rounded down.
    expect(r.assetsOut).toBe((SHARES * 14_957_723_797_672_854_293_931_291n) / 13_452_475_871_734_876_233_205_548n)
    expect(r.assetsOut).toBe(753_261_280_258_614_301_534_253n)
  })

  it("'max' redeems the whole balance although VaultV3's maxRedeem rounds one unit short", async () => {
    const { state, p } = make()
    setShares(state, USER, SHARES)
    const pos = await p.getPosition()
    expect(pos.redeemableShares).toBe(SHARES)
    const plan = await p.planWithdraw({ amount: 'max' })
    expect(plan).toMatchObject({ sharesIn: SHARES, complete: true })
  })

  it("'max' is clamped to maxRedeem when the vault cannot pay everything, and says so", async () => {
    const { state, p, acct } = make({ liquid: 100n * E18 })
    setShares(state, USER, SHARES)
    const r = await p.withdraw({ amount: 'max' })
    expect(r.complete).toBe(false)
    expect(r.sharesIn).toBeLessThan(SHARES)
    expect(r.assetsOut).toBeLessThanOrEqual(100n * E18)
    expect(decode(sent(acct)[0]!.data).args?.[0]).toBe(r.sharesIn)
  })

  it("'max' with nothing redeemable is refused", async () => {
    const { state, p } = make({ liquid: 0n })
    setShares(state, USER, SHARES)
    await expect(p.quoteWithdraw({ amount: 'max' })).rejects.toMatchObject({ code: 'ExceededMaxRedeem' })
  })

  it('an amount withdraws exactly that much with max_loss = 0 (the 4-argument withdraw)', async () => {
    const { state, p, acct } = make()
    setShares(state, USER, SHARES)
    const amount = 1_000n * E18
    const r = await p.withdraw({ amount, to: OTHER })
    const tx = sent(acct)[0]!
    expect(tx.data.slice(0, 10)).toBe(toFunctionSelector('function withdraw(uint256,address,address,uint256)'))
    expect(decode(tx.data).args).toEqual([amount, OTHER, USER, 0n])
    expect(r.assetsOut).toBe(amount)
    expect(r.sharesIn).toBe((amount * 13_452_475_871_734_876_233_205_548n + 14_957_723_797_672_854_293_931_291n - 1n) / 14_957_723_797_672_854_293_931_291n)
    expect(r.complete).toBe(false)
  })

  it('an amount above maxWithdraw is refused with what is withdrawable', async () => {
    const { state, p, acct } = make({ liquid: 10n * E18 })
    setShares(state, USER, SHARES)
    await expect(p.withdraw({ amount: 11n * E18 })).rejects.toMatchObject({ code: 'ExceededMaxWithdraw', message: expect.stringContaining(String(10n * E18)) })
    expect(acct.sent).toHaveLength(0)
  })

  it('an amount above the position, or no position, is refused', async () => {
    const a = make()
    await expect(a.p.quoteWithdraw({ amount: 'max' })).rejects.toThrow(/nothing deposited/)
    setShares(a.state, USER, E18)
    await expect(a.p.quoteWithdraw({ amount: 2n * E18 })).rejects.toThrow(/exceeds the position/)
  })

  it('stays open when the vault is shut down', async () => {
    const { state, p } = make({ isShutdown: true })
    setShares(state, USER, SHARES)
    await expect(p.quoteWithdraw({ amount: 'max' })).resolves.toMatchObject({ complete: true })
  })

  it('position: shares, their value, and what leaves now', async () => {
    const { state, p } = make({ liquid: 5n * E18 })
    setShares(state, USER, SHARES)
    const pos = await p.getPosition()
    expect(pos.shares).toBe(SHARES)
    expect(pos.assets).toBe(753_261_280_258_614_301_534_253n)
    expect(pos.withdrawable).toBe(5n * E18)
    expect(pos.redeemableShares).toBe((5n * E18 * 13_452_475_871_734_876_233_205_548n) / 14_957_723_797_672_854_293_931_291n)
    expect(await p.getPosition(OTHER)).toEqual({ shares: 0n, assets: 0n, withdrawable: 0n, redeemableShares: 0n })
  })
})

describe('borrow / repay', () => {
  it('throw NotImplementedError', async () => {
    const { p } = make()
    for (const m of ['borrow', 'quoteBorrow', 'repay', 'quoteRepay'] as const) await expect(p[m]()).rejects.toBeInstanceOf(NotImplementedError)
  })
})

describe('calldata', () => {
  it('max_loss is an explicit 0 — the 3-argument redeem would default to MAX_BPS (any loss)', () => {
    const three = encodeFunctionData({ abi: parseAbi(['function redeem(uint256,address,address) returns (uint256)']), functionName: 'redeem', args: [1n, USER, USER] })
    const four = encodeFunctionData({ abi: VAULT_V3_ABI, functionName: 'redeem', args: [1n, USER, USER, 0n] })
    expect(four.slice(0, 10)).not.toBe(three.slice(0, 10))
    expect(four.slice(0, 10)).toBe('0x9f40a7b3')
  })
})
