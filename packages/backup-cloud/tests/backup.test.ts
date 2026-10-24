import { describe, expect, it } from 'vitest'
import { isBackupError } from '@anywalletkit/seed-vault'
import { backupFileName, checkBackup, iCloudDrive, iCloudKeychain, isCloudBackupError, listBackups, restoreBackup, saveBackup, type NativeBackupCloud } from '../src/index.js'

/** Two "devices" can share one cloud: the drive and the keychain maps are the cloud; `signedIn` is per device. */
function fakeCloud() {
  const files = new Map<string, { text: string; downloaded: boolean; modifiedAt: number }>()
  const keychain = new Map<string, string>()
  /** Every device-owner prompt a key read asked for, with its reason. */
  const prompts: string[] = []
  let clock = 1000
  const device = (opts: { signedIn?: boolean; keychainSynced?: boolean; cancelPrompt?: boolean } = {}): NativeBackupCloud => ({
    async driveStatus() {
      return { signedIn: opts.signedIn ?? true, container: true }
    },
    async driveList(_c, folder) {
      if (opts.signedIn === false) throw Object.assign(new Error('signed out'), { code: 'ERR_FW_ICLOUD_SIGNED_OUT' })
      return [...files.entries()].filter(([k]) => k.startsWith(`${folder}/`)).map(([k, v]) => ({ name: k.slice(folder.length + 1), downloaded: v.downloaded, modifiedAt: v.modifiedAt }))
    },
    async driveWrite(_c, folder, name, text) {
      files.set(`${folder}/${name}`, { text, downloaded: true, modifiedAt: clock++ })
    },
    async driveRead(_c, folder, name) {
      const f = files.get(`${folder}/${name}`)
      if (!f) return null
      f.downloaded = true
      return f.text
    },
    async driveDelete(_c, folder, name) {
      files.delete(`${folder}/${name}`)
    },
    async keychainHas(service, account) {
      return opts.keychainSynced !== false && keychain.has(`${service}/${account}`)
    },
    async keychainGet(service, account, reason) {
      if (opts.keychainSynced === false || !keychain.has(`${service}/${account}`)) return null
      prompts.push(reason)
      if (opts.cancelPrompt) throw Object.assign(new Error('cancelled'), { code: 'ERR_FW_CANCELLED' })
      return keychain.get(`${service}/${account}`) ?? null
    },
    async keychainSet(service, account, value) {
      keychain.set(`${service}/${account}`, value)
    },
    async keychainDelete(service, account) {
      keychain.delete(`${service}/${account}`)
    },
  })
  return { files, keychain, prompts, device }
}

