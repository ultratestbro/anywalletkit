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

const TON = 'ton:-239'
const TON_SELF = `0:${'11'.repeat(32)}`
const TON_TREASURY = `0:${'aa'.repeat(32)}`
const TON_ATTACKER = `0:${'bb'.repeat(32)}`
const TON_USDT = `0:${'cc'.repeat(32)}`
const TON_FAKE_MASTER = `0:${'dd'.repeat(32)}`

describe('scan 2026-10-27 G2 (F3, F5, F9): TON jetton transfer() is judged on everything that receives TON', () => {
  const tonAccount = () => createMockAccount({ chain: TON, address: TON_SELF })

  it('an attacker responseDestination is a destination: allowlist and blocklist refuse it', async () => {
    const exploit = { token: TON_USDT, recipient: TON_TREASURY, amount: 1n, attachedValue: 500_000_000_000n, responseDestination: TON_ATTACKER }
    const a = tonAccount()
    await expect(applyPolicies(a, { allowlist: { ton: [TON_TREASURY, TON_USDT] } }, TON).transfer(exploit)).rejects.toMatchObject({ policy: 'allowlist' })
    await expect(applyPolicies(a, { blocklist: { ton: [TON_ATTACKER] } }, TON).transfer(exploit)).rejects.toMatchObject({ policy: 'blocklist' })
    expect(a.sent).toHaveLength(0)
  })

  it('the jetton master is a destination: a fake master is refused under an allowlist', async () => {
    const a = tonAccount()
    const exploit = { token: TON_FAKE_MASTER, recipient: TON_TREASURY, amount: 1n, attachedValue: 500_000_000_000n }
    await expect(applyPolicies(a, { allowlist: { ton: [TON_TREASURY] } }, TON).transfer(exploit)).rejects.toMatchObject({ policy: 'allowlist' })
    expect(a.sent).toHaveLength(0)
  })

  it('a forward or custom payload cell cannot be read: destinationUnknown; confirm sees attachedValue and forwardTonAmount', async () => {
    const a = tonAccount()
    const cell = { bits: { length: 0, at: () => false }, refs: [] }
    for (const extra of [{ forwardPayload: cell }, { customPayload: cell }]) {
      await expect(applyPolicies(a, { allowlist: { ton: [TON_TREASURY, TON_USDT] } }, TON).transfer({ token: TON_USDT, recipient: TON_TREASURY, amount: 1n, ...extra })).rejects.toMatchObject({ policy: 'allowlist' })
    }
    let seen: Record<string, unknown> = {}
    await applyPolicies(a, { allowlist: { ton: [TON_TREASURY, TON_USDT] }, confirm: async (i) => { seen = i as never; return true } }, TON)
      .transfer({ token: TON_USDT, recipient: TON_TREASURY, amount: 1n, responseDestination: TON_SELF, attachedValue: 60_000_000n, forwardTonAmount: 10_000_000n, memo: 'invoice 7' } as never)
    expect(seen).toMatchObject({ destinations: [TON_TREASURY, TON_USDT], destinationUnknown: false, attachedValue: 60_000_000n, forwardTonAmount: 10_000_000n })
    expect(a.sent).toHaveLength(1)
  })
})

// A TEP-74 transfer of 1 jetton to TON_ATTACKER (response TON_ATTACKER), as @ton/core serialises it, and
// the same cell with the with_hashes flag (d1 | 0x10) and a zero hash area in front of its data.
const TRANSFER_TO_ATTACKER = 'te6ccgEBAQEAVwAAqg+KfqUAAAAAAAAAB0O5rKAIAXd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3AC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7uwgI='
const WITH_HASHES = 'te6ccgEBAQEAeQAQqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPin6lAAAAAAAAAAdDuaygCAF3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3dwAu7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7sIC'
const TON_JETTON_WALLET = `0:${'ee'.repeat(32)}`

describe('scan 2026-10-27 G3 (F2, F4): a TON body the kit cannot read the way the signer does is unknown', () => {
  const send = (policies: Parameters<typeof applyPolicies>[1], tx: unknown) => applyPolicies(createMockAccount({ chain: TON, address: TON_SELF }), policies, TON).sendTransaction(tx as never)

  it('the canonical transfer names the attacker (control)', async () => {
    await expect(send({ blocklist: { ton: [TON_ATTACKER] } }, { to: TON_JETTON_WALLET, value: 50_000_000n, bodyBoc: TRANSFER_TO_ATTACKER })).rejects.toMatchObject({ policy: 'blocklist' })
  })

  it('a with_hashes BoC hiding the transfer is refused by the allowlist and by a blocklist without confirm', async () => {
    const tx = { to: TON_JETTON_WALLET, value: 50_000_000n, bodyBoc: WITH_HASHES }
    await expect(send({ allowlist: { ton: [TON_JETTON_WALLET] } }, tx)).rejects.toMatchObject({ policy: 'allowlist' })
    await expect(send({ blocklist: { ton: [TON_ATTACKER] } }, tx)).rejects.toMatchObject({ policy: 'blocklist' })
  })

  it('a Cell-shaped body that is not a Cell is unknown, whatever bodyBoc says', async () => {
    const tx = { to: TON_JETTON_WALLET, value: 50_000_000n, body: { bits: { length: 0, at: () => false } }, bodyBoc: TRANSFER_TO_ATTACKER }
    await expect(send({ allowlist: { ton: [TON_JETTON_WALLET] } }, tx)).rejects.toMatchObject({ policy: 'allowlist' })
    let seen: Record<string, unknown> = {}
    await send({ confirm: async (i) => { seen = i as never; return true } }, tx)
    expect(seen.destinationUnknown).toBe(true)
  })
})
