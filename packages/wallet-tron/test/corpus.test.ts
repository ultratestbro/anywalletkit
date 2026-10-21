import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { describeTransaction, encodeRawData, isDecodedContractType, toHexAddress, verifyRawTransaction, type TronRawTransaction } from '../src/index.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

/**
 * Real transactions, JSON exactly as TronGrid returns it: mainnet blocks (every contract type
 * seen there, multisig Permission_id, memos, `scripts`, timestamps above 2^53), Vaulty's own
 * sends, TronGrid-built unsigned transactions and TronWeb 6.4 re-encodes. The strict reader
 * (scan F4) and the JSON consistency check must accept every one of them.
 */
const corpus = JSON.parse(readFileSync(new URL('./fixtures/tron-corpus.json', import.meta.url), 'utf8')) as { txs: Array<TronRawTransaction & { why: string }> }

describe('real-transaction corpus', () => {
  it('covers what it claims to', () => {
    const types = new Set(corpus.txs.map((t) => t.raw_data.contract[0]!.type))
    for (const t of ['TriggerSmartContract', 'TransferContract', 'TransferAssetContract', 'DelegateResourceContract', 'UnDelegateResourceContract', 'FreezeBalanceV2Contract', 'UnfreezeBalanceV2Contract', 'VoteWitnessContract', 'AccountCreateContract', 'WithdrawBalanceContract']) expect(types).toContain(t)
    expect(corpus.txs.filter((t) => (t.raw_data.contract[0] as { Permission_id?: number }).Permission_id).length).toBeGreaterThan(20)
    expect(corpus.txs.filter((t) => t.raw_data.data).length).toBeGreaterThan(4)
    expect(corpus.txs.filter((t) => (t.raw_data.timestamp ?? 0) > Number.MAX_SAFE_INTEGER).length).toBeGreaterThan(10)
    expect(corpus.txs.filter((t) => t.why === 'scripts').length).toBeGreaterThan(0)
  })

  it('verifyRawTransaction accepts every one', () => {
    const refused: string[] = []
    for (const t of corpus.txs) {
      try { verifyRawTransaction(t) } catch (e) { refused.push(`${t.txID} (${t.why}): ${(e as Error).message}`) }
    }
    expect(refused).toEqual([])
  })

  it('types without a schema are described as not decoded, never from their JSON', () => {
    for (const t of corpus.txs.filter((x) => !isDecodedContractType(x.raw_data.contract[0]!.type))) {
      const d = describeTransaction(t, { now: 0 })
      expect(d.kind).toBe('unknown')
      expect(d.warnings.find((w) => w.code === 'undecoded')?.message).toMatch(/not decoded by the wallet/)
    }
  })
})

describe('schema-less contract types from a node or a dApp', () => {
  const vote = corpus.txs.find((t) => t.raw_data.contract[0]!.type === 'VoteWitnessContract')!
  const create = corpus.txs.find((t) => t.raw_data.contract[0]!.type === 'AccountCreateContract')!

  it('the node JSON (votes, account_address) no longer makes the transaction raw-mismatch', () => {
    expect(verifyRawTransaction(vote).raw_data.contract[0]!.type).toBe('VoteWitnessContract')
    expect(verifyRawTransaction(create).raw_data.contract[0]!.type).toBe('AccountCreateContract')
    const d = describeTransaction(create, { now: 0 })
    expect(d.warnings.map((w) => w.code)).toContain('undecoded')
  })

  it('the owner and the type are still checked against the bytes', () => {
    const c = create.raw_data.contract[0]!
    const otherOwner = { ...create, raw_data: { ...create.raw_data, contract: [{ ...c, parameter: { ...c.parameter, value: { ...c.parameter.value, owner_address: toHexAddress('TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE') } } }] } }
    expect(() => verifyRawTransaction(otherOwner)).toThrow(/owner_address/)
    const otherType = { ...create, raw_data: { ...create.raw_data, contract: [{ ...c, type: 'TransferContract' }] } }
    expect(() => verifyRawTransaction(otherType)).toThrow(/type/)
  })

  it('a schema\'d type still compares every key', () => {
    const t = corpus.txs.find((x) => x.raw_data.contract[0]!.type === 'DelegateResourceContract')!
    const c = t.raw_data.contract[0]!
    const lie = { ...t, raw_data: { ...t.raw_data, contract: [{ ...c, parameter: { ...c.parameter, value: { ...c.parameter.value, balance: 1 } } }] } }
    expect(() => verifyRawTransaction(lie)).toThrow(/balance/)
    // and is described with its decoded fields, not as "not decoded"
    expect(describeTransaction(t, { now: 0 }).warnings.find((w) => w.code === 'undecoded')?.message).toMatch(/decoded fields: .*balance=/)
  })

  it('encodeRawData fixtures of a schema-less type still verify', () => {
    const raw = { contract: [{ type: 'VoteWitnessContract', parameter: { value: { owner_address: vote.raw_data.contract[0]!.parameter.value.owner_address, votes: [{ vote_address: 'x', vote_count: 1 }] }, type_url: 'type.googleapis.com/protocol.VoteWitnessContract' } }], ref_block_bytes: 'a1b2', ref_block_hash: '0011223344556677', expiration: 1 }
    const hex = bytesToHex(encodeRawData(raw))
    expect(() => verifyRawTransaction({ txID: bytesToHex(sha256(hexToBytes(hex))), raw_data_hex: hex, raw_data: raw })).not.toThrow()
  })
})
