import { describe, expect, it } from 'vitest'
import { WalletManagerTron, encodeCall, encodeParameters, toHexAddress } from '../src/index.js'
import { NOW, RECIPIENT, fakeNode } from './fake-node.js'

// 2026-10-27 key/signing scan: the exploit inputs from the report, refused before anything is signed.

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'
const NFT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ATTACKER = 'TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9'
const word = (addr: string) => toHexAddress(addr).slice(2).padStart(64, '0')
const withNow = async <T>(f: () => Promise<T>): Promise<T> => { const real = Date.now; Date.now = () => NOW; try { return await f() } finally { Date.now = real } }

describe('scan 2026-10-27 G7 (F14, F15): every Tron ABI parameter is exactly one word of its declared type', () => {
  it('safeTransferFrom with a bytes32 carrying three words (wallet, attacker, tokenId) is refused', async () => {
    const exploit = {
      contractAddress: NFT, functionSelector: 'safeTransferFrom(address,address,uint256)',
      parameters: [{ type: 'bytes32', value: word(ADDR0) + word(ATTACKER) + '7'.padStart(64, '0') }, { type: 'address', value: RECIPIENT }, { type: 'uint256', value: 0n }],
    }
    expect(() => encodeParameters(exploit.parameters)).toThrow()
    expect(() => encodeCall(exploit.functionSelector, exploit.parameters)).toThrow()
    const f = fakeNode()
    const m = new WalletManagerTron(SEED, { provider: f.fetch })
    const a = await m.getAccount(0)
    await expect(withNow(() => a.sendTransaction({ ...exploit, options: { feeLimit: 5_000_000 } }))).rejects.toThrow()
    expect(f.calls.filter((c) => c.path === '/wallet/broadcasttransaction')).toHaveLength(0)
    m.dispose()
  })

  it('a digit-only bytes32 in the amount slot of transfer(address,uint256) is refused (types must match the signature)', () => {
    const params = [{ type: 'address', value: RECIPIENT }, { type: 'bytes32', value: '0'.repeat(55) + '100000000' }]
    expect(() => encodeCall('transfer(address,uint256)', params)).toThrow(/type/)
    expect(() => encodeCall('transfer(address,uint256)', [{ type: 'address', value: RECIPIENT }])).toThrow(/parameter/)
    expect(encodeCall('transfer(address,uint256)', [{ type: 'address', value: RECIPIENT }, { type: 'uint256', value: 1n }])).toMatch(/^a9059cbb[0-9a-f]{128}$/)
  })

  it('uintN / intN are range-checked, negative uint is refused, bytes32 is bounded hex, bool is a boolean', () => {
    for (const bad of [
      { type: 'uint8', value: 256n }, { type: 'uint256', value: -1n }, { type: 'uint256', value: 1n << 256n }, { type: 'int8', value: -129n }, { type: 'int8', value: 128n },
      { type: 'uint256', value: ' 1' }, { type: 'uint256', value: '0b11' }, { type: 'uint256', value: 1.5 },
      { type: 'bytes32', value: 'zz' }, { type: 'bytes32', value: 'ab'.repeat(33) }, { type: 'bool', value: 'false' }, { type: 'uint7', value: 1n },
    ]) expect(() => encodeParameters([bad]), JSON.stringify(bad, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))).toThrow()
    expect(encodeParameters([{ type: 'int8', value: -1n }])).toBe('f'.repeat(64))
    expect(encodeParameters([{ type: 'uint256', value: '0x10' }, { type: 'bool', value: true }, { type: 'bytes32', value: '0xab' }])).toBe('10'.padStart(64, '0') + '1'.padStart(64, '0') + 'ab'.padEnd(64, '0'))
  })
})
