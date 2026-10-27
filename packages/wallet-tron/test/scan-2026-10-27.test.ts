import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { WalletManagerTron, encodeCall, encodeParameters, toHexAddress } from '../src/index.js'
import { NOW, RECIPIENT, fakeNode, seal } from './fake-node.js'

// 2026-10-27 key/signing scan: the exploit inputs from the report, refused before anything is signed.

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'
const NFT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ATTACKER = 'TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9'
const word = (addr: string) => toHexAddress(addr).slice(2).padStart(64, '0')
const varint = (n: number) => { let h = ''; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; h += b.toString(16).padStart(2, '0') } while (n); return h }
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

describe('scan 2026-10-27 G9 (F22, F25, F26, F27): signRaw checks the network, the worst-case fee and the JSON copy', () => {
  const OWNER_HEX = toHexAddress(ADDR0)
  const transfer = (extra: Record<string, unknown> = {}, value: Record<string, unknown> = {}) => seal({
    contract: [{ type: 'TransferContract', parameter: { value: { owner_address: OWNER_HEX, to_address: toHexAddress(RECIPIENT), amount: 1_000_000, ...value }, type_url: 'type.googleapis.com/protocol.TransferContract' } }],
    ref_block_bytes: 'a1b2', ref_block_hash: '0011223344556677', expiration: NOW + 60_000, timestamp: NOW, ...extra,
  })

  it('a reference block that is not on the configured network (mainnet ref on a Nile account) is refused', async () => {
    const f = fakeNode()
    const a = await new WalletManagerTron(SEED, { provider: f.fetch, network: 'nile' }).getAccount(0)
    await expect(withNow(() => a.signRaw(transfer({ ref_block_hash: 'deadbeefdeadbeef' })))).rejects.toMatchObject({ code: 'ref-block-mismatch' })
    // The fake node's own chain: signed.
    const signed = await withNow(() => a.signRaw(transfer()))
    expect(signed.signature).toHaveLength(1)
  })

  it('offline, a non-mainnet account refuses to sign unless allowOfflineTestnetSigning is set; mainnet offline signs', async () => {
    const nile = await new WalletManagerTron(SEED, { network: 'nile' }).getAccount(0)
    await expect(withNow(() => nile.signRaw(transfer()))).rejects.toMatchObject({ code: 'offline-network' })
    const optedIn = await new WalletManagerTron(SEED, { network: 'nile', allowOfflineTestnetSigning: true }).getAccount(0)
    expect((await withNow(() => optedIn.signRaw(transfer()))).signature).toHaveLength(1)
    const mainnet = await new WalletManagerTron(SEED).getAccount(0)
    expect((await withNow(() => mainnet.signRaw(transfer()))).signature).toHaveLength(1)
  })

  it('no fee_limit plus a 300 KB memo under maxFee 5 TRX is refused; so is a contract call without fee_limit, and any cap offline', async () => {
    const f = fakeNode()
    const a = await new WalletManagerTron(SEED, { provider: f.fetch }).getAccount(0)
    // 300 KB of raw_data.data, spliced into a canonical encoding (field 10, before the contract).
    const small = transfer({ data: 'abab' })
    const at = small.raw_data_hex.indexOf('5202abab')
    const memo = 'ab'.repeat(300_000)
    const hex = small.raw_data_hex.slice(0, at) + '52' + varint(300_000) + memo + small.raw_data_hex.slice(at + 8)
    const big = { txID: bytesToHex(sha256(hexToBytes(hex))), raw_data_hex: hex, visible: false, raw_data: { ...small.raw_data, data: memo } }
    await expect(withNow(() => a.signRaw(big, { maxFee: 5_000_000n }))).rejects.toMatchObject({ code: 'memo' })
    await expect(withNow(() => a.signRaw(big))).rejects.toMatchObject({ code: 'memo' })
    const call = seal({
      contract: [{ type: 'TriggerSmartContract', parameter: { value: { owner_address: OWNER_HEX, contract_address: toHexAddress(NFT), data: 'a9059cbb' + word(RECIPIENT) + '1'.padStart(64, '0') }, type_url: 'type.googleapis.com/protocol.TriggerSmartContract' } }],
      ref_block_bytes: 'a1b2', ref_block_hash: '0011223344556677', expiration: NOW + 60_000, timestamp: NOW,
    })
    await expect(withNow(() => a.signRaw(call, { maxFee: 5_000_000n }))).rejects.toMatchObject({ code: 'fee-limit' })
    // A memo whose fee alone (1 TRX) breaks a 0.5 TRX cap.
    await expect(withNow(() => a.signRaw(transfer({ data: 'ab'.repeat(10) }), { maxFee: 500_000n }))).rejects.toMatchObject({ code: 'fee-limit' })
    expect((await withNow(() => a.signRaw(transfer(), { maxFee: 5_000_000n }))).signature).toHaveLength(1)
    const offline = await new WalletManagerTron(SEED).getAccount(0)
    await expect(withNow(() => offline.signRaw(transfer(), { maxFee: 5_000_000n }))).rejects.toMatchObject({ code: 'fee-limit' })
  })

  it('a VoteWitnessContract whose JSON copy carries to_address / amount is refused (raw-mismatch)', async () => {
    const vote = seal({
      contract: [{ type: 'VoteWitnessContract', parameter: { value: { owner_address: OWNER_HEX }, type_url: 'type.googleapis.com/protocol.VoteWitnessContract' } }],
      ref_block_bytes: 'a1b2', ref_block_hash: '0011223344556677', expiration: NOW + 60_000, timestamp: NOW,
    })
    const lying = { ...vote, raw_data: { ...vote.raw_data, contract: [{ ...vote.raw_data.contract[0]!, parameter: { ...vote.raw_data.contract[0]!.parameter, value: { owner_address: OWNER_HEX, to_address: toHexAddress(RECIPIENT), amount: 1_000_000 } } }] } }
    const a = await new WalletManagerTron(SEED, { provider: fakeNode().fetch }).getAccount(0)
    await expect(withNow(() => a.signRaw(lying))).rejects.toMatchObject({ code: 'raw-mismatch' })
    // A vote's own keys (votes) are still accepted next to the bytes.
    const honest = { ...vote, raw_data: { ...vote.raw_data, contract: [{ ...vote.raw_data.contract[0]!, parameter: { ...vote.raw_data.contract[0]!.parameter, value: { owner_address: OWNER_HEX, votes: [{ vote_address: toHexAddress(RECIPIENT), vote_count: 1 }] } } }] } }
    expect((await withNow(() => a.signRaw(honest))).signature).toHaveLength(1)
  })
})
