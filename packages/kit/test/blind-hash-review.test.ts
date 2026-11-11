import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
// wallet-evm is not a kit devDependency; its built dist is imported by path (offline: no provider, chainId fixed).
import { WalletManagerEvm } from '../../wallet-evm/dist/index.js'
import { utf8Bytes, utf8Length } from '../src/message-bytes.js'
import { PolicyViolationError, Wallet, applyPolicies, type Policies, type WriteIntent } from '../src/index.js'

// SDK-303 review: three ways the blind hash rule did not see 32 signed bytes.
// 1. A container that is neither a string nor a Uint8Array of this realm (an array of numbers, a Uint8ClampedArray,
//    a Uint16Array, an array-like, a Uint8Array from another realm) was a plain message — and wallet-evm hands any
//    non-string to viem as `{ raw }`, which reads an array-like by index: exactly those 32 bytes were signed.
// 2. The rule looked at the spelling of the chain the account was asked for (`eip155:`): an account asked for by
//    namespace (`getAccount('eip155')`), or registered under another key, skipped it in every form.
// 3. The length was measured with the kit's UTF-8 encoder, the signature made with the runtime's. The account gets the
//    caller's string as it is; a string on which UTF-8 encoders can disagree (one with a lone surrogate) is refused
//    (see blind-hash-polyfill.test.ts for the Hermes TextEncoder polyfill, which disagrees on exactly those).

const SEED = 'test test test test test test test test test test test junk'
const CHAIN = 'eip155:1'
const TREASURY = '0x1111111111111111111111111111111111111111'
const D = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 0x52) & 0xff)
const HEX = `0x${Array.from(D, (b) => b.toString(16).padStart(2, '0')).join('')}`

const mock = () => createMockAccount({ chain: CHAIN, address: '0x5555555555555555555555555555555555555555' })
const seen = () => { const intents: WriteIntent[] = []; return { intents, confirm: vi.fn(async (i: WriteIntent) => { intents.push(i); return true }) } }

/** 32 bytes in a container whose bytes a signer may read in its own way (or not at all). */
const CONTAINERS: Array<[string, () => unknown]> = [
  ['an array of 32 numbers', () => Array.from(D)],
  ['a Uint8ClampedArray(32)', () => new Uint8ClampedArray(D)],
  ['a Uint16Array(32) of byte values', () => Uint16Array.from(D)],
  ['an Int8Array(32)', () => new Int8Array(D.buffer.slice(0))],
  ['an array-like { length: 32 }', () => Object.assign({ length: 32 }, Array.from(D))],
  ['an ArrayBuffer(32)', () => D.buffer.slice(0)],
  ['a DataView over 32 bytes', () => new DataView(D.buffer.slice(0))],
  ['{ raw: Uint8Array(32) }', () => ({ raw: D })],
  ['{ raw: 0x + 64 hex }', () => ({ raw: HEX })],
  ['a plain object faking the Uint8Array tag', () => Object.assign({ length: 32, [Symbol.toStringTag]: 'Uint8Array' }, Array.from(D))],
  ['a number', () => 42],
  ['undefined', () => undefined],
]

