import { describe, expect, it } from 'vitest'
import { WalletManagerEvm, describeTransaction, describeTypedData } from '../src/index.js'

// 2026-10-27 key/signing scan: the exploit inputs from the report, refused before anything is signed.

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const ATTACKER = '0x000000000000000000000000000000000000dEaD'
const pad = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const FEES = { nonce: 0, gasLimit: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }

describe('scan 2026-10-27 G10 (F12): EVM calldata must be canonical 0x-hex bytes', () => {
  const transferCalldata = 'a9059cbb' + pad(ATTACKER) + pad('ff'.repeat(16))
  const bad = [
    ['1x prefix', '1x' + transferCalldata],
    ['no prefix', transferCalldata],
    ['odd length (approve with its leading 0 dropped)', '0x' + '95ea7b3' + pad(ATTACKER) + 'f'.repeat(64)],
    ['0X prefix', '0X' + transferCalldata],
    ['non-hex', '0x' + transferCalldata.slice(0, -2) + 'zz'],
  ] as const
  it('signTransaction refuses each non-canonical data string; 0x-hex and bytes are signed', async () => {
    const a = await new WalletManagerEvm(SEED, { chainId: 1 }).getAccount(0)
    for (const [name, data] of bad) await expect(a.signTransaction({ to: USDC, chainId: 1, ...FEES, data }), name).rejects.toThrow(/data/)
    await expect(a.signTransaction({ to: USDC, chainId: 1, ...FEES, data: '0x' + transferCalldata })).resolves.toMatch(/^0x02/)
    await expect(a.signTransaction({ to: USDC, chainId: 1, ...FEES, data: Uint8Array.from(Buffer.from(transferCalldata, 'hex')) as never })).resolves.toMatch(/^0x02/)
  })

  it('accessList storage keys must be 32-byte 0x-hex', async () => {
    const a = await new WalletManagerEvm(SEED, { chainId: 1 }).getAccount(0)
    await expect(a.signTransaction({ to: USDC, chainId: 1, ...FEES, accessList: [{ address: USDC, storageKeys: ['1x' + '00'.repeat(32)] }] } as never)).rejects.toThrow(/storage key/)
    await expect(a.signTransaction({ to: USDC, chainId: 1, ...FEES, accessList: [{ address: USDC, storageKeys: ['0x' + '00'.repeat(32)] }] } as never)).resolves.toMatch(/^0x02/)
  })

  it('describeTransaction refuses what signing would refuse instead of describing other bytes', () => {
    for (const [name, data] of bad) expect(() => describeTransaction({ to: USDC, data }), name).toThrow(/data/)
  })
})

describe('scan 2026-10-27 G11 (F11, F30): typed-data amounts and chain ids read the way the signer reads them', () => {
  const MAX = (1n << 256n) - 1n
  const permit = (value: unknown) => ({
    domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC },
    types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'Permit',
    message: { owner: ATTACKER, spender: ATTACKER, value, nonce: 0, deadline: 9_999_999_999 },
  })
  const spellings = [' ' + MAX.toString(), '0X' + 'f'.repeat(64), '0b' + '1'.repeat(256), MAX.toString() + ' ']

  it('signTypedData refuses a uint field in a spelling BigInt() reads but a review screen may not', async () => {
    const a = await new WalletManagerEvm(SEED, { chainId: 1 }).getAccount(0)
    for (const v of spellings) await expect(a.signTypedData(permit(v) as never), v.slice(0, 4)).rejects.toThrow(/number/)
    await expect(a.signTypedData(permit(MAX.toString()) as never)).resolves.toMatch(/^0x/)
    await expect(a.signTypedData(permit('0x' + 'f'.repeat(64)) as never)).resolves.toMatch(/^0x/)
    await expect(a.signTypedData(permit(5n) as never)).resolves.toMatch(/^0x/)
  })

  it('describeTypedData shows those spellings as unlimited, never as 0', () => {
    for (const v of spellings) {
      const d = describeTypedData(permit(v) as never)
      expect([v.slice(0, 4), d.kind === 'permit' && d.permit?.value]).toEqual([v.slice(0, 4), MAX])
      expect(d.warnings.some((w) => w.code === 'approve-unlimited')).toBe(true)
    }
  })

  it('PermitBatchWitnessTransferFrom is described as a Permit2 permit', () => {
    const d = describeTypedData({ domain: { name: 'Permit2', chainId: 1 }, primaryType: 'PermitBatchWitnessTransferFrom', types: { PermitBatchWitnessTransferFrom: [{ name: 'spender', type: 'address' }] }, message: { spender: ATTACKER, permitted: [{ token: USDC, amount: MAX.toString() }] } } as never)
    expect(d.kind).toBe('permit2')
    expect(d.warnings.some((w) => w.code === 'approve-unlimited')).toBe(true)
  })

  it('an offline account refuses chainId "0b10001001" (BigInt reads 137) instead of signing for Polygon', async () => {
    const a = await new WalletManagerEvm(SEED).getAccount(0)
    await expect(a.signTransaction({ to: USDC, chainId: '0b10001001' as never, ...FEES })).rejects.toThrow(/chain id/)
    await expect(a.signTransaction({ to: USDC, chainId: ' 137' as never, ...FEES })).rejects.toThrow(/chain id/)
    await expect(a.signTransaction({ to: USDC, chainId: '0x89' as never, ...FEES })).resolves.toMatch(/^0x02/)
  })
})
