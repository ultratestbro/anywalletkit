import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { WalletManagerBtc } from '@anywalletkit/wallet-btc'
import { Wallet, applyPolicies } from '../src/index.js'

// Regression tests for the 2026-10-27 key/signing scan: each one replays the exploit input from
// the report against a policy-guarded account and expects it to be refused or flagged unknown.

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const BTC = 'bip122:000000000019d6689c085ae165831e93'
const BTC_ALLOWED = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'
const BTC_ATTACKER = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'

describe('scan 2026-10-27 G1 (F1): internal signing helpers behind the policy wrapper', () => {
  it('a guarded BTC account does not hand out signPlan, signInputs or signSpend', async () => {
    const w = new Wallet(PHRASE, { policies: { allowlist: { bip122: [BTC_ALLOWED] } } })
    w.registerWallet('bip122', WalletManagerBtc, {})
    const account = (await w.getAccount(BTC)) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    const plan = { to: BTC_ALLOWED, amount: 1000n, change: 0n, fee: 2000n, feeRate: 1n, utxos: [{ txid: '11'.repeat(32), vout: 0, value: 100_000n }] }
    // The exploit: the plan names the allowlisted address, the payment goes to the second argument.
    const attempts = [
      () => account.signPlan!(plan, BTC_ATTACKER, 98_000n, 0n, 0, true),
      () => account.signInputs!({ inputsLength: 0 }, []),
      () => account.signSpend!({ to: BTC_ALLOWED, value: 1000n }),
    ]
    for (const attempt of attempts) await expect((async () => attempt())()).rejects.toThrow()
    for (const name of ['signPlan', 'signInputs', 'signSpend']) expect([name, typeof account[name]]).toEqual([name, 'undefined'])
    w.dispose()
  })

  it('any sign* / send* method outside the known write surface is refused, with or without a fee cap', async () => {
    const helpers = { signPrepared: async () => '0xsigned', signHash: async () => '0xsig', sendRawThing: async () => '0xhash' }
    for (const policies of [{}, { allowlist: { 'eip155:1': ['0x000000000000000000000000000000000000beef'] } }, { confirm: async () => true }]) {
      const raw = Object.assign(createMockAccount({ chain: 'eip155:1' }), helpers)
      const guarded = applyPolicies(raw, policies, 'eip155:1') as unknown as typeof helpers
      await expect(guarded.signPrepared()).rejects.toMatchObject({ name: 'PolicyViolationError', policy: 'method' })
      await expect(guarded.signHash()).rejects.toMatchObject({ name: 'PolicyViolationError', policy: 'method' })
      await expect(guarded.sendRawThing()).rejects.toMatchObject({ name: 'PolicyViolationError', policy: 'method' })
    }
  })
})
