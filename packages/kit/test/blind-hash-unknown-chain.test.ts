import { describe, expect, it, vi } from 'vitest'
// wallet-evm is not a kit devDependency; its built dist is imported by path.
import { WalletManagerEvm } from '../../wallet-evm/dist/index.js'
import { PolicyViolationError, Wallet, applyPolicies, type Policies, type WriteIntent } from '../src/index.js'

// SDK-303 round 2 (D4): an EVM account whose chain is not known yet (wallet-evm without `chainId` reports
// "eip155:unknown"), asked for by namespace or wrapped without a chain, under an exact-key allowlist
// ({ 'eip155:1': [...] }). signTypedData refused safely, but a blind hash sign() — text, hex or bytes — was
// signed without confirm: the guard took every `sign` for a message, which needs no chain, so the chain was never
// learned and no rule matched. A blind hash is now decided before the chain: its chain is learned from the
// provider, or the write is refused ('chain') when it cannot be.

const SEED = 'test test test test test test test test test test test junk'
const TREASURY = '0x1111111111111111111111111111111111111111'
const D = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 0x52) & 0xff)
const HEX = `0x${Array.from(D, (b) => b.toString(16).padStart(2, '0')).join('')}`
const TEXT = 'é'.repeat(16)
const FORMS: Array<[string, string | Uint8Array]> = [['bytes', D], ['hex', HEX], ['text', TEXT]]
const TYPED = {
  domain: { name: 'X', version: '1', chainId: 1, verifyingContract: '0x3333333333333333333333333333333333333333' },
  types: { Thing: [{ name: 'a', type: 'uint256' }] }, primaryType: 'Thing', message: { a: 1n },
}

/** An EIP-1193 provider that only knows its chain id (the guard asks nothing else before a message signature). */
const provider = (chainId: string) => ({
  request: vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return chainId
    throw new Error(`${method}: not in this test`)
  }),
})

type Signing = { sign(m: string | Uint8Array): Promise<string>; signTypedData(t: unknown): Promise<string>; chain: string }

/** The three ways an account reaches the rules without a concrete chain. */
const ENTRIES: Array<[string, (config: object, policies: Policies) => Promise<Signing>]> = [
  ["Wallet.getAccount('eip155')", async (config, policies) => {
    const w = new Wallet(SEED, { policies })
    w.registerWallet('eip155', WalletManagerEvm as never, config)
    return (await w.getAccount('eip155')) as unknown as Signing
  }],
  ['applyPolicies(account, policies)', async (config, policies) => applyPolicies(await new WalletManagerEvm(SEED, config).getAccount(0), policies) as unknown as Signing],
  ["applyPolicies(account, policies, 'eip155')", async (config, policies) => applyPolicies(await new WalletManagerEvm(SEED, config).getAccount(0), policies, 'eip155') as unknown as Signing],
]

const allowlist = { 'eip155:1': [TREASURY] }
const outcome = (p: Promise<unknown>) => p.then(() => 'signed', (e: unknown) => (e instanceof PolicyViolationError ? e.policy : String(e)))

describe('SDK-303 round 2: a blind hash sign() on an EVM account whose chain is not known yet', () => {
  for (const [entry, open] of ENTRIES) {
    describe(entry, () => {
      it('offline, no chainId: every form is refused (chain), with or without confirm — as signTypedData is', async () => {
        for (const withConfirm of [false, true]) {
          const confirm = vi.fn(async () => true)
          const account = await open({}, withConfirm ? { allowlist, confirm } : { allowlist })
          expect(account.chain).toBe('eip155:unknown')
          for (const [form, m] of FORMS) expect(await outcome(account.sign(m)), form).toBe('chain')
          expect(await outcome(account.signTypedData(TYPED))).toBe('chain')
          expect(confirm).not.toHaveBeenCalled()
          // A message of any other length needs no chain: no list applies to it.
          expect(await outcome(account.sign('hello'))).toBe('signed')
        }
      })

      it('with a provider, no chainId: the chain is learned and the eip155:1 allowlist refuses every form without confirm', async () => {
        for (const [form, m] of FORMS) {
          const rpc = provider('0x1')
          const account = await open({ provider: rpc }, { allowlist })
          expect(account.chain, form).toBe('eip155:unknown')
          expect(await outcome(account.sign(m)), form).toBe('allowlist')
          expect(rpc.request.mock.calls.map(([r]) => r.method), form).toContain('eth_chainId')
        }
      })

      it('with a provider, no chainId, with confirm: the hex and bytes forms are still refused before confirm', async () => {
        for (const [form, m] of FORMS.filter(([f]) => f !== 'text')) {
          const confirm = vi.fn(async () => true)
          const account = await open({ provider: provider('0x1') }, { allowlist, confirm })
          expect(await outcome(account.sign(m)), form).toBe('allowlist')
          expect(confirm).not.toHaveBeenCalled()
        }
      })

      it('with a provider, no chainId, with confirm: the text form goes to confirm on the learned chain (danger screen)', async () => {
        const intents: WriteIntent[] = []
        const account = await open({ provider: provider('0x1') }, { allowlist, confirm: async (i) => { intents.push(i); return true } })
        const signature = await account.sign(TEXT)
        expect(account.chain).toBe('eip155:1')
        expect(intents).toHaveLength(1)
        expect(intents[0]).toMatchObject({ kind: 'typedData', message: false, blindHash: true, blindHashForm: 'text', destinations: [], destinationUnknown: true, raw: TEXT })
        expect(signature).toBe(await (await new WalletManagerEvm(SEED, { chainId: 1 }).getAccount(0)).sign(TEXT))
        // Declined there: nothing is signed.
        const declined = await open({ provider: provider('0x1') }, { allowlist, confirm: async () => false })
        await expect(declined.sign(TEXT)).rejects.toMatchObject({ name: 'UserRejectedError' })
      })

      it('with a provider on another chain: the eip155:1 allowlist is not its rule, confirm sees the blind hash', async () => {
        const intents: WriteIntent[] = []
        const account = await open({ provider: provider('0x89') }, { allowlist, confirm: async (i) => { intents.push(i); return true } })
        for (const [form, m] of FORMS) expect(await outcome(account.sign(m)), form).toBe('signed')
        expect(account.chain).toBe('eip155:137')
        expect(intents.map((i) => i.blindHashForm)).toEqual(['bytes', 'hex', 'text'])
        for (const i of intents) expect(i).toMatchObject({ kind: 'typedData', blindHash: true, destinationUnknown: true })
      })
    })
  }

  it('a provider that fails is no reason to skip the check: the error comes back, nothing is signed', async () => {
    const rpc = { request: vi.fn(async () => { throw new Error('rpc down') }) }
    const account = applyPolicies(await new WalletManagerEvm(SEED, { provider: rpc as never, retries: 0 }).getAccount(0), { allowlist }) as unknown as Signing
    for (const [form, m] of FORMS) await expect(account.sign(m), form).rejects.toThrow()
  })

  it('a namespace allowlist needs no chain: every form is refused (allowlist) on an offline account', async () => {
    for (const [, open] of ENTRIES) {
      const account = await open({}, { allowlist: { eip155: [TREASURY] } })
      for (const [form, m] of FORMS) expect(await outcome(account.sign(m)), form).toBe('allowlist')
    }
  })
})
