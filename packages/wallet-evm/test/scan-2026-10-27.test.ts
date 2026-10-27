import { describe, expect, it } from 'vitest'
import { WalletManagerEvm, describeTransaction, describeTypedData, inferPrimaryType } from '../src/index.js'
import { decodeTokenString } from '../src/token-info.js'

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

describe('scan 2026-10-27 G12 (F23): approve() is for ERC-20 tokens only', () => {
  const NFT = '0x' + '77'.repeat(20)
  /** A minimal EIP-1193 provider; `call` answers eth_call by calldata. */
  const provider = (call: (data: string) => unknown) => {
    const sent: string[] = []
    const h: Record<string, (p: unknown[]) => unknown> = {
      eth_chainId: () => '0x1', eth_blockNumber: () => '0x10', eth_maxPriorityFeePerGas: () => '0x1', eth_gasPrice: () => '0x2', eth_estimateGas: () => '0x5208',
      eth_getTransactionCount: () => '0x0', eth_getBalance: () => '0xde0b6b3a7640000',
      eth_getBlockByNumber: () => ({ number: '0x10', baseFeePerGas: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }),
      eth_call: (p) => call(String((p[0] as { data?: string; input?: string }).data ?? (p[0] as { input?: string }).input)),
      eth_sendRawTransaction: (p) => { sent.push(String(p[0])); return '0x' + 'ab'.repeat(32) },
    }
    return { sent, provider: { request: async ({ method, params }: { method: string; params?: unknown[] }) => { const f = h[method]; if (!f) throw new Error(`unmocked ${method}`); return f(params ?? []) } } }
  }
  const revert = () => { throw Object.assign(new Error('execution reverted'), { code: 3 }) }
  const TRUE = '0x' + '0'.repeat(63) + '1'

  it('approve({ amount: 0 }) on an ERC-721 (ERC-165 0x80ac58cd, no decimals) is refused; nothing is sent', async () => {
    const node = provider((data) => (data.startsWith('0x01ffc9a7') && data.includes('80ac58cd') ? TRUE : data.startsWith('0x313ce567') ? revert() : '0x' + '0'.repeat(64)))
    const a = await new WalletManagerEvm(SEED, { provider: node.provider as never }).getAccount(0)
    await expect(a.approve({ token: NFT, spender: ATTACKER, amount: 0n })).rejects.toThrow(/ERC-721|ERC-20/)
    expect(node.sent).toHaveLength(0)
  })

  it('a contract without decimals() is refused; an ERC-20 is approved', async () => {
    const none = provider((data) => (data.startsWith('0x313ce567') ? revert() : '0x' + '0'.repeat(64)))
    await expect((await new WalletManagerEvm(SEED, { provider: none.provider as never }).getAccount(0)).approve({ token: NFT, spender: ATTACKER, amount: 0n })).rejects.toThrow(/decimals/)
    const erc20 = provider((data) => (data.startsWith('0x313ce567') ? '0x' + '6'.padStart(64, '0') : '0x' + '0'.repeat(64)))
    await (await new WalletManagerEvm(SEED, { provider: erc20.provider as never }).getAccount(0)).approve({ token: USDC, spender: ATTACKER, amount: 0n })
    expect(erc20.sent).toHaveLength(1)
  })
})

describe('scan 2026-10-27 G14 (F21, F24): token strings and typed data cannot freeze the thread', () => {
  it('a name() of 1 MB of NULs then "a" decodes in well under 100 ms', () => {
    const len = 1_000_000 + 1
    const hex = ('0x' + (32).toString(16).padStart(64, '0') + len.toString(16).padStart(64, '0') + '00'.repeat(1_000_000) + '61' + '00'.repeat(31)) as `0x${string}`
    const t0 = performance.now()
    const out = decodeTokenString(hex)
    expect(performance.now() - t0).toBeLessThan(100)
    expect(out.length).toBeLessThanOrEqual(128)
    // An ordinary ABI string and a bytes32 still decode.
    const usdc = '0x' + (32).toString(16).padStart(64, '0') + (4).toString(16).padStart(64, '0') + Buffer.from('USDC').toString('hex').padEnd(64, '0')
    expect(decodeTokenString(usdc as `0x${string}`)).toBe('USDC')
    expect(decodeTokenString(('0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0')) as `0x${string}`)).toBe('MKR')
    // A long name is cut at 128 characters, not dropped.
    const long = 'x'.repeat(300)
    expect(decodeTokenString(('0x' + (32).toString(16).padStart(64, '0') + (300).toString(16).padStart(64, '0') + Buffer.from(long).toString('hex').padEnd(640, '0')) as `0x${string}`)).toBe('x'.repeat(128))
  })

  it('typed data with 20 000 types and 20 000 fields is refused quickly, not inferred quadratically', async () => {
    const types: Record<string, Array<{ name: string; type: string }>> = {}
    for (let i = 0; i < 20_000; i++) types[`T${i}`] = [{ name: 'f', type: `T${i + 1}` }]
    const t0 = performance.now()
    expect(() => inferPrimaryType(types)).toThrow(/types/)
    const a = await new WalletManagerEvm(SEED, { chainId: 1 }).getAccount(0)
    await expect(a.signTypedData({ domain: { chainId: 1 }, types, message: {} } as never)).rejects.toThrow()
    expect(performance.now() - t0).toBeLessThan(200)
  })
})
