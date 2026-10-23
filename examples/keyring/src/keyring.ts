// The "Keyring" guide on docs.anywallet.tech renders the #region blocks of this file.

// #region imports
import { Keyring, type AccountMeta, type ChainKey, type KeyringState, type KeyringStorage, type SecretStorage } from '@forgewallet/keyring'
import { applyPolicies, type Policies } from '@forgewallet/kit'
import { WalletManagerEvm } from '@forgewallet/wallet-evm'
import { WalletManagerSolana } from '@forgewallet/wallet-solana'
import { WalletManagerTon } from '@forgewallet/wallet-ton'
import { WalletManagerTron } from '@forgewallet/wallet-tron'
// #endregion imports

// #region secrets
/** The shape of expo-secure-store (getItemAsync / setItemAsync / deleteItemAsync). */
export interface SecureStoreLike<O> {
  getItemAsync(key: string, options?: O): Promise<string | null>
  setItemAsync(key: string, value: string, options?: O): Promise<void>
  deleteItemAsync(key: string, options?: O): Promise<void>
}

/**
 * One secure-storage entry per source. `options` is where the protection lives:
 * with expo-secure-store, `{ requireAuthentication: true,
 * keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY }`.
 */
export function secureSecrets<O>(store: SecureStoreLike<O>, options: O): SecretStorage {
  const key = (sourceId: string) => `awk.secret.${sourceId}` // letters, digits, . - _ only
  return {
    get: (sourceId) => store.getItemAsync(key(sourceId), options),
    set: (sourceId, secret) => store.setItemAsync(key(sourceId), secret, options),
    delete: (sourceId) => store.deleteItemAsync(key(sourceId), options),
  }
}
// #endregion secrets

// #region metadata
/** The shape of AsyncStorage / MMKV / chrome.storage: plain storage is fine, nothing here is secret. */
export interface PlainStoreLike {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
}

export function plainMetadata(store: PlainStoreLike): KeyringStorage {
  return {
    load: async () => {
      const json = await store.getItem('awk.keyring')
      return json ? (JSON.parse(json) as KeyringState) : null
    },
    save: (state) => store.setItem('awk.keyring', JSON.stringify(state)),
  }
}
// #endregion metadata

// #region setup
export function openKeyring(storage: KeyringStorage, secrets: SecretStorage): Promise<Keyring> {
  return Keyring.load({
    storage, // names, addresses, flags
    secrets, // one entry per seed or key
    chains: {
      evm: { Manager: WalletManagerEvm, config: { provider: 'https://ethereum-rpc.publicnode.com', chainId: 1 } },
      solana: { Manager: WalletManagerSolana, config: { provider: 'https://api.mainnet-beta.solana.com' } },
      ton: { Manager: WalletManagerTon, config: { tonClient: { url: 'https://toncenter.com/api/v2/jsonRPC' } } },
      tron: { Manager: WalletManagerTron, config: { provider: 'https://api.trongrid.io' } },
    },
  })
}
// #endregion setup

// #region create
export async function createWallet(keyring: Keyring) {
  const { account, mnemonic } = await keyring.createMnemonic({ words: 12 })
  // `mnemonic` is for the backup screen only: show it, ask for a few words back, drop it.
  return { account, mnemonic }
}
// #endregion create

// #region restore
/** Your check: any balance or history on any of the addresses. */
export type IsUsed = (addresses: Partial<Record<ChainKey, string>>) => Promise<boolean>

export async function restoreWallet(keyring: Keyring, phrase: string, isUsed: IsUsed) {
  const { accounts } = await keyring.importMnemonic(phrase, {
    // Adds account 0, then 1, 2… while they have activity; stops at the first unused one.
    discover: { isUsed: (addresses) => isUsed(addresses), gapLimit: 1, maxIndex: 20 },
  })
  return accounts
}
// #endregion restore

// #region accounts
export async function manageAccounts(keyring: Keyring, sourceId: string): Promise<AccountMeta[]> {
  const second = await keyring.addAccount(sourceId, { name: 'Savings' }) // the next index of this seed
  await keyring.renameAccount(second.id, 'Long-term')
  await keyring.setActiveAccount(second.id)
  // Reading accounts never touches a secret: no biometric prompt, no key in memory.
  return keyring.listAccounts() // hidden accounts are left out unless { includeHidden: true }
}
// #endregion accounts

// #region sign
export async function signMessage(keyring: Keyring, accountId: string, policies: Policies, message: string) {
  // One secret read, one live account, zeroized when the callback returns or throws.
  return keyring.withAccount(accountId, 'evm', async (account) => {
    const guarded = applyPolicies(account, policies, account.chain) // fee caps, lists, confirm
    return guarded.sign(message)
  })
}
// #endregion sign

// #region import
export async function importKey(keyring: Keyring, chain: ChainKey, key: string, confirm: (address: string) => Promise<boolean>) {
  const address = await keyring.previewPrivateKey(chain, key) // stores nothing
  if (!(await confirm(address))) return null
  return keyring.importPrivateKey(chain, key, { label: 'Imported' })
}

export async function importTonkeeper(keyring: Keyring, words: string) {
  return keyring.importTonMnemonic(words) // the address Tonkeeper shows for these 24 words
}
// #endregion import

// #region backup
/** "Show recovery phrase": ask for biometrics or the passcode first, every time. */
export async function revealSecret(keyring: Keyring, sourceId: string, authenticate: () => Promise<boolean>) {
  if (!(await authenticate())) throw new Error('Not authenticated.')
  return keyring.exportSecret(sourceId) // { type, secret, passphrase?, chain? }
}

export async function removeWallet(keyring: Keyring, sourceId: string) {
  await keyring.removeSource(sourceId) // its accounts, and its entry in secure storage
}
// #endregion backup
