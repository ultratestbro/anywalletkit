import { describe, expect, it, vi } from 'vitest'
import { UserRejectedError } from '@anywalletkit/core'
import { createMockAccount } from '@anywalletkit/conformance'
// wallet-evm is not a kit devDependency; its built dist is imported by path.
import { WalletManagerEvm } from '../../wallet-evm/dist/index.js'
import { PolicyViolationError, Wallet, applyPolicies, type Policies, type WriteIntent } from '../src/index.js'

// SDK-303 round 3 review: only a function is a `confirm` hook. Under an allowlist, 32-byte text goes to `confirm` when
// there is one, and is refused when there is none. The allowlist asked `policies.confirm !== undefined` while the call
// asked `policies.confirm && …`, so a JS app's `confirm: uiReady ? fn : null` (or false, 0, '') skipped the allowlist
// for the text form and then ran no hook: the 32 bytes were signed with no rule and no screen. The guard now reads the
// hook once: a function, or none; any other value refuses the write.

const SEED = 'test test test test test test test test test test test junk'
const T = '0x1111111111111111111111111111111111111111'
const D = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 0x52) & 0xff)
const HEX = `0x${Array.from(D, (b) => b.toString(16).padStart(2, '0')).join('')}`
const TEXT = 'é'.repeat(16)
const FORMS: Array<[string, string | Uint8Array]> = [['bytes', D], ['hex', HEX], ['text', TEXT]]
/** What a JS app (no type checks) may pass for "no confirm hook". */
const NONE: unknown[] = [undefined, null, false, 0, '', Number.NaN]
/** Values that are not functions and not "none": the hook cannot be asked. */
const BROKEN: unknown[] = [true, 1, 'yes', {}, [], { confirm: () => true }]

const LISTS: Array<[string, Pick<Policies, 'allowlist' | 'blocklist'>, 'allowlist' | 'blocklist']> = [
  ['allowlist { eip155 }', { allowlist: { eip155: [T] } }, 'allowlist'],
  ["allowlist { 'eip155:1' }", { allowlist: { 'eip155:1': [T] } }, 'allowlist'],
  ['blocklist { eip155 }', { blocklist: { eip155: [T] } }, 'blocklist'],
  ["blocklist { 'eip155:1' }", { blocklist: { 'eip155:1': [T] } }, 'blocklist'],
]

const outcome = (p: Promise<unknown>) => p.then(() => 'signed', (e: unknown) => (e instanceof PolicyViolationError ? e.policy : e instanceof TypeError ? 'TypeError' : String(e)))
const policiesWith = (lists: object, confirm: unknown) => ({ ...lists, confirm }) as Policies

describe('SDK-303 round 3: only a function is a confirm hook', () => {
  for (const confirm of NONE) {
    it(`confirm ${String(confirm) || "''"}: every list refuses every form, as with no confirm key; the account is never reached`, async () => {
      for (const [name, lists, policy] of LISTS) {
        const account = createMockAccount({ chain: 'eip155:1' })
        const guarded = applyPolicies(account, policiesWith(lists, confirm), 'eip155:1')
        for (const [form, m] of FORMS) expect(await outcome(guarded.sign(m)), `${name} ${form}`).toBe(policy)
        expect(account.calls.filter((c) => c.method === 'sign')).toEqual([])
      }
    })
  }

  it('real wallet-evm (chainId 1, getAccount(eip155:1)), allowlist, confirm null / false / 0 / \'\': the text form is refused (allowlist), nothing is signed', async () => {
    for (const confirm of NONE) {
      for (const lists of [{ allowlist: { eip155: [T] } }, { allowlist: { 'eip155:1': [T] } }]) {
        const w = new Wallet(SEED, { policies: policiesWith(lists, confirm) })
        w.registerWallet('eip155', WalletManagerEvm as never, { chainId: 1 })
        const account = (await w.getAccount('eip155:1')) as unknown as { sign(m: string | Uint8Array): Promise<string> }
        for (const [form, m] of FORMS) expect(await outcome(account.sign(m)), `${String(confirm)} ${form}`).toBe('allowlist')
        // A message of any other length is no blind hash: no list applies to it.
        expect(await outcome(account.sign('hello'))).toBe('signed')
      }
    }
  })

  it('no lists and no hook (null, false, 0, \'\'): every form is signed, as with no confirm key', async () => {
    for (const confirm of NONE) {
      const account = createMockAccount({ chain: 'eip155:1' })
      const guarded = applyPolicies(account, policiesWith({}, confirm), 'eip155:1')
      for (const [form, m] of FORMS) expect(await outcome(guarded.sign(m)), form).toBe('signed')
    }
  })

  it('a value that is not a function and not "none" refuses every write (TypeError) before any rule; nothing is signed', async () => {
    for (const confirm of BROKEN) {
      for (const lists of [{}, { allowlist: { eip155: [T] } }, { blocklist: { eip155: [T] } }]) {
        const account = createMockAccount({ chain: 'eip155:1' })
        const guarded = applyPolicies(account, policiesWith(lists, confirm), 'eip155:1')
        for (const [form, m] of FORMS) expect(await outcome(guarded.sign(m)), `${JSON.stringify(confirm)} ${form}`).toBe('TypeError')
        expect(await outcome(guarded.sign('hello'))).toBe('TypeError')
        expect(await outcome(guarded.sendTransaction({ to: T, value: 1n }))).toBe('TypeError')
        expect(account.calls.filter((c) => c.method === 'sign' || c.method === 'sendTransaction' || c.method === 'quoteSendTransaction')).toEqual([])
      }
    }
  })

  it('a function hook: text goes to it under an allowlist, hex and bytes do not; it is called on the policies object', async () => {
    const intents: WriteIntent[] = []
    const policies: Policies = {
      allowlist: { eip155: [T] },
      confirm: vi.fn(function (this: unknown, i: WriteIntent) { expect(this).toBe(policies); intents.push(i); return true }),
    }
    const account = createMockAccount({ chain: 'eip155:1' })
    const guarded = applyPolicies(account, policies, 'eip155:1')
    expect(await outcome(guarded.sign(TEXT))).toBe('signed')
    expect(intents[0]).toMatchObject({ kind: 'typedData', blindHash: true, blindHashForm: 'text', destinationUnknown: true })
    expect(await outcome(guarded.sign(HEX))).toBe('allowlist')
    expect(await outcome(guarded.sign(D))).toBe('allowlist')
    expect(policies.confirm).toHaveBeenCalledTimes(1)
  })

  it('a hook that answers false: UserRejectedError, nothing is signed', async () => {
    const account = createMockAccount({ chain: 'eip155:1' })
    const guarded = applyPolicies(account, { allowlist: { eip155: [T] }, confirm: async () => false }, 'eip155:1')
    await expect(guarded.sign(TEXT)).rejects.toBeInstanceOf(UserRejectedError)
    expect(account.calls.filter((c) => c.method === 'sign')).toEqual([])
  })
})