const SECRET = JSON.stringify({ type: 'mnemonic', mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow' })
const META = { type: 'mnemonic', fingerprint: '1a2b3c4d', label: 'Main' }
const PASSWORD = 'violet harbor anchor lantern'

describe('backup-cloud', () => {
  it('saves with the no-password option and restores on a second device from iCloud Drive + iCloud Keychain', async () => {
    const cloud = fakeCloud()
    const phoneA = cloud.device()
    const saved = await saveBackup({ store: iCloudDrive({ container: 'iCloud.x', native: phoneA }), keyVault: iCloudKeychain({ native: phoneA }), secret: SECRET, meta: META })
    expect(saved).toEqual({ name: 'mnemonic-1a2b3c4d.fwbackup', protectors: ['icloud-keychain'] })
    expect([...cloud.files.values()][0]!.text).not.toContain('legal')
    expect([...cloud.keychain.keys()]).toEqual(['anywalletkit.backup-keys/backup-key.mnemonic-1a2b3c4d'])

    const phoneB = cloud.device()
    const store = iCloudDrive({ container: 'iCloud.x', native: phoneB })
    const [info] = await listBackups(store)
    expect(info).toMatchObject({ name: saved.name, meta: META, protectors: ['icloud-keychain'] })
    const opened = await restoreBackup({ store, name: saved.name, keyVault: iCloudKeychain({ native: phoneB }), expect: META })
    expect(opened.text()).toBe(SECRET)
    opened.dispose()
  })

  it('a file alone does not open without the key: Keychain not synced → key-missing; the password still works', async () => {
    const cloud = fakeCloud()
    const a = cloud.device()
    await saveBackup({ store: iCloudDrive({ container: 'iCloud.x', native: a }), keyVault: iCloudKeychain({ native: a }), password: PASSWORD, secret: SECRET, meta: META })
    const b = cloud.device({ keychainSynced: false })
    const store = iCloudDrive({ container: 'iCloud.x', native: b })
    const name = backupFileName(META)
    const err = await restoreBackup({ store, name, keyVault: iCloudKeychain({ native: b }) }).catch((e: unknown) => e)
    expect(isCloudBackupError(err, 'key-missing')).toBe(true)
    expect((await restoreBackup({ store, name, password: PASSWORD })).text()).toBe(SECRET)
    const wrong = await restoreBackup({ store, name, password: 'not the right password at all' }).catch((e: unknown) => e)
    expect(isBackupError(wrong, 'wrong-password')).toBe(true)
  })

  it('password-only backups say so instead of looking for a key', async () => {
    const cloud = fakeCloud()
    const d = cloud.device()
    const store = iCloudDrive({ container: 'iCloud.x', native: d })
    await saveBackup({ store, password: PASSWORD, secret: SECRET, meta: META })
    expect(cloud.keychain.size).toBe(0)
    const err = await restoreBackup({ store, name: backupFileName(META), keyVault: iCloudKeychain({ native: d }) }).catch((e: unknown) => e)
    expect(isCloudBackupError(err, 'key-missing')).toBe(true)
  })

  it('checks a wallet is backed up without opening anything, and refuses a backup of another wallet', async () => {
    const cloud = fakeCloud()
    const d = cloud.device()
    const store = iCloudDrive({ container: 'iCloud.x', native: d })
    expect(await checkBackup(store, META)).toEqual({ present: false })
    await saveBackup({ store, keyVault: iCloudKeychain({ native: d }), secret: SECRET, meta: META })
    expect(await checkBackup(store, META)).toMatchObject({ present: true, protectors: ['icloud-keychain'] })
    expect(await checkBackup(store, { type: 'mnemonic', fingerprint: 'ffffffff' })).toEqual({ present: false })
    const err = await restoreBackup({ store, name: backupFileName(META), keyVault: iCloudKeychain({ native: d }), expect: { type: 'mnemonic', fingerprint: 'ffffffff' } }).catch((e: unknown) => e)
    expect(isCloudBackupError(err, 'mismatch')).toBe(true)
  })

  it('saving again replaces the file and reuses the same synced key', async () => {
    const cloud = fakeCloud()
    const d = cloud.device()
    const store = iCloudDrive({ container: 'iCloud.x', native: d })
    const keyVault = iCloudKeychain({ native: d })
    await saveBackup({ store, keyVault, secret: SECRET, meta: META })
    const key1 = [...cloud.keychain.values()][0]
    await saveBackup({ store, keyVault, password: PASSWORD, secret: SECRET, meta: META })
    expect(cloud.files.size).toBe(1)
    expect([...cloud.keychain.values()]).toEqual([key1])
    expect((await listBackups(store))[0]!.protectors).toEqual(['password', 'icloud-keychain'])
  })

  it('lists broken files with an error instead of throwing, and ignores foreign files', async () => {
    const cloud = fakeCloud()
    const d = cloud.device()
    const store = iCloudDrive({ container: 'iCloud.x', native: d })
    cloud.files.set('WalletBackups/mnemonic-bad.fwbackup', { text: '{"format":"other"}', downloaded: true, modifiedAt: 1 })
    cloud.files.set('WalletBackups/notes.txt', { text: 'hi', downloaded: true, modifiedAt: 1 })
    const list = await listBackups(store)
    expect(list).toHaveLength(1)
    expect(list[0]!.error).toMatch(/Not an Any Wallet Kit backup/)
  })

  it('reports a signed-out device and a platform without the module', async () => {
    const cloud = fakeCloud()
    const out = cloud.device({ signedIn: false })
    expect(await iCloudDrive({ container: 'iCloud.x', native: out }).status()).toEqual({ available: false, reason: 'signed-out' })
    const err = await iCloudDrive({ container: 'iCloud.x', native: out }).list().catch((e: unknown) => e)
    expect(isCloudBackupError(err, 'signed-out')).toBe(true)
    expect(await iCloudDrive({ container: 'iCloud.x' }).status()).toEqual({ available: false, reason: 'unavailable' })
  })

  it('creating a key asks for nothing; every read of an existing key asks for the device owner', async () => {
    const cloud = fakeCloud()
    const d = cloud.device()
    const store = iCloudDrive({ container: 'iCloud.x', native: d })
    const keyVault = iCloudKeychain({ native: d, reason: 'Open your Vaulty backup' })
    await saveBackup({ store, keyVault, secret: SECRET, meta: META })
    expect(cloud.prompts).toEqual([])
    await saveBackup({ store, keyVault, secret: SECRET, meta: META })
    expect(cloud.prompts).toEqual(['Open your Vaulty backup'])
    await restoreBackup({ store, name: backupFileName(META), keyVault })
    expect(cloud.prompts).toHaveLength(2)
  })

  it('a cancelled Face ID / passcode sheet is a named error and opens nothing', async () => {
    const cloud = fakeCloud()
    const a = cloud.device()
    await saveBackup({ store: iCloudDrive({ container: 'iCloud.x', native: a }), keyVault: iCloudKeychain({ native: a }), secret: SECRET, meta: META })
    const b = cloud.device({ cancelPrompt: true })
    const err = await restoreBackup({ store: iCloudDrive({ container: 'iCloud.x', native: b }), name: backupFileName(META), keyVault: iCloudKeychain({ native: b }) }).catch((e: unknown) => e)
    expect(isCloudBackupError(err, 'cancelled')).toBe(true)
  })

  it('needs a password or a key vault', async () => {
    const cloud = fakeCloud()
    const err = await saveBackup({ store: iCloudDrive({ container: 'iCloud.x', native: cloud.device() }), secret: SECRET, meta: META }).catch((e: unknown) => e)
    expect(isCloudBackupError(err)).toBe(true)
  })

  it('names files safely', () => {
    expect(backupFileName({ type: 'privateKey', fingerprint: 'evm:0xAbC/../x' })).toBe('privateKey-evm_0xAbC____x.fwbackup')
  })
})

describe('config plugin', () => {
  it('adds the iCloud Documents entitlements once and validates the container', async () => {
    const { createRequire } = await import('node:module')
    const plugin = createRequire(import.meta.url)('../app.plugin.js') as (c: object, p?: object) => { ios: { entitlements: Record<string, string[]> } }
    const once = plugin({ ios: { entitlements: { 'com.apple.developer.associated-domains': ['applinks:x'] } } }, { iCloudContainer: 'iCloud.page.vaulty.app' })
    const twice = plugin(once, { iCloudContainer: 'iCloud.page.vaulty.app' })
    expect(twice.ios.entitlements).toEqual({
      'com.apple.developer.associated-domains': ['applinks:x'],
      'com.apple.developer.icloud-container-identifiers': ['iCloud.page.vaulty.app'],
      'com.apple.developer.ubiquity-container-identifiers': ['iCloud.page.vaulty.app'],
      'com.apple.developer.icloud-services': ['CloudDocuments'],
    })
    expect(() => plugin({}, {})).toThrow(/iCloudContainer/)
  })
})
