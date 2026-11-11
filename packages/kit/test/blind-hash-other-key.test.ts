import { describe, expect, it, vi } from 'vitest'
// wallet-evm is not a kit devDependency; its built dist is imported by path.
import { WalletManagerEvm } from '../../wallet-evm/dist/index.js'
import { PolicyViolationError, Wallet, applyPolicies, type Policies, type WriteIntent } from '../src/index.js'

// SDK-303 round 3. An EVM account whose chain is not known yet (wallet-evm without `chainId`: offline, or with a
// provider it has not asked yet), asked for under a key that is not a chain id of its family — a registration key
// (`registerWallet('evm', …)` + `getAccount('evm')` / `getManager('evm')`), `applyPolicies(account, p, 'ethereum')`,
// another family's id — under a namespace list `{ eip155: [...] }`: a blind hash sign() in every form, and typed
// data without `domain.chainId`, was signed with no rule applied. The rules were looked up only for the chains in
// play, and 'evm' covers no `eip155` key, so none matched; the account's own namespace rules now always apply.
// Under the same keys, a transaction was read as another chain's (its ERC-20 recipient in calldata unseen) and an
// exact-id rule was skipped for another family's concrete id: the key must be a chain id of the account's family to
// stand for its chain.

const SEED = 'test test test test test test test test test test test junk'
const T = '0x1111111111111111111111111111111111111111'
const SPENDER = '0x9999999999999999999999999999999999999999'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const D = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 0x52) & 0xff)
const HEX = `0x${Array.from(D, (b) => b.toString(16).padStart(2, '0')).join('')}`
const TEXT = 'é'.repeat(16)
const FORMS: Array<[string, string | Uint8Array]> = [['bytes', D], ['hex', HEX], ['text', TEXT]]
const PERMIT_FIELDS = [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }]
/** A USDC permit for SPENDER without `domain.chainId`: no chain in play but the account's own. */
const PERMIT_NO_CHAIN = {
  domain: { name: 'USD Coin', version: '2', verifyingContract: USDC },
  types: { Permit: PERMIT_FIELDS }, primaryType: 'Permit',
  message: { owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', spender: SPENDER, value: 10n ** 30n, nonce: 0n, deadline: 2n ** 40n },
}
const pad = (h: string) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0')

/** An EIP-1193 provider that only knows its chain id. */
const provider = (chainId: string) => ({
  request: vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return chainId
    throw new Error(`${method}: not in this test`)
  }),
})

type Signing = {
  sign(m: string | Uint8Array): Promise<string>
  signTypedData(t: unknown): Promise<string>
  signTransaction(tx: unknown): Promise<unknown>
  chain: string
}

/** Every way an EVM account reaches the rules under a key that is not a chain id of its family. */
const ENTRIES: Array<[string, (config: object, policies: Policies) => Promise<Signing>]> = [
  ["registerWallet('evm') + getAccount('evm')", async (config, policies) => {
    const w = new Wallet(SEED, { policies })
    w.registerWallet('evm', WalletManagerEvm as never, config)
    return (await w.getAccount('evm')) as unknown as Signing
  }],
  ["registerWallet('evm') + getManager('evm').getAccount(0)", async (config, policies) => {
    const w = new Wallet(SEED, { policies })
    w.registerWallet('evm', WalletManagerEvm as never, config)
    return (await w.getManager('evm').getAccount(0)) as unknown as Signing
  }],
  ...(['ethereum', 'EIP155', 'solana:mainnet'].map((key) => [`applyPolicies(account, policies, '${key}')`, async (config: object, policies: Policies) => {
    return applyPolicies(await new WalletManagerEvm(SEED, config).getAccount(0), policies, key) as unknown as Signing
  }] as [string, (config: object, policies: Policies) => Promise<Signing>])),
]

const CONFIGS: Array<[string, () => object]> = [['offline, no chainId', () => ({})], ['a provider on chain 1, no chainId', () => ({ provider: provider('0x1') })]]
const outcome = (p: Promise<unknown>) => p.then(() => 'signed', (e: unknown) => (e instanceof PolicyViolationError ? e.policy : String(e)))

