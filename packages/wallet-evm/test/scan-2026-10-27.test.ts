import { describe, expect, it } from 'vitest'
import { WalletManagerEvm, describeTransaction } from '../src/index.js'

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
