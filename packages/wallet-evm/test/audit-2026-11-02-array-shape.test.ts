import { describe, expect, it, vi } from 'vitest'
import { parseTransaction } from 'viem'
import { PolicyViolationError, applyPolicies } from '@anywalletkit/kit'
import { UnsafeTransactionError, WalletManagerEvm, assertTxShape } from '../src/index.js'

// A transaction given as a list that also carries named fields: the lists read the elements, the
// account would sign the named fields. Offline, public test mnemonic.
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ALLOWED = '0x00000000000000000000000000000000000a110e'
const OTHER = '0x00000000000000000000000000000000000e0e01'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const fees = { chainId: 1, nonce: 0, gasLimit: 21_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }
const shaped = () => Object.assign([{ to: ALLOWED, value: 0n }], { to: OTHER, value: 10n ** 18n, ...fees })

describe('a list with named fields is neither judged by its elements nor signed', () => {
  it('allowlist: refused before confirm; nothing signed', async () => {
    const m = new WalletManagerEvm(SEED, { chainId: 1 })
    const acc = await m.getAccount()
    const confirm = vi.fn(async () => true)
    const guarded = applyPolicies(acc, { allowlist: { 'eip155:1': [ALLOWED] }, confirm }, 'eip155:1')
    await expect(guarded.signTransaction(shaped() as never)).rejects.toMatchObject({ policy: 'allowlist' })
    expect(confirm).not.toHaveBeenCalled()
    // control: the plain object to the allowed address signs
    const raw = await guarded.signTransaction({ to: ALLOWED, value: 1n, ...fees })
    expect(parseTransaction(raw as `0x${string}`).to?.toLowerCase()).toBe(ALLOWED)
    m.dispose()
  })

  it('blocklist without confirm: refused as unknown; with confirm the hook sees destinationUnknown and wallet-evm still refuses the list', async () => {
    const m = new WalletManagerEvm(SEED, { chainId: 1 })
    const acc = await m.getAccount()
    const blocked = applyPolicies(acc, { blocklist: { 'eip155:1': [OTHER] } }, 'eip155:1')
    await expect(blocked.signTransaction(shaped() as never)).rejects.toBeInstanceOf(PolicyViolationError)
    await expect(blocked.signTransaction({ to: OTHER, value: 1n, ...fees })).rejects.toMatchObject({ policy: 'blocklist' })
    const confirm = vi.fn(async (_i: unknown) => true)
    const asked = applyPolicies(acc, { confirm }, 'eip155:1')
    await expect(asked.signTransaction(shaped() as never)).rejects.toBeInstanceOf(UnsafeTransactionError)
    expect(confirm.mock.calls[0]![0]).toMatchObject({ kind: 'send', destinationUnknown: true })
    m.dispose()
  })

  it('wallet-evm refuses a list (with or without named fields) and a class instance; a plain or null-prototype object passes', async () => {
    const m = new WalletManagerEvm(SEED, { chainId: 1 })
    const acc = await m.getAccount()
    await expect(acc.signTransaction(Object.assign([], { to: OTHER, value: 1n, ...fees }) as never)).rejects.toBeInstanceOf(UnsafeTransactionError)
    await expect(acc.signTransaction([{ to: OTHER, value: 1n, ...fees }] as never)).rejects.toBeInstanceOf(UnsafeTransactionError)
    class Tx { to = OTHER; value = 1n }
    expect(() => assertTxShape(new Tx() as never)).toThrow(UnsafeTransactionError)
    expect(() => assertTxShape(null as never)).toThrow(UnsafeTransactionError)
    expect(() => assertTxShape({ to: OTHER, value: 1n })).not.toThrow()
    expect(() => assertTxShape(Object.assign(Object.create(null) as object, { to: OTHER }) as never)).not.toThrow()
    await expect(acc.signTransaction({ to: OTHER, value: 1n, ...fees })).resolves.toMatch(/^0x02/)
    m.dispose()
  })
})

describe('typed data whose message is a list with named keys (control)', () => {
  it('an EIP-3009 transfer to OTHER given as a list-message is refused by an ALLOWED-only allowlist', async () => {
    const types = { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }
    const m = new WalletManagerEvm(SEED, { chainId: 1 })
    const acc = await m.getAccount()
    const from = await acc.getAddress()
    const message = Object.assign([{ to: ALLOWED }], { from, to: OTHER, value: 1n, validAfter: 0n, validBefore: 2n ** 40n, nonce: `0x${'11'.repeat(32)}` })
    const g = applyPolicies(acc, { allowlist: { 'eip155:1': [ALLOWED] } }, 'eip155:1')
    await expect(g.signTypedData({ domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC }, types, primaryType: 'TransferWithAuthorization', message } as never)).rejects.toMatchObject({ policy: 'allowlist' })
    m.dispose()
  })
})