describe('SDK-303 round 3: an EVM account asked for under a key of no chain of its family', () => {
  for (const [entry, open] of ENTRIES) {
    describe(entry, () => {
      for (const [configName, config] of CONFIGS) {
        it(`${configName}, allowlist { eip155 }: every form refused without confirm; with confirm text goes there, hex and bytes stay refused`, async () => {
          const allowlist = { eip155: [T] }
          const bare = await open(config(), { allowlist })
          expect(bare.chain).toBe('eip155:unknown')
          for (const [form, m] of FORMS) expect(await outcome(bare.sign(m)), form).toBe('allowlist')
          expect(await outcome(bare.signTypedData(PERMIT_NO_CHAIN))).toBe('allowlist')
          // A message of any other length is still a message: no list applies to it.
          expect(await outcome(bare.sign('hello'))).toBe('signed')
          const intents: WriteIntent[] = []
          const confirmed = await open(config(), { allowlist, confirm: async (i) => { intents.push(i); return true } })
          for (const [form, m] of FORMS) expect(await outcome(confirmed.sign(m)), form).toBe(form === 'text' ? 'signed' : 'allowlist')
          expect(intents.map((i) => i.blindHashForm)).toEqual(['text'])
          expect(intents[0]).toMatchObject({ kind: 'typedData', message: false, blindHash: true, destinationUnknown: true, raw: TEXT })
          // The intent names the account's chain, not the key it was asked for under.
          expect(intents[0]!.chain.startsWith('eip155:')).toBe(true)
        })

        it(`${configName}, blocklist { eip155 }: every form refused without confirm, confirm gets every form with confirm`, async () => {
          const blocklist = { eip155: [T] }
          const bare = await open(config(), { blocklist })
          for (const [form, m] of FORMS) expect(await outcome(bare.sign(m)), form).toBe('blocklist')
          expect(await outcome(bare.sign('hello'))).toBe('signed')
          const intents: WriteIntent[] = []
          const confirmed = await open(config(), { blocklist, confirm: async (i) => { intents.push(i); return true } })
          for (const [form, m] of FORMS) expect(await outcome(confirmed.sign(m)), form).toBe('signed')
          expect(intents.map((i) => [i.kind, i.blindHashForm])).toEqual([['typedData', 'bytes'], ['typedData', 'hex'], ['typedData', 'text']])
          // Typed data without domain.chainId: its blocklisted spender is seen.
          expect(await outcome((await open(config(), { blocklist: { eip155: [SPENDER] } })).signTypedData(PERMIT_NO_CHAIN))).toBe('blocklist')
        })
      }

      it("an exact-id allowlist { 'eip155:1' }: offline every form is refused (chain), with a provider the chain is learned and its rule applies", async () => {
        const allowlist = { 'eip155:1': [T] }
        for (const withConfirm of [false, true]) {
          const confirm = vi.fn(async () => true)
          const offline = await open({}, withConfirm ? { allowlist, confirm } : { allowlist })
          for (const [form, m] of FORMS) expect(await outcome(offline.sign(m)), form).toBe('chain')
          expect(await outcome(offline.signTypedData(PERMIT_NO_CHAIN))).toBe('chain')
          expect(confirm).not.toHaveBeenCalled()
          expect(await outcome(offline.sign('hello'))).toBe('signed')
        }
        const online = await open({ provider: provider('0x1') }, { allowlist })
        for (const [form, m] of FORMS) expect(await outcome(online.sign(m)), form).toBe('allowlist')
        expect(online.chain).toBe('eip155:1')
        const intents: WriteIntent[] = []
        const confirmed = await open({ provider: provider('0x1') }, { allowlist, confirm: async (i) => { intents.push(i); return true } })
        for (const [form, m] of FORMS) expect(await outcome(confirmed.sign(m)), form).toBe(form === 'text' ? 'signed' : 'allowlist')
        expect(intents.map((i) => [i.chain, i.blindHashForm])).toEqual([['eip155:1', 'text']])
      })

      const otherFamily = entry.includes("'solana:")
      it(otherFamily ? 'a transaction is refused (chain): it signs for eip155:1, not the chain asked for' : 'a transaction is read as an EVM one: the ERC-20 recipient in its calldata is a destination', async () => {
        const transfer = { to: USDC, data: `0xa9059cbb${pad(SPENDER)}${pad('0x10')}`, chainId: 1, nonce: 0, gasLimit: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: 2 }
        const account = await open({ chainId: 1 }, { allowlist: { eip155: [USDC] } })
        if (otherFamily) {
          expect(await outcome(account.signTransaction(transfer))).toBe('chain')
          return
        }
        expect(await outcome(account.signTransaction(transfer))).toBe('allowlist')
        const intents: WriteIntent[] = []
        const confirmed = await open({ chainId: 1 }, { confirm: async (i) => { intents.push(i); return true } })
        await confirmed.signTransaction(transfer)
        expect(intents[0]).toMatchObject({ kind: 'send', chain: 'eip155:1', token: USDC, amount: 16n })
        expect(intents[0]!.destinations.map((d) => d.toLowerCase())).toEqual([USDC.toLowerCase(), SPENDER])
      })
    })
  }

  it("for comparison, asked for as 'eip155' the same setups were already refused", async () => {
    for (const [, config] of CONFIGS) {
      const w = new Wallet(SEED, { policies: { allowlist: { eip155: [T] } } })
      w.registerWallet('eip155', WalletManagerEvm as never, config())
      const account = (await w.getAccount('eip155')) as unknown as Signing
      for (const [form, m] of FORMS) expect(await outcome(account.sign(m)), form).toBe('allowlist')
      expect(await outcome(account.signTypedData(PERMIT_NO_CHAIN))).toBe('allowlist')
    }
  })
})
