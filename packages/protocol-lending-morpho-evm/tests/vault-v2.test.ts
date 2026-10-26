import { describe, expect, it } from 'vitest'
import { decodeFunctionData, type Hex } from 'viem'
import { ERC20_ABI, ERC4626_ABI } from '../src/abi.js'
import { MorphoError, MorphoVaultProtocolEvm } from '../src/index.js'
import { E6, E18, OTHER, USDC, USER, VAULT_V2, account, makeMorpho, setAllowance, setBalance } from './fixture.js'

// Audit 2026-10-25 round 3, M22: Morpho Vault V2 answers 0 from maxDeposit / maxMint / maxWithdraw /
// maxRedeem for every address (its source, and live on Base 2026-10-26: the Steakhouse High Yield
// USDC V2 vault 0xbeeff249…8845 returns 0 for all four). The module refused every V2 supply
// ("deposits are closed") and every V2 withdrawal ("only 0 … withdrawable"). V2 enforces its gates,
// caps and liquidity by reverting, so for V2 the gates are read and the call is proven by eth_call.

const decodeSent = (tx: unknown) => {
  const t = tx as { to: string; data: Hex }
  const abi = t.to === VAULT_V2 ? ERC4626_ABI : ERC20_ABI
  const { functionName, args } = decodeFunctionData({ abi, data: t.data })
  return { to: t.to, fn: functionName, args: args as readonly unknown[] }
}
const v2 = () => {
  const { chain, state } = makeMorpho()
  const acc = account()
  return { chain, state, acc, p: new MorphoVaultProtocolEvm(acc, { chainId: 8453, vault: VAULT_V2, provider: chain.provider, api: null }) }
}

describe('Morpho Vault V2: no reliance on max* views', () => {
  it('is recognised as V2 by its factory', async () => {
    expect(await v2().p.getVault()).toMatchObject({ version: 'v2', asset: { address: USDC }, fees: { performance: 0.05 } })
  })

  it('supply goes through although maxDeposit says 0; the deposit is proven', async () => {
    const { p, acc } = v2()
    await p.supply({ amount: 100n * E6 })
    expect(acc.sent.map(decodeSent)).toMatchObject([
      { to: USDC, fn: 'approve', args: [VAULT_V2, 100n * E6] },
      { to: VAULT_V2, fn: 'deposit', args: [100n * E6, USER] },
    ])
  })

  it('a closed gate or a cap is refused before anything is sent', async () => {
    const closed = v2()
    closed.state.v2Gates.sendAssets = false
    await expect(closed.p.supply({ amount: E6 })).rejects.toThrow(/not allowed to send/)
    closed.state.v2Gates.sendAssets = true
    closed.state.v2Gates.receiveShares = false
    await expect(closed.p.supply({ amount: E6 })).rejects.toThrow(/not allowed to receive/)
    expect(closed.acc.sent).toHaveLength(0)

    const capped = v2()
    capped.state.vault.maxDeposit = 10n * E6 // V2 caps revert inside deposit
    setAllowance(capped.state, USDC, USER, VAULT_V2, 100n * E6) // no approval pending → the proof runs first
    await expect(capped.p.quoteSupply({ amount: 100n * E6 })).rejects.toBeInstanceOf(MorphoError)
    await expect(capped.p.supply({ amount: 100n * E6 })).rejects.toBeInstanceOf(MorphoError)
    expect(capped.acc.sent).toHaveLength(0)
  })

  it("withdraw (partial and 'max') goes through although maxWithdraw / maxRedeem say 0", async () => {
    const { p, state, acc } = v2()
    setBalance(state, VAULT_V2, USER, 100n * E18)
    const pos = await p.getPosition()
    expect(pos.assets).toBe(100n * E6)
    expect(pos.withdrawable).toBe(100n * E6)
    await p.withdraw({ amount: 40n * E6, to: OTHER })
    await p.withdraw({ amount: 'max' })
    expect(acc.sent.map(decodeSent)).toMatchObject([
      { to: VAULT_V2, fn: 'withdraw', args: [40n * E6, OTHER, USER] },
      { to: VAULT_V2, fn: 'redeem', args: [100n * E18, USER, USER] },
    ])
  })

  it('missing liquidity is caught by the proof; the position says what can leave now', async () => {
    const { p, state, acc } = v2()
    setBalance(state, VAULT_V2, USER, 100n * E18)
    state.vault.liquid = 30n * E6
    setBalance(state, USDC, VAULT_V2, 30n * E6) // idle assets in the vault
    expect((await p.getPosition()).withdrawable).toBe(30n * E6)
    await expect(p.withdraw({ amount: 40n * E6 })).rejects.toBeInstanceOf(MorphoError)
    await expect(p.withdraw({ amount: 'max' })).rejects.toBeInstanceOf(MorphoError)
    expect(acc.sent).toHaveLength(0)
    await p.withdraw({ amount: 30n * E6 })
    expect(acc.sent).toHaveLength(1)
  })

  it('closed exit gates are refused', async () => {
    const { p, state } = v2()
    setBalance(state, VAULT_V2, USER, 100n * E18)
    state.v2Gates.receiveAssets = false
    await expect(p.withdraw({ amount: E6, to: OTHER })).rejects.toThrow(/gated vault refuses the withdrawal/)
  })
})
