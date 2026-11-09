import { describe, expect, it } from 'vitest'
import { VAULT_MIN_SCRYPT, Vault, VaultError, memoryVaultStorage, type VaultEnvelopeV2 } from '../src/index.js'

// Extension audit 2026-11-09:
// E21 — unlock(password) returned whatever DEK the stored dek box held, without checking it is the key the
//       vault's secrets are sealed under: a dek box spliced in under an attacker's password "unlocked".
// E23 — no way to change the password together with a fresh DEK (R5 / R15).

const PW = 'victim password'
const ATTACKER = 'attacker password'
const enc = (t: string) => new TextEncoder().encode(t)
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null)
const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof VaultError ? e.code : `other:${String(e)}`))
const vaultOn = (storage = memoryVaultStorage()) => ({ storage, vault: new Vault({ storage, scrypt: VAULT_MIN_SCRYPT }) })

/** The victim's vault (one seed) and an attacker vault whose kdf + dek box can be spliced into it. */
async function victimAndAttacker() {
  const victim = vaultOn()
  const dek = await victim.vault.create(PW)
  await victim.vault.setSecret(dek, 'seed', enc('victim seed words'))
  const attacker = vaultOn()
  await attacker.vault.create(ATTACKER)
  return { victim, dek, attackerEnvelope: attacker.storage.envelope as VaultEnvelopeV2 }
}

describe('unlock proves the DEK is the vault\'s own (E21)', () => {
  it('a dek box spliced in under another password does not unlock', async () => {
    const { victim, attackerEnvelope } = await victimAndAttacker()
    const e = victim.storage.envelope as VaultEnvelopeV2
    victim.storage.envelope = { ...e, kdf: attackerEnvelope.kdf, dek: attackerEnvelope.dek }
    expect(await code(victim.vault.unlock(ATTACKER))).toBe('wrong-password')
    expect(await code(victim.vault.changePassword(ATTACKER, 'new password 1'))).toBe('wrong-password')
    expect(await code(victim.vault.rotateVaultKey(ATTACKER))).toBe('wrong-password')
  })

  it('an envelope from before the DEK check is proven with its first secret', async () => {
    const { victim, attackerEnvelope } = await victimAndAttacker()
    const e = { ...(victim.storage.envelope as VaultEnvelopeV2) }
    delete e.dekCheck
    victim.storage.envelope = e
    expect(dec(await victim.vault.getSecret(await victim.vault.unlock(PW), 'seed'))).toBe('victim seed words')
    victim.storage.envelope = { ...e, kdf: attackerEnvelope.kdf, dek: attackerEnvelope.dek }
    expect(await code(victim.vault.unlock(ATTACKER))).toBe('wrong-password')
  })

  it('a passkey box sealed around another DEK does not unlock', async () => {
    const { victim } = await victimAndAttacker()
    // A passkey registered on a look-alike vault the attacker controls, its box copied over.
    const other = vaultOn()
    const otherDek = await other.vault.create(ATTACKER)
    const prf = crypto.getRandomValues(new Uint8Array(32))
    await other.vault.addPasskey(otherDek, { id: 'evil', prf: Uint8Array.from(prf), label: 'evil' })
    const box = (other.storage.envelope as VaultEnvelopeV2).passkeys[0]!
    const e = victim.storage.envelope as VaultEnvelopeV2
    victim.storage.envelope = { ...e, passkeys: [...e.passkeys, box] }
    expect(await code(victim.vault.unlockWithPasskey('evil', Uint8Array.from(prf)))).toBe('wrong-password')
  })

  it('the real password and passkey still unlock', async () => {
    const { victim, dek } = await victimAndAttacker()
    const prf = crypto.getRandomValues(new Uint8Array(32))
    await victim.vault.addPasskey(dek, { id: 'mine', prf: Uint8Array.from(prf), label: 'mine' })
    expect(dec(await victim.vault.getSecret(await victim.vault.unlock(PW), 'seed'))).toBe('victim seed words')
    expect(dec(await victim.vault.getSecret(await victim.vault.unlockWithPasskey('mine', Uint8Array.from(prf)), 'seed'))).toBe('victim seed words')
  })
})

describe('rotateVaultKey(old, new): change the password with a fresh DEK (E23, R5 / R15)', () => {
  it('needs the current password; the old password and the old DEK open nothing afterwards', async () => {
    const { victim, dek } = await victimAndAttacker()
    const old = Uint8Array.from(dek)
    const before = structuredClone(victim.storage.envelope)
    expect(await code(victim.vault.rotateVaultKey('not the password', 'new password 1'))).toBe('wrong-password') // R5
    expect(victim.storage.envelope).toEqual(before)
    expect(await code(victim.vault.rotateVaultKey(PW, 'short'))).toBe('invalid-input')
    expect(victim.storage.envelope).toEqual(before)

    const next = await victim.vault.rotateVaultKey(PW, 'new password 1')
    expect(Array.from(next)).not.toEqual(Array.from(old))
    expect(await code(victim.vault.unlock(PW))).toBe('wrong-password')
    expect(dec(await victim.vault.getSecret(await victim.vault.unlock('new password 1'), 'seed'))).toBe('victim seed words')
    // R15: the retired DEK neither opens the re-sealed secrets nor seals new ones
    expect(await code(victim.vault.getSecret(old, 'seed'))).toBe('locked')
    expect(await code(victim.vault.setSecret(old, 'late', enc('x')))).toBe('locked')
    // and the old envelope's dek box no longer opens under the old password in the new envelope
    const e = victim.storage.envelope as VaultEnvelopeV2
    const oldE = before as VaultEnvelopeV2
    victim.storage.envelope = { ...e, kdf: oldE.kdf, dek: oldE.dek }
    expect(await code(victim.vault.unlock(PW))).toBe('wrong-password')
  })

  it('drops the passkeys (their boxes hold the old DEK)', async () => {
    const { victim, dek } = await victimAndAttacker()
    await victim.vault.addPasskey(dek, { id: 'p1', prf: crypto.getRandomValues(new Uint8Array(32)), label: 'p1' })
    await victim.vault.rotateVaultKey(PW, 'new password 1')
    expect(await victim.vault.listPasskeys()).toEqual([])
  })
})