describe('SDK-303 review: an EVM sign() takes a string or a Uint8Array, nothing else', () => {
  it.each(CONTAINERS)('%s: refused before any rule or confirm, with or without policies; the account never sees it', async (_name, make) => {
    for (const policies of [{}, { confirm: vi.fn(async () => true) }, { allowlist: { [CHAIN]: [TREASURY] } }]) {
      const account = mock()
      const err = await applyPolicies(account, policies).sign(make() as never).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PolicyViolationError)
      expect(err).toMatchObject({ policy: 'method', message: expect.stringMatching(/string or a Uint8Array/) })
      expect(account.calls.filter((c) => c.method === 'sign')).toEqual([])
      if ('confirm' in policies) expect(policies.confirm).not.toHaveBeenCalled()
    }
  })

  it('a Uint8Array from another realm is bytes: 32 are a blind hash (allowlist refuses), 31 a message', async () => {
    const foreign = vm.runInNewContext(`new Uint8Array([${Array.from(D)}])`) as Uint8Array
    expect(foreign instanceof Uint8Array).toBe(false)
    await expect(applyPolicies(mock(), { allowlist: { [CHAIN]: [TREASURY] } }).sign(foreign)).rejects.toThrow(/allowlist/)
    const { intents, confirm } = seen()
    const account = mock()
    const g = applyPolicies(account, { confirm })
    await g.sign(foreign)
    await g.sign(vm.runInNewContext('new Uint8Array(31)') as Uint8Array)
    expect(intents.map((i) => [i.kind, i.blindHashForm])).toEqual([['typedData', 'bytes'], ['message', undefined]])
    // The account is handed a Uint8Array of this realm with the same bytes.
    const handed = account.calls.filter((c) => c.method === 'sign').map((c) => c.args[0])
    expect(handed[0]).toBeInstanceOf(Uint8Array)
    expect(Array.from(handed[0] as Uint8Array)).toEqual(Array.from(D))
  })

  it('a Node Buffer of 32 is bytes; a subclass whose length getter lies is measured on its elements', async () => {
    class Lying extends Uint8Array { override get length() { return 31 } }
    const { intents, confirm } = seen()
    const account = mock()
    const g = applyPolicies(account, { confirm })
    await g.sign(Buffer.from(D))
    await g.sign(new Lying(D))
    expect(intents.map((i) => i.blindHashForm)).toEqual(['bytes', 'bytes'])
    // Handed as a plain copy of the 32 elements: what was measured.
    for (const c of account.calls.filter((c) => c.method === 'sign')) {
      expect(Object.getPrototypeOf(c.args[0])).toBe(Uint8Array.prototype)
      expect(Array.from(c.args[0] as Uint8Array)).toEqual(Array.from(D))
    }
  })

  it('a typed array is read off the argument itself, never through its species constructor (round 3)', async () => {
    // An Int8Array whose species is Uint8Array: a snapshot made through slice() would be a Uint8Array. Refused.
    class Disguised extends Int8Array { static get [Symbol.species]() { return Uint8Array } }
    const confirm = vi.fn(async () => true)
    const refusedAccount = mock()
    const err = await applyPolicies(refusedAccount, { confirm }).sign(new Disguised(D.buffer.slice(0)) as never).catch((e: unknown) => e)
    expect(err).toMatchObject({ policy: 'method', message: expect.stringMatching(/string or a Uint8Array/) })
    expect(confirm).not.toHaveBeenCalled()
    expect(refusedAccount.calls.filter((c) => c.method === 'sign')).toEqual([])
    // 31 bytes whose species pads a copy to 32: counted and handed as the 31 they are, a message.
    function Padded32(this: unknown, _n: number) { return new Uint8Array(32) }
    class Padding extends Uint8Array { static get [Symbol.species]() { return Padded32 as unknown as Uint8ArrayConstructor } }
    // 32 bytes whose species throws: never run, still the blind hash it is.
    class Throwing extends Uint8Array { static get [Symbol.species](): Uint8ArrayConstructor { throw new Error('species read') } }
    const { intents, confirm: seenConfirm } = seen()
    const account = mock()
    const g = applyPolicies(account, { confirm: seenConfirm })
    await g.sign(new Padding(D.subarray(0, 31)))
    await g.sign(new Throwing(D))
    expect(intents.map((i) => [i.kind, i.blindHashForm])).toEqual([['message', undefined], ['typedData', 'bytes']])
    const handed = account.calls.filter((c) => c.method === 'sign').map((c) => c.args[0] as Uint8Array)
    expect(handed.map((h) => [Object.getPrototypeOf(h) === Uint8Array.prototype, h.length])).toEqual([[true, 31], [true, 32]])
    expect(Array.from(handed[0]!)).toEqual(Array.from(D.subarray(0, 31)))
    // confirm's copy of the argument is the bytes measured, too.
    expect((intents[0]!.raw as Uint8Array).length).toBe(31)
  })

  it('the account is handed the caller\'s string as it is, a Uint8Array as a plain copy of its bytes', async () => {
    const account = mock()
    const g = applyPolicies(account, {})
    const strings = ['hello', 'é'.repeat(16), '🦊'.repeat(8), HEX, '']
    const arrays = [D, new Uint8Array(0)]
    for (const m of [...strings, ...arrays]) await g.sign(m)
    const handed = account.calls.filter((c) => c.method === 'sign').map((c) => c.args[0])
    expect(handed.slice(0, strings.length)).toEqual(strings)
    for (const [i, a] of arrays.entries()) {
      const h = handed[strings.length + i] as Uint8Array
      expect(Object.getPrototypeOf(h)).toBe(Uint8Array.prototype)
      expect(h).not.toBe(a)
      expect(Array.from(h)).toEqual(Array.from(a))
    }
    // confirm still sees what the caller sent, not the bytes.
    const { intents, confirm } = seen()
    await applyPolicies(mock(), { confirm }).sign('é'.repeat(16))
    expect(intents[0]!.raw).toBe('é'.repeat(16))
  })

  it('other chains are untouched: their sign() gets the argument as it came', async () => {
    const account = createMockAccount({ chain: 'tron:0x2b6653dc', address: 'TXYZ' })
    await applyPolicies(account, {}).sign('é'.repeat(16))
    expect(account.calls.find((c) => c.method === 'sign')!.args[0]).toBe('é'.repeat(16))
  })

  it('utf8Length counts what utf8Bytes writes, and both match TextEncoder', () => {
    const samples = ['', 'a', 'é', '€', '🦊', '﻿', '\uD83E', '\uDD8A', '\uDD8A\uD83E', 'a\uD83Eb', '🦊\uD83E', '߿ࠀ￿', `\uD83Ea${'b'.repeat(29)}`, 'x'.repeat(1000)]
    for (const s of samples) {
      expect(utf8Length(s), JSON.stringify(s)).toBe(new TextEncoder().encode(s).length)
      expect(Array.from(utf8Bytes(s)), JSON.stringify(s)).toEqual(Array.from(new TextEncoder().encode(s)))
    }
    // Random code units, lone surrogates included.
    let seed = 7
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648)
    for (let n = 0; n < 2000; n++) {
      const s = String.fromCharCode(...Array.from({ length: next() % 24 }, () => (next() % 4 === 0 ? 0xd800 + (next() % 0x800) : next() % 0x10000)))
      expect(Array.from(utf8Bytes(s)), JSON.stringify(s)).toEqual(Array.from(new TextEncoder().encode(s)))
    }
  })
})

