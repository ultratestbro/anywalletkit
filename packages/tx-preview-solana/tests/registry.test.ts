import { describe, expect, it } from 'vitest'
import { DecoderRegistry, defaultRegistry, decodeInstruction, TOKEN_PROGRAM } from '../src/index.js'

describe('DecoderRegistry', () => {
  it('refuses a second decoder for a program unless replace is set, and with() leaves the defaults alone', () => {
    const custom = { programAddress: TOKEN_PROGRAM, programName: 'mine', decode: () => ({ name: 'X' }) }
    expect(() => new DecoderRegistry(defaultRegistry.decoders).register(custom)).toThrow(/already registered/)
    const replaced = defaultRegistry.with([custom], { replace: true })
    expect(replaced.get(TOKEN_PROGRAM)!.programName).toBe('mine')
    expect(defaultRegistry.get(TOKEN_PROGRAM)!.programName).toBe('Token Program')
  })

  it('an unknown program keeps its raw accounts and data; a throwing decoder is reported, not thrown', () => {
    const ix = { programAddress: 'Prog1111111111111111111111111111111111111111', accounts: [{ address: 'Acct1111111111111111111111111111111111111111', signer: false, writable: true }], data: new Uint8Array([1, 2, 3]) }
    const unknown = decodeInstruction(ix, 0)
    expect(unknown).toMatchObject({ decoded: false, programName: null, name: null, data: 'AQID', accounts: [{ address: ix.accounts[0]!.address, name: null }] })
    const broken = new DecoderRegistry([{ programAddress: ix.programAddress, programName: 'Broken', decode: () => { throw new Error('bad layout') } }])
    expect(decodeInstruction(ix, 0, broken)).toMatchObject({ decoded: false, programName: 'Broken', error: 'bad layout' })
  })
})
