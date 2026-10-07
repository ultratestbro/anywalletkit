import '../src/buffer-global.js'
import { describe, expect, it } from 'vitest'
import { Buffer } from 'buffer'
import { Address, beginCell } from '@ton/core'
import { JETTON_TRANSFER_OP, commentCell, decodeBody, describeTransaction } from '../src/index.js'

const UQ = 'UQAockb65N9NqreZHrYfhipG94Q_gZYTBkV0mvaopLEEzOgi' // non-bounceable, mainnet
const EQ = Address.parse(UQ).toString({ bounceable: true })
const UQ_TEST = Address.parse(UQ).toString({ bounceable: false, testOnly: true })
const RAW = Address.parse(UQ).toRawString()

function jettonBody(opts: { forwardTonAmount?: bigint; forward?: 'none' | 'comment' | 'cell'; custom?: boolean } = {}) {
  const b = beginCell()
    .storeUint(JETTON_TRANSFER_OP, 32).storeUint(1n, 64).storeCoins(1_000_000n)
    .storeAddress(Address.parse(UQ)).storeAddress(Address.parse(UQ))
    .storeMaybeRef(opts.custom ? beginCell().storeUint(1, 8).endCell() : null)
    .storeCoins(opts.forwardTonAmount ?? 1n)
  const fwd = opts.forward === 'comment' ? commentCell('hey') : opts.forward === 'cell' ? beginCell().storeUint(0x12345678, 32).endCell() : null
  return b.storeMaybeRef(fwd).endCell()
}

describe('describeTransaction (offline)', () => {
  it('plain and commented TON transfers; raw addresses default to bounceable', () => {
    const d = describeTransaction([{ to: UQ, value: 10n }, { to: EQ, value: 20n, body: 'hello' }, { to: RAW, value: 30n }])
    expect(d.kind).toBe('ton-transfer')
    expect(d.items.map((i) => i.bounceable)).toEqual([false, true, true])
    expect(d.items[1]!.comment).toBe('hello')
    expect(d.items[2]!.to).toBe(RAW)
    expect(d.warnings).toEqual([])
  })

  it('jetton transfer bodies: forward payload kinds, custom payload, large-forward warning', () => {
    const d = describeTransaction([
      { to: EQ, value: 50_000_000n, body: jettonBody({ forward: 'comment' }) },
      { to: EQ, value: 50_000_000n, body: jettonBody({ forward: 'cell', custom: true, forwardTonAmount: 600_000_000n }) },
      { to: EQ, value: 50_000_000n, bodyBoc: jettonBody().toBoc().toString('base64') },
    ])
    expect(d.kind).toBe('jetton-transfer')
    expect(d.items[0]!.jetton).toMatchObject({ forwardPayload: 'comment', forwardComment: 'hey', hasCustomPayload: false, amount: 1_000_000n })
    expect(d.items[1]!.jetton).toMatchObject({ forwardPayload: 'cell', hasCustomPayload: true, forwardTonAmount: 600_000_000n })
    expect(d.items[2]!.jetton).toMatchObject({ forwardPayload: 'none' })
    expect(d.warnings).toEqual([{ code: 'large-forward-amount', message: expect.stringContaining('0.5 TON'), index: 1 }])
  })

  it('contract calls: op code, non-bounceable warning, unknown body, mixed kind', () => {
    const call = beginCell().storeUint(0xabcdef01, 32).storeUint(5, 8).endCell()
    const d = describeTransaction([{ to: UQ, value: 1n, body: call }, { to: EQ, value: 1n }, { to: EQ, value: 1n, body: beginCell().storeUint(1, 3).endCell() }])
    expect(d.kind).toBe('mixed')
    expect(d.items[0]).toMatchObject({ kind: 'contract-call', op: '0xabcdef01' })
    expect(d.warnings.map((w) => w.code)).toEqual(['non-bounceable-contract-call', 'unknown-body'])
  })

  it('network flag, zero value, exotic workchain, invalid address and bad bodyBoc become warnings, never throws', () => {
    const d = describeTransaction([
      { to: UQ_TEST, value: 1n },
      { to: UQ, value: 0n },
      { to: new Address(3, Buffer.alloc(32, 2)).toString(), value: 1n },
      { to: 'nope', value: 1n },
      { to: UQ, value: 1n, bodyBoc: '!!' },
    ], { network: 'mainnet' })
    expect(d.warnings.map((w) => [w.code, w.index])).toEqual([
      ['testnet-address', 0], ['zero-value', 1], ['exotic-workchain', 2], ['unknown-body', 3], ['unknown-body', 4],
    ])
    expect(describeTransaction({ to: UQ, value: 1n }, { network: 'testnet' }).warnings[0]!.code).toBe('mainnet-address')
    expect(describeTransaction({ to: UQ, value: 1n }).warnings).toEqual([]) // no network given → no flag check
  })

  it('stateInit is reported; a non-V5R1 cell is flagged', () => {
    const init = beginCell().storeUint(0, 2).storeMaybeRef(null).storeMaybeRef(null).storeMaybeRef(null).endCell()
    expect(describeTransaction({ to: EQ, value: 1n, stateInit: init.toBoc().toString('base64') }).items[0]!.hasStateInit).toBe(true)
    const d = describeTransaction(beginCell().storeUint(1, 32).endCell())
    expect(d.items).toEqual([])
    expect(d.warnings[0]!.code).toBe('unknown-body')
  })

  it('decodeBody', () => {
    expect(decodeBody(beginCell().endCell())).toEqual({ type: 'empty' })
    expect(decodeBody(commentCell('yo'))).toEqual({ type: 'comment', text: 'yo' })
    expect(decodeBody(beginCell().storeUint(7, 32).endCell())).toEqual({ type: 'op', op: 7 })
    expect(decodeBody(beginCell().storeUint(1, 4).endCell())).toEqual({ type: 'unknown' })
  })
})
