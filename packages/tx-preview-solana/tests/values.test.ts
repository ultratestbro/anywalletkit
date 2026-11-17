import { describe, expect, it } from 'vitest'
import { decodeInstruction, defaultRegistry, MEMO_PROGRAM, toPreviewValue, type InstructionDecoder } from '../src/index.js'
import { utf8ToString } from '../src/values.js'

describe('utf8ToString (memo text without TextDecoder)', () => {
  it('reads every valid string exactly as TextDecoder does', () => {
    let x = 0x9e3779b9
    const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x }
    const enc = new TextEncoder()
    for (let n = 0; n < 500; n++) {
      let s = ''
      for (let k = next() % 40; k > 0; k--) {
        const r = next() % 4
        const cp = r === 0 ? next() % 0x80 : r === 1 ? 0x80 + (next() % 0x780) : r === 2 ? 0x800 + (next() % 0xd000) : 0x10000 + (next() % 0x100000)
        s += String.fromCodePoint(cp >= 0xd800 && cp <= 0xdfff ? 0x41 : cp)
      }
      const bytes = enc.encode(s)
      expect(utf8ToString(bytes)).toBe(new TextDecoder().decode(bytes))
    }
  })

  it('invalid bytes read as U+FFFD, one per byte; overlongs, surrogates and > U+10FFFF are invalid', () => {
    expect(utf8ToString(new Uint8Array([0x61, 0xff, 0x62]))).toBe('a�b')
    expect(utf8ToString(new Uint8Array([0xc0, 0xaf]))).toBe('��') // overlong '/'
    expect(utf8ToString(new Uint8Array([0xed, 0xa0, 0x80]))).toBe('���') // U+D800
    expect(utf8ToString(new Uint8Array([0xf4, 0x90, 0x80, 0x80]))).toBe('����') // U+110000
    expect(utf8ToString(new Uint8Array([0xe2, 0x82]))).toBe('��') // truncated
    expect(utf8ToString(new Uint8Array([]))).toBe('')
  })

  it('a memo instruction decodes through it', () => {
    const data = new TextEncoder().encode('pay 🍕 #42')
    expect(decodeInstruction({ programAddress: MEMO_PROGRAM, accounts: [], data }, 0)).toMatchObject({ name: 'Memo', args: { text: 'pay 🍕 #42' } })
  })
})

describe('toPreviewValue', () => {
  it('unwraps options, renames __kind, drops discriminators, turns bytes into base64', () => {
    expect(toPreviewValue({ discriminator: 3, extensionDiscriminator: 1, a: { __option: 'Some', value: 5n }, b: { __option: 'None' }, c: { __kind: 'Key', fields: ['x'] }, d: new Uint8Array([1, 2, 3]) }))
      .toEqual({ a: 5n, b: null, c: { kind: 'Key', fields: ['x'] }, d: 'AQID' })
  })

  it('stops at depth 16 instead of recursing forever', () => {
    let v: Record<string, unknown> = {}
    const root = v
    for (let i = 0; i < 30; i++) { const n = {}; v.n = n; v = n }
    expect(JSON.stringify(toPreviewValue(root))).toContain('null')
  })
})

describe('the README\'s custom decoder', () => {
  it('registers next to the defaults and decodes its program', () => {
    const counterDecoder: InstructionDecoder = {
      programAddress: 'Count3rProgram1111111111111111111111111111',
      programName: 'Counter',
      decode(ix) {
        if (ix.data[0] !== 1 || ix.data.length !== 9) return null
        const by = new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(1, true)
        return { name: 'Increment', args: { by }, accountNames: ['counter', 'authority'] }
      },
    }
    const registry = defaultRegistry.with([counterDecoder])
    const data = new Uint8Array(9)
    data[0] = 1
    data[1] = 7
    const accounts = [{ address: 'Acct1111111111111111111111111111111111111111', signer: false, writable: true }, { address: 'Auth1111111111111111111111111111111111111111', signer: true, writable: false }]
    expect(decodeInstruction({ programAddress: counterDecoder.programAddress, accounts, data }, 0, registry)).toMatchObject({
      programName: 'Counter', name: 'Increment', args: { by: 7n }, accounts: [{ name: 'counter' }, { name: 'authority' }],
    })
    expect(decodeInstruction({ programAddress: counterDecoder.programAddress, accounts, data: new Uint8Array([2]) }, 0, registry)).toMatchObject({ decoded: false, programName: 'Counter' })
    expect(defaultRegistry.has(counterDecoder.programAddress)).toBe(false)
  })
})
