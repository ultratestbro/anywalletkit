import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { PolicyViolationError, applyPolicies, type WriteIntent } from '../src/index.js'

// ── fixtures: byte-exact encodings built here, independent of the kit's readers ──

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function b58(bytes: Uint8Array): string {
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'))
  let out = ''
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out }
  return out
}
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest()
/** Tron hex `41…` → base58check T… */
const tronBase58 = (hex41: string) => { const raw = Buffer.from(hex41, 'hex'); return b58(Buffer.concat([raw, sha256(sha256(raw)).subarray(0, 4)])) }

const varint = (n: number | bigint): number[] => { let v = BigInt(n); const out: number[] = []; do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b) } while (v); return out }
const fieldBytes = (no: number, b: Uint8Array | number[]) => [...varint((no << 3) | 2), ...varint(b.length), ...b]
const fieldVarint = (no: number, v: number | bigint) => [...varint(no << 3), ...varint(v)]
const hexBytes = (h: string) => [...Buffer.from(h, 'hex')]

const OWNER = '41' + '11'.repeat(20)
const DRAINER_HEX = '41' + 'de'.repeat(20)
const DRAINER_T = tronBase58(DRAINER_HEX)
const FRIEND_HEX = '41' + '22'.repeat(20)

/** Transaction.raw with one TransferContract (type 1) or TriggerSmartContract (type 31). */
function tronRaw(kind: 'transfer' | 'trigger', to: string): string {
  const param = kind === 'transfer'
    ? [...fieldBytes(1, hexBytes(OWNER)), ...fieldBytes(2, hexBytes(to)), ...fieldVarint(3, 1_000_000)]
    : [...fieldBytes(1, hexBytes(OWNER)), ...fieldBytes(2, hexBytes(to)), ...fieldBytes(4, [0xa9, 0x05, 0x9c, 0xbb])]
  const typeName = kind === 'transfer' ? 'TransferContract' : 'TriggerSmartContract'
  const any = [...fieldBytes(1, [...Buffer.from(`type.googleapis.com/protocol.${typeName}`)]), ...fieldBytes(2, param)]
  const contract = [...fieldVarint(1, kind === 'transfer' ? 1 : 31), ...fieldBytes(2, any)]
  const raw = [...fieldBytes(1, [0xab, 0xcd]), ...fieldBytes(4, hexBytes('00'.repeat(8))), ...fieldVarint(8, 1_800_000_000_000), ...fieldBytes(11, contract), ...fieldVarint(14, 1_700_000_000_000)]
  return Buffer.from(raw).toString('hex')
}

/** NEAR borsh Transaction (ed25519 key): signerId, publicKey, nonce, receiverId, blockHash, no actions. */
function nearBorsh(signer: string, receiver: string): string {
  const s = (t: string) => { const b = Buffer.from(t); const len = Buffer.alloc(4); len.writeUInt32LE(b.length); return Buffer.concat([len, b]) }
  return Buffer.concat([s(signer), Buffer.from([0]), Buffer.alloc(32, 7), Buffer.alloc(8, 1), s(receiver), Buffer.alloc(32, 9), Buffer.from([0, 0, 0, 0])]).toString('base64')
}

/** TON friendly (bounceable, workchain 0) form of `0:<hash>`; the CRC is not part of what the kit compares. */
const tonFriendly = (hash: string) => Buffer.concat([Buffer.from([0x11, 0x00]), Buffer.from(hash, 'hex'), Buffer.from([0, 0])]).toString('base64url')

/** A legacy Solana wire transaction: payer → `to` System transfer (optionally + an ix touching a lookup-table index). */
function solanaWire(payer: Uint8Array, to: Uint8Array, opts: { lookupIndex?: boolean } = {}): string {
  const system = new Uint8Array(32)
  const keys = [payer, to, system]
  const transfer = [2, 2, 0, 1, 12, ...[2, 0, 0, 0], ...[0x40, 0x42, 0x0f, 0, 0, 0, 0, 0]]
  const ixs = opts.lookupIndex ? [transfer, [2, 2, 0, 7, 12, ...[2, 0, 0, 0], ...[1, 0, 0, 0, 0, 0, 0, 0]]] : [transfer]
  const msg = [1, 0, 1, keys.length, ...keys.flatMap((k) => [...k]), ...new Array(32).fill(5), ixs.length, ...ixs.flat()]
  return Buffer.from([1, ...new Array(64).fill(0), ...msg]).toString('base64')
}
const key = (fill: number) => new Uint8Array(32).fill(fill)

function account(chain: string, extra: Record<string, unknown> = {}) {
  return Object.assign(createMockAccount({ chain, address: 'me' }), {
    signRaw: async (tx: unknown) => tx,
    signBuilt: async (tx: unknown) => tx,
    sendSerialized: async () => ({ hash: 'h' }),
    ...extra,
  })
}

