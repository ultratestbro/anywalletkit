import { describe, expect, it } from 'vitest'
import { Keyring, KeyringError } from '../src/index.js'
import { ABANDON, CHAINS, MemorySecrets, MemoryStorage } from './helpers.js'

// Extension audit 2026-11-09, E20: the addresses a wallet shows on Receive / QR and hands to dApps came
// from public metadata in unauthenticated storage — never re-derived from the key. verifyAddresses
// re-derives every stored address from its secret and, with `repair`, overwrites what does not match.

const chains = { evm: CHAINS.evm, solana: CHAINS.solana }
const PK = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'
const EVIL = '0x000000000000000000000000000000000000dEaD'

async function wallet() {
  const storage = new MemoryStorage()
  const secrets = new MemorySecrets()
  const k = await Keyring.load({ storage, secrets, chains })
  const { accounts } = await k.importMnemonic(ABANDON)
  const second = await k.addAccount(accounts[0]!.sourceId)
  const imported = await k.importPrivateKey('evm', PK)
  return { storage, secrets, seed: accounts[0]!, second, imported: imported.account, reload: () => Keyring.load({ storage, secrets, chains }) }
}

describe('Keyring.verifyAddresses', () => {
  it('nothing to report for an untouched keyring; no write', async () => {
    const w = await wallet()
    const k = await w.reload()
    const saves = w.storage.saves
    expect(await k.verifyAddresses({ repair: true })).toEqual([])
    expect(w.storage.saves).toBe(saves)
  })

  it('an address edited in storage is reported, and repaired from the key', async () => {
    const w = await wallet()
    const real = w.second.addresses.evm!
    const state = w.storage.state!
    state.accounts.find((a) => a.id === w.second.id)!.addresses.evm = EVIL
    state.accounts.find((a) => a.id === w.imported.id)!.addresses.evm = EVIL
    const k = await w.reload()
    expect(await k.verifyAddresses()).toEqual([
      { accountId: w.second.id, chain: 'evm', stored: EVIL, derived: real },
      { accountId: w.imported.id, chain: 'evm', stored: EVIL, derived: w.imported.addresses.evm },
    ])
    expect(k.getAccountMeta(w.second.id).addresses.evm).toBe(EVIL) // report only
    await k.verifyAddresses({ repair: true })
    expect(k.getAccountMeta(w.second.id).addresses.evm).toBe(real)
    expect(w.storage.state!.accounts.find((a) => a.id === w.imported.id)!.addresses.evm).toBe(w.imported.addresses.evm)
    // and signing works again (getAccount checks the stored address)
    await expect(k.withAccount(w.second.id, 'evm', (a) => a.getAddress())).resolves.toBe(real)
  })

  it('an account planted in metadata (no secret behind it) loses its addresses', async () => {
    const w = await wallet()
    const state = w.storage.state!
    state.sources.push({ id: 'planted', type: 'privateKey', chain: 'evm', label: 'x', fingerprint: 'x', createdAt: 1 })
    state.accounts.push({ id: 'planted', sourceId: 'planted', index: null, name: 'Main', hidden: false, addresses: { evm: EVIL } })
    state.activeAccountId = 'planted'
    const k = await w.reload()
    expect(await k.verifyAddresses({ repair: true })).toEqual([{ accountId: 'planted', chain: 'evm', stored: EVIL, derived: null }])
    expect(k.activeAccount?.addresses).toEqual({})
  })

  it('a single-key account showing an address on another chain loses it', async () => {
    const w = await wallet()
    w.storage.state!.accounts.find((a) => a.id === w.imported.id)!.addresses.solana = 'So1anaPlanted1111111111111111111111111111111'
    const k = await w.reload()
    expect(await k.verifyAddresses({ repair: true })).toEqual([{ accountId: w.imported.id, chain: 'solana', stored: 'So1anaPlanted1111111111111111111111111111111', derived: null }])
    expect(k.getAccountMeta(w.imported.id).addresses).toEqual({ evm: w.imported.addresses.evm })
  })

  it('a secret store that fails (locked) aborts without touching anything', async () => {
    const w = await wallet()
    w.storage.state!.accounts.find((a) => a.id === w.second.id)!.addresses.evm = EVIL
    const k = await w.reload()
    w.secrets.get = async () => { throw new Error('locked') }
    await expect(k.verifyAddresses({ repair: true })).rejects.toThrow(/locked/)
    expect(k.getAccountMeta(w.second.id).addresses.evm).toBe(EVIL)
    expect(KeyringError).toBeDefined()
  })
})