describe('SDK-303 review: the account\'s namespace decides, not the spelling of the chain asked for', () => {
  const evm = async (registerAs: string, askFor: string, policies: Policies) => {
    const w = new Wallet(SEED, { policies })
    w.registerWallet(registerAs, WalletManagerEvm as never, { chainId: 1 })
    return (await w.getAccount(askFor)) as unknown as { sign(m: string | Uint8Array): Promise<string>; chain: string }
  }
  const FORMS: Array<[string, string | Uint8Array]> = [['bytes', D], ['hex', HEX], ['text', 'é'.repeat(16)]]

  for (const [registerAs, askFor] of [['eip155', 'eip155'], ['evm', 'evm'], ['eip155', CHAIN]] as const) {
    it(`registered as '${registerAs}', asked for '${askFor}': an allowlist refuses every form, confirm sees blindHash`, async () => {
      const allow = await evm(registerAs, askFor, { allowlist: { eip155: [TREASURY] } })
      expect(allow.chain).toBe(CHAIN)
      for (const [form, m] of FORMS) await expect(allow.sign(m), form).rejects.toThrow(/allowlist/)
      const { intents, confirm } = seen()
      const asked = await evm(registerAs, askFor, { confirm })
      for (const [, m] of FORMS) await asked.sign(m)
      expect(intents.map((i) => i.blindHashForm)).toEqual(['bytes', 'hex', 'text'])
      for (const i of intents) expect(i).toMatchObject({ kind: 'typedData', blindHash: true, destinationUnknown: true })
      // A message of other lengths is still a message, signed under the allowlist.
      expect(await allow.sign('hello')).toMatch(/^0x/)
    })
  }

  it('applyPolicies(account, policies, \'eip155\') on a wallet-evm account', async () => {
    const plain = await new WalletManagerEvm(SEED, { chainId: 1 }).getAccount(0)
    const g = applyPolicies(plain, { allowlist: { eip155: [TREASURY] } }, 'eip155')
    for (const [form, m] of FORMS) await expect(g.sign(m), form).rejects.toThrow(/allowlist/)
    expect(await g.sign('hello')).toBe(await plain.sign('hello'))
  })

  it('a mock EVM account asked for by namespace', async () => {
    const { intents, confirm } = seen()
    await applyPolicies(mock(), { confirm }, 'eip155').sign('é'.repeat(16))
    await applyPolicies(mock(), { confirm }, 'evm').sign(D)
    expect(intents.map((i) => i.blindHashForm)).toEqual(['text', 'bytes'])
  })
})