describe('kit policies — destinations per chain shape (scan F16/F17)', () => {
  it('NEAR: the blocklist sees receiverId on sendTransaction / signTransaction (object and base64 borsh), as on transfer', async () => {
    const acc = applyPolicies(account('near:mainnet'), { blocklist: { 'near:mainnet': ['drainer.near'] } })
    await expect(acc.transfer({ recipient: 'drainer.near', amount: 1n })).rejects.toThrow(/drainer\.near is on the near:mainnet blocklist/)
    await expect(acc.sendTransaction({ receiverId: 'drainer.near', actions: [{ transfer: { deposit: 10n ** 30n } }] })).rejects.toThrow(/drainer\.near is on the near:mainnet blocklist/)
    await expect(acc.signTransaction(nearBorsh('me.near', 'drainer.near'))).rejects.toThrow(/drainer\.near is on the near:mainnet blocklist/)
    await expect((acc as unknown as { signBuilt(t: unknown): Promise<unknown> }).signBuilt({ receiverId: 'drainer.near', actions: [] })).rejects.toBeInstanceOf(PolicyViolationError)
    expect(await acc.sendTransaction({ receiverId: 'friend.near', actions: [] })).toMatchObject({ hash: expect.any(String) })
    expect(await acc.signTransaction(nearBorsh('me.near', 'friend.near'))).toBe('0xsigned')
  })

  it('Tron: signRaw / sendTransaction decide on raw_data_hex, never the JSON copy; addresses compare canonically (base58 vs 41-hex)', async () => {
    const acc = applyPolicies(account('tron:0x2b6653dc'), { blocklist: { 'tron:0x2b6653dc': [DRAINER_T] } })
    const raw = tronRaw('transfer', DRAINER_HEX)
    const signRaw = (tx: unknown) => (acc as unknown as { signRaw(t: unknown): Promise<unknown> }).signRaw(tx)
    // the report's exploits: no JSON at all, and JSON naming a harmless address
    await expect(signRaw({ txID: 'x', raw_data_hex: raw })).rejects.toThrow(/blocklist/)
    await expect(signRaw({ txID: 'x', raw_data_hex: raw, raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { to_address: FRIEND_HEX } } }] } })).rejects.toThrow(/blocklist/)
    // the JSON in hex form against a base58 blocklist entry
    await expect(signRaw({ txID: 'x', raw_data_hex: raw, raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { to_address: DRAINER_HEX } } }] } })).rejects.toThrow(/blocklist/)
    // sendTransaction of the same raw transaction, as object and as a JSON string
    await expect(acc.sendTransaction({ txID: 'x', raw_data_hex: raw })).rejects.toThrow(/blocklist/)
    await expect(acc.sendTransaction(JSON.stringify({ txID: 'x', raw_data_hex: raw }))).rejects.toThrow(/blocklist/)
    // a contract call to the blocked contract, by bytes and by contractAddress in hex
    await expect(signRaw({ txID: 'x', raw_data_hex: tronRaw('trigger', DRAINER_HEX) })).rejects.toThrow(/blocklist/)
    await expect(acc.sendTransaction({ contractAddress: DRAINER_HEX, functionSelector: 'transfer(address,uint256)' })).rejects.toThrow(/blocklist/)
    await expect(acc.sendTransaction({ to: `0x${DRAINER_HEX}`, value: 1 })).rejects.toThrow(/blocklist/)
    // unrelated destination passes
    expect(await signRaw({ txID: 'x', raw_data_hex: tronRaw('transfer', FRIEND_HEX) })).toBeTruthy()
    // a prebuilt transaction with only the JSON copy, or bytes that do not decode: unknown → refused (blocklist, no confirm)
    await expect(signRaw({ txID: 'x', raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { to_address: FRIEND_HEX } } }] } })).rejects.toThrow(/Cannot tell every destination/)
    await expect(signRaw({ txID: 'x', raw_data_hex: 'zz' })).rejects.toThrow(/Cannot tell every destination/)
  })

  it('Tron signRaw: intent.to, amount and destinations all come from the signed bytes, not the JSON copy (scan 2026-10-27 F26)', async () => {
    const seen: WriteIntent[] = []
    const acc = applyPolicies(account('tron:0x2b6653dc'), { confirm: async (i) => { seen.push(i); return true } })
    await (acc as unknown as { signRaw(t: unknown): Promise<unknown> }).signRaw({ txID: 'x', raw_data_hex: tronRaw('transfer', DRAINER_HEX), raw_data: { contract: [{ parameter: { value: { to_address: FRIEND_HEX, amount: 5 } } }] } })
    expect(seen[0]).toMatchObject({ to: DRAINER_HEX, amount: 1_000_000n, destinations: [DRAINER_HEX], destinationUnknown: false })
  })

  it('TON: every message of a sendTransaction array is a destination; friendly and raw forms compare equal', async () => {
    const hash = 'ab'.repeat(32)
    const acc = applyPolicies(account('ton:-239'), { blocklist: { 'ton:-239': [tonFriendly(hash)] } })
    await expect(acc.sendTransaction([{ to: `0:${'11'.repeat(32)}`, value: 1n }, { to: `0:${hash.toUpperCase()}`, value: 10n ** 9n }])).rejects.toThrow(/blocklist/)
    await expect(acc.transfer({ recipient: `0:${hash}`, amount: 1n })).rejects.toThrow(/blocklist/)
    expect(await acc.sendTransaction([{ to: `0:${'11'.repeat(32)}`, value: 1n }])).toMatchObject({ hash: expect.any(String) })
    // a prebuilt Cell is not read: unknown → refused without confirm
    await expect(acc.sendTransaction({ bits: [], refs: [] })).rejects.toThrow(/Cannot tell every destination/)
  })

  it('Solana: serialized transactions are decoded (System transfer recipient); lookup-table accounts are unknown', async () => {
    const payer = key(1)
    const drainer = key(0xde)
    const drainerB58 = b58(drainer)
    const acc = applyPolicies(account('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'), { blocklist: { 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': [drainerB58] } })
    await expect(acc.sendTransaction(solanaWire(payer, drainer))).rejects.toThrow(new RegExp(`${drainerB58} is on the`))
    await expect((acc as unknown as { sendSerialized(b: string, g: unknown): Promise<unknown> }).sendSerialized(solanaWire(payer, drainer), {})).rejects.toThrow(/blocklist/)
    // kit TransactionMessage shape
    const message = { version: 0, instructions: [{ programAddress: '11111111111111111111111111111111', accounts: [{ address: b58(payer) }, { address: drainerB58 }], data: Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) }] }
    await expect(acc.sendTransaction(message)).rejects.toThrow(/blocklist/)
    expect(await acc.sendTransaction(solanaWire(payer, key(2)))).toMatchObject({ hash: expect.any(String) })
    await expect(acc.sendTransaction(solanaWire(payer, key(2), { lookupIndex: true }))).rejects.toThrow(/Cannot tell every destination/)
  })

  it('EVM: every call of a batch is checked; the allowlist needs every destination', async () => {
    const ok = '0x00000000000000000000000000000000000000A1'
    const bad = '0x00000000000000000000000000000000000000B2'
    const acc = applyPolicies(account('eip155:1'), { blocklist: { 'eip155:1': [bad.toLowerCase()] } })
    await expect(acc.sendTransaction([{ to: ok, data: '0x' }, { to: bad, data: '0x' }])).rejects.toThrow(/blocklist/)
    expect(await acc.sendTransaction({ to: ok, value: 1n })).toMatchObject({ hash: expect.any(String) })
    const allow = applyPolicies(account('eip155:1'), { allowlist: { 'eip155:1': [ok] } })
    await expect(allow.sendTransaction([{ to: ok }, { to: bad }])).rejects.toThrow(/0x0+B2 is not on the eip155:1 allowlist/)
    expect(await allow.sendTransaction([{ to: ok }, { to: ok.toLowerCase() }])).toMatchObject({ hash: expect.any(String) })
  })

  it('unknown destination: fail closed only with a blocklist and no confirm; otherwise confirm sees destinationUnknown', async () => {
    const cell = { bits: [], refs: [] }
    await expect(applyPolicies(account('ton:-239'), { blocklist: { 'ton:-239': ['EQ'] } }).sendTransaction(cell)).rejects.toBeInstanceOf(PolicyViolationError)
    const confirm = vi.fn(async (_i: WriteIntent) => true)
    expect(await applyPolicies(account('ton:-239'), { blocklist: { 'ton:-239': ['EQ'] }, confirm }).sendTransaction(cell)).toMatchObject({ hash: expect.any(String) })
    expect(confirm.mock.calls[0]![0]).toMatchObject({ destinations: [], destinationUnknown: true })
    // no blocklist for that chain: nothing to fail closed on
    expect(await applyPolicies(account('ton:-239'), { blocklist: { 'eip155:1': ['0x1'] } }).sendTransaction(cell)).toMatchObject({ hash: expect.any(String) })
    // an allowlist never accepts an unknown destination
    await expect(applyPolicies(account('ton:-239'), { allowlist: { 'ton:-239': ['EQ'] }, confirm }).sendTransaction(cell)).rejects.toThrow(/allowlist/)
  })

  it('messages and typed data carry no destinations; approvals carry the spender', async () => {
    const seen: WriteIntent[] = []
    const acc = applyPolicies(Object.assign(account('eip155:1'), { approve: async () => ({ hash: 'a' }) }), { confirm: async (i) => { seen.push(i); return true } })
    await acc.sign('hello')
    await (acc as unknown as { approve(o: unknown): Promise<unknown> }).approve({ token: '0xT', spender: '0xS', amount: 5n })
    expect(seen.map((i) => [i.kind, i.destinations, i.destinationUnknown])).toEqual([['message', [], false], ['approval', ['0xS'], false]])
  })
})
