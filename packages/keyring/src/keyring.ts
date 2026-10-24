import { HDKey } from '@scure/bip32'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  LocalSigner,
  deriveEd25519,
  deriveSecp256k1,
  getRandomSeedPhrase,
  isValidSeedPhrase,
  normalizeMnemonic,
  privateKeySigner,
  seedFromMnemonic,
  zeroize,
  type IWalletAccount,
  type Signer,
  type WalletManager,
} from '@anywalletkit/core'
import { CHAIN_SPECS, type ChainKey } from './chains.js'
import { KeyringError } from './errors.js'
import { formatPrivateKey, keyFingerprint, parsePrivateKey, publicKeyOf, type PrivateKeyFormat } from './keys.js'

// ---- Storage adapters (the app implements both) ----

/** Public keyring metadata — names, addresses, flags. Never a secret. Plain storage is fine. */
export interface KeyringStorage {
  load(): Promise<KeyringState | null>
  save(state: KeyringState): Promise<void>
}

/**
 * One secret per source, kept by the app in secure storage (Keychain / Keystore
 * behind biometrics). The keyring reads a secret only for the call that needs
 * it and drops it right after; it never caches one.
 */
export interface SecretStorage {
  get(sourceId: string): Promise<string | null>
  set(sourceId: string, secret: string): Promise<void>
  delete(sourceId: string): Promise<void>
}

// ---- State ----

export type SourceType = 'mnemonic' | 'privateKey' | 'tonMnemonic'

export interface SourceMeta {
  id: string
  type: SourceType
  label: string
  /** Duplicate check: BIP-32 master fingerprint (+ passphrase) for a seed, chain + public-key hash for a key. */
  fingerprint: string
  /** privateKey / tonMnemonic: the one chain it signs on. */
  chain?: ChainKey
  /** mnemonic: a BIP-39 passphrase is part of the secret (the flag only, never the value). */
  hasPassphrase?: boolean
  createdAt: number
}

export interface AccountMeta {
  /** `<sourceId>/<index>` for a seed account, `<sourceId>` for a single-key one. */
  id: string
  sourceId: string
  /** BIP-44 account index; null for a single-key account. */
  index: number | null
  name: string
  hidden: boolean
  /** Public addresses per registered chain, computed once at creation. */
  addresses: Partial<Record<ChainKey, string>>
}

export interface KeyringState {
  version: 1
  sources: SourceMeta[]
  accounts: AccountMeta[]
  activeAccountId: string | null
}

// ---- Chains ----

/** A chain package's manager class, as the kit registers it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type KeyringManagerClass = new (seedOrSigner: string | Uint8Array | Signer, config: any) => WalletManager<IWalletAccount, object>

export interface KeyringChain {
  Manager: KeyringManagerClass
  config?: object
}

export interface KeyringOptions {
  storage: KeyringStorage
  secrets: SecretStorage
  /** Chains every seed account spans, e.g. `{ evm: { Manager: WalletManagerEvm, config } }`. */
  chains: Partial<Record<ChainKey, KeyringChain>>
}

/** An account on one chain, live until `dispose()` — which zeroizes the key material it holds. */
export interface AccountHandle<A extends IWalletAccount = IWalletAccount> {
  account: A
  dispose(): void
}

type Secret =
  | { type: 'mnemonic'; mnemonic: string; passphrase?: string }
  | { type: 'privateKey'; chain: ChainKey; key: string }
  | { type: 'tonMnemonic'; words: string }

const EMPTY: KeyringState = { version: 1, sources: [], accounts: [], activeAccountId: null }

/**
 * Many accounts from many key sources:
 * - a BIP-39 seed (generated or imported, optional passphrase) → accounts 0, 1, 2… on every chain;
 * - an imported private key → exactly one account on one chain;
 * - a TON-native 24-word mnemonic (Tonkeeper) → one TON account.
 *
 * Metadata goes through `KeyringStorage`, each source's secret through
 * `SecretStorage` (one entry per source). Listing accounts never touches a
 * secret; signing reads one, hands back an {@link AccountHandle}, and the caller
 * disposes it.
 */
export class Keyring {
  private _state: KeyringState
  private readonly _storage: KeyringStorage
  private readonly _secrets: SecretStorage
  private readonly _chains: Partial<Record<ChainKey, KeyringChain>>
  private _queue: Promise<unknown> = Promise.resolve()

  private constructor(options: KeyringOptions, state: KeyringState) {
    this._storage = options.storage
    this._secrets = options.secrets
    this._chains = options.chains
    this._state = state
  }

  static async load(options: KeyringOptions): Promise<Keyring> {
    if (Object.keys(options.chains).length === 0) throw new KeyringError('Register at least one chain.')
    const stored = await options.storage.load()
    if (stored && stored.version !== 1) throw new KeyringError(`Unknown keyring state version ${String(stored.version)}.`, 'unsupported')
    return new Keyring(options, stored ? clone(stored) : clone(EMPTY))
  }

  // ---- Reads (no secrets) ----

  /** A copy of the whole state. */
  get state(): KeyringState {
    return clone(this._state)
  }

  get chains(): ChainKey[] {
    return Object.keys(this._chains) as ChainKey[]
  }

  listSources(): SourceMeta[] {
    return clone(this._state.sources)
  }

  listAccounts(options: { includeHidden?: boolean; sourceId?: string } = {}): AccountMeta[] {
    return clone(
      this._state.accounts.filter((a) => (options.includeHidden || !a.hidden) && (options.sourceId === undefined || a.sourceId === options.sourceId)),
    )
  }

  getAccountMeta(accountId: string): AccountMeta {
    return clone(this.account(accountId))
  }

  get activeAccount(): AccountMeta | null {
    const a = this._state.accounts.find((x) => x.id === this._state.activeAccountId)
    return a ? clone(a) : null
  }

  // ---- Sources ----

  /** Generate a new seed and its account 0. Returns the phrase once so the app can show the backup screen. */
  async createMnemonic(options: { label?: string; words?: 12 | 24 } = {}): Promise<{ source: SourceMeta; account: AccountMeta; mnemonic: string }> {
    const mnemonic = getRandomSeedPhrase(options.words ?? 12)
    const { source, accounts } = await this.importMnemonic(mnemonic, options.label !== undefined ? { label: options.label } : {})
    return { source, account: accounts[0]!, mnemonic }
  }

  /**
   * Import a BIP-39 seed. Adds account 0, then — with `discover` — every further
   * account `isUsed` reports, stopping after `gapLimit` unused ones in a row.
   */
  async importMnemonic(
    mnemonic: string,
    options: {
      label?: string
      passphrase?: string
      discover?: DiscoverOptions
      /**
       * Adopt a seed the app ALREADY keeps in SecretStorage under this id (a wallet
       * that predates the keyring): the source takes this id and nothing is
       * written to SecretStorage — or deleted from it if the import fails.
       */
      adoptId?: string
    } = {},
  ): Promise<{ source: SourceMeta; accounts: AccountMeta[] }> {
    const phrase = normalizeMnemonic(mnemonic)
    if (!isValidSeedPhrase(phrase)) throw new KeyringError(mnemonicProblem(phrase))
    const passphrase = options.passphrase ?? ''
    const seed = await seedFromMnemonic(phrase, passphrase)
    let fingerprint: string
    try {
      // A hash of the master PUBLIC key: stable per seed + passphrase, reveals nothing about the secret.
      fingerprint = `bip32:${hex.encode(sha256(HDKey.fromMasterSeed(seed).publicKey!)).slice(0, 32)}`
    } finally {
      zeroize(seed)
    }
    const secret: Secret = passphrase ? { type: 'mnemonic', mnemonic: phrase, passphrase } : { type: 'mnemonic', mnemonic: phrase }
    const result = await this.addSource(
      { type: 'mnemonic', label: options.label ?? this.nextLabel('Wallet'), fingerprint, ...(passphrase ? { hasPassphrase: true } : {}) },
      secret,
      [0],
      options.adoptId,
    )
    if (!options.discover) return result
    // The phrase is still in hand: discovery reuses it (no second secure-storage read / biometric prompt).
    const found = await this.discover(this.source(result.source.id), secret, options.discover)
    return { source: result.source, accounts: [...result.accounts, ...found] }
  }

  /** The address a private key would import as — shown to the user before `importPrivateKey`. Stores nothing. */
  async previewPrivateKey(chain: ChainKey, key: string): Promise<string> {
    const parsed = parsePrivateKey(chain, key)
    return this.withKeyAccount(chain, parsed.privateKey, (a) => a.getAddress())
  }

  /** Import one private key as a single account on `chain`. */
  async importPrivateKey(chain: ChainKey, key: string, options: { label?: string } = {}): Promise<{ source: SourceMeta; account: AccountMeta }> {
    this.chain(chain)
    const parsed = parsePrivateKey(chain, key)
    const fingerprint = keyFingerprint(chain, publicKeyOf(parsed))
    const canonical = hex.encode(parsed.privateKey)
    zeroize(parsed.privateKey)
    const { source, accounts } = await this.addSource({ type: 'privateKey', label: options.label ?? this.nextLabel('Imported'), fingerprint, chain }, { type: 'privateKey', chain, key: canonical }, [null])
    return { source, account: accounts[0]! }
  }

  /**
   * Import a TON-native 24-word mnemonic (Tonkeeper, Tonhub, MyTonWallet): one
   * TON account with the address those wallets show. Needs the TON chain
   * registered with `WalletManagerTon` (it carries `fromTonMnemonic`).
   */
  async importTonMnemonic(words: string, options: { label?: string } = {}): Promise<{ source: SourceMeta; account: AccountMeta }> {
    const list = normalizeMnemonic(words)
    if (list.split(' ').length !== 24) throw new KeyringError('A TON mnemonic has 24 words.')
    const fingerprint = await this.withTonMnemonicAccount(list, async (a) => keyFingerprint('ton', (a as unknown as { publicKey: Uint8Array }).publicKey))
    const { source, accounts } = await this.addSource({ type: 'tonMnemonic', label: options.label ?? this.nextLabel('Imported'), fingerprint, chain: 'ton' }, { type: 'tonMnemonic', words: list }, [null])
    return { source, account: accounts[0]! }
  }

  /** Remove a source, its accounts and its secret. */
  async removeSource(sourceId: string): Promise<void> {
    await this.mutate(async (state) => {
      this.source(sourceId)
      await this._secrets.delete(sourceId)
      state.sources = state.sources.filter((s) => s.id !== sourceId)
      state.accounts = state.accounts.filter((a) => a.sourceId !== sourceId)
      if (!state.accounts.some((a) => a.id === state.activeAccountId)) state.activeAccountId = firstVisible(state)
    })
  }

  /** The source's secret for a backup screen — gate it behind biometrics in the app. */
  async exportSecret(sourceId: string): Promise<{ type: SourceType; secret: string; passphrase?: string; chain?: ChainKey }> {
    const source = this.source(sourceId)
    const secret = await this.secret(sourceId)
    switch (secret.type) {
      case 'mnemonic':
        return { type: 'mnemonic', secret: secret.mnemonic, ...(secret.passphrase ? { passphrase: secret.passphrase } : {}) }
      case 'privateKey':
        return { type: 'privateKey', secret: secret.key, chain: secret.chain }
      case 'tonMnemonic':
        return { type: 'tonMnemonic', secret: secret.words, chain: source.chain ?? 'ton' }
    }
  }

  /**
   * One account's private key on one chain, in the format that chain's wallets import
   * (see {@link formatPrivateKey}) — for "Export private key" behind biometrics, like the phrase.
   *
   * - Seed account: derived at the account's own path (as the chain manager derives it).
   * - Imported key: the key itself, on its chain only.
   * - TON-native 24 words: refused — export the words ({@link exportSecret}); TON wallets import only those.
   *
   * Before returning, a wallet is built from the exported key and its address must equal the
   * account's address on that chain; otherwise nothing is returned. Reads the secret once.
   */
  async exportPrivateKey(accountId: string, chain: ChainKey): Promise<{ chain: ChainKey; address: string; format: PrivateKeyFormat; privateKey: string; path?: string; compatibleWith: string }> {
    const account = this.account(accountId)
    const source = this.source(account.sourceId)
    const address = account.addresses[chain]
    if (!address) throw new KeyringError(`This account has no ${chain} address.`, 'unsupported')
    const { config } = this.chain(chain)
    const testnet = chain === 'btc' && typeof (config as { network?: unknown } | undefined)?.network === 'string' && (config as { network: string }).network !== 'bitcoin'
    const secret = await this.secret(account.sourceId)
    let key: Uint8Array
    let path: string | undefined
    if (secret.type === 'privateKey') {
      if (secret.chain !== chain) throw new KeyringError(`This imported key belongs to ${secret.chain}, not ${chain}.`, 'unsupported')
      key = hex.decode(secret.key)
    } else if (secret.type === 'tonMnemonic') {
      throw new KeyringError('This wallet was imported from TON 24 words — export the words instead; TON wallets import only those.', 'unsupported')
    } else {
      if (account.index === null) throw new KeyringError('A seed account has an index.', 'invalid-input')
      const manager = await this.seedManager(secret, chain)
      try {
        path = (await manager.getAccount(account.index) as IWalletAccount & { path?: string }).path ?? CHAIN_SPECS[chain].accountPath(account.index)
      } finally {
        manager.dispose()
      }
      const seed = await seedFromMnemonic(secret.mnemonic, secret.passphrase ?? '')
      try {
        key = (CHAIN_SPECS[chain].curve === 'secp256k1' ? deriveSecp256k1(seed, path) : deriveEd25519(seed, path)).privateKey.slice()
      } finally {
        zeroize(seed)
      }
    }
    try {
      // The exported key must control exactly this account's address — never hand out a wrong key.
      const check = await this.withKeyAccount(chain, key.slice(), (a) => a.getAddress())
      if (check !== address) throw new KeyringError(`The derived ${chain} key does not match this account's address; nothing was exported.`, 'unsupported')
      const out = formatPrivateKey(chain, key, { testnet })
      return { chain, address, format: out.format, privateKey: out.value, ...(path ? { path } : {}), compatibleWith: source.type === 'mnemonic' ? CHAIN_SPECS[chain].compatibleWith : 'wallets that import this key format' }
    } finally {
      zeroize(key)
    }
  }

  // ---- Accounts ----

  /** Next account of a seed: the lowest index above every one it has (hidden included). */
  async addAccount(sourceId: string, options: { name?: string } = {}): Promise<AccountMeta> {
    const source = this.source(sourceId)
    if (source.type !== 'mnemonic') throw new KeyringError('An imported key has exactly one account — import a seed phrase to add more.', 'unsupported')
    const index = this.nextIndex(sourceId)
    const secret = await this.secret(sourceId)
    const [account] = await this.store(source, [{ index, addresses: await this.deriveAddresses(secret, index) }], options.name)
    return account!
  }

  /**
   * Registered chains a seed account has no stored address for — a chain that
   * joined the keyring after the account was created. Empty for an imported
   * key (one chain by construction). No secret is read.
   */
  missingChains(accountId: string): ChainKey[] {
    const meta = this.account(accountId)
    if (meta.index === null) return []
    return this.chains.filter((c) => !meta.addresses[c])
  }

  /**
   * Derive the addresses every seed account of `sourceId` lacks (see
   * {@link missingChains}) and store them. One secret read for the whole
   * source; accounts that are complete are untouched. Returns the accounts
   * that changed.
   */
  async completeAddresses(sourceId: string): Promise<AccountMeta[]> {
    const source = this.source(sourceId)
    if (source.type !== 'mnemonic') return []
    const todo = this._state.accounts.filter((a) => a.sourceId === sourceId && a.index !== null && this.missingChains(a.id).length > 0)
    if (todo.length === 0) return []
    const secret = await this.secret(sourceId)
    const derived = new Map<string, Partial<Record<ChainKey, string>>>()
    for (const a of todo) derived.set(a.id, await this.deriveAddresses(secret, a.index!, this.missingChains(a.id)))
    await this.mutate(async (state) => {
      for (const a of state.accounts) {
        const add = derived.get(a.id)
        if (add) a.addresses = { ...a.addresses, ...add }
      }
    })
    return todo.map((a) => this.getAccountMeta(a.id))
  }

  /**
   * Restore-time discovery: walk indexes above the source's highest one, add
   * every account `isUsed` says has activity, stop after `gapLimit` (default 1,
   * as MetaMask / Phantom do) unused accounts in a row or at `maxIndex`.
   */
  async discoverAccounts(sourceId: string, options: DiscoverOptions): Promise<AccountMeta[]> {
    const source = this.source(sourceId)
    if (source.type !== 'mnemonic') return []
    return this.discover(source, await this.secret(sourceId), options)
  }

  /** Discovery with the secret already read — one secure-storage read per call, not per index. */
  private async discover(source: SourceMeta, secret: Secret, options: DiscoverOptions): Promise<AccountMeta[]> {
    const gap = options.gapLimit ?? 1
    const max = options.maxIndex ?? 20
    if (!Number.isInteger(gap) || gap < 1) throw new KeyringError('gapLimit must be a positive integer.')
    const found: { index: number; addresses: Partial<Record<ChainKey, string>> }[] = []
    let misses = 0
    for (let index = this.nextIndex(source.id); index <= max && misses < gap; index++) {
      const addresses = await this.deriveAddresses(secret, index)
      if (await options.isUsed(addresses, index)) {
        found.push({ index, addresses })
        misses = 0
      } else misses++
    }
    return found.length ? this.store(source, found) : []
  }

  async renameAccount(accountId: string, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 64) throw new KeyringError('An account name is 1–64 characters.')
    await this.mutate(async (state) => {
      state.accounts.find((a) => a.id === this.account(accountId).id)!.name = trimmed
    })
  }

  /** Hide or show an account. Hiding the active one moves "active" to the first visible account. */
  async setHidden(accountId: string, hidden: boolean): Promise<void> {
    await this.mutate(async (state) => {
      const a = state.accounts.find((x) => x.id === this.account(accountId).id)!
      if (hidden && state.accounts.filter((x) => !x.hidden).length === 1 && !a.hidden) throw new KeyringError('Keep at least one account visible.', 'unsupported')
      a.hidden = hidden
      if (hidden && state.activeAccountId === a.id) state.activeAccountId = firstVisible(state)
    })
  }

  async setActiveAccount(accountId: string): Promise<void> {
    await this.mutate(async (state) => {
      const a = this.account(accountId)
      if (a.hidden) throw new KeyringError('Show the account before making it active.', 'unsupported')
      state.activeAccountId = a.id
    })
  }

  // ---- Signing ----

  /**
   * The live account for `accountId` on `chain`. Reads the source's secret,
   * builds the chain manager, returns the account; `dispose()` zeroizes it.
   * Prefer {@link withAccount}, which disposes for you.
   */
  async getAccount<A extends IWalletAccount = IWalletAccount>(accountId: string, chain: ChainKey): Promise<AccountHandle<A>> {
    const meta = this.account(accountId)
    const source = this.source(meta.sourceId)
    const { Manager, config } = this.chain(chain)
    if (source.type !== 'mnemonic' && source.chain !== chain) throw new KeyringError(`This account is a ${source.chain} key; it has no ${chain} address.`, 'unsupported')
    const secret = await this.secret(source.id)
    let manager: WalletManager<IWalletAccount, object>
    if (secret.type === 'mnemonic') {
      manager = await this.seedManager(secret, chain)
    } else if (secret.type === 'privateKey') {
      manager = new Manager(privateKeySigner(CHAIN_SPECS[chain].curve, hex.decode(secret.key)), config ?? {})
    } else {
      manager = await this.tonManager(secret.words)
    }
    try {
      const account = (await manager.getAccount(meta.index ?? 0)) as A
      const expected = meta.addresses[chain]
      if (expected && (await account.getAddress()) !== expected) throw new KeyringError(`The ${chain} address no longer matches the stored one — the chain config or the secret changed.`, 'unsupported')
      return { account, dispose: () => manager.dispose() }
    } catch (err) {
      manager.dispose()
      throw err
    }
  }

  /** Run `fn` with the live account and dispose it afterwards, whatever happens. */
  async withAccount<T, A extends IWalletAccount = IWalletAccount>(accountId: string, chain: ChainKey, fn: (account: A) => Promise<T>): Promise<T> {
    const handle = await this.getAccount<A>(accountId, chain)
    try {
      return await fn(handle.account)
    } finally {
      handle.dispose()
    }
  }

  // ---- Internals ----

  private async addSource(meta: Omit<SourceMeta, 'id' | 'createdAt'>, secret: Secret, indexes: (number | null)[], adoptId?: string): Promise<{ source: SourceMeta; accounts: AccountMeta[] }> {
    const dupe = this._state.sources.find((s) => s.fingerprint === meta.fingerprint)
    if (dupe) throw new KeyringError(`This ${meta.type === 'mnemonic' ? 'seed phrase' : 'key'} is already in the wallet as "${dupe.label}".`, 'duplicate')
    if (adoptId !== undefined && (!/^[A-Za-z0-9_-]{1,64}$/.test(adoptId) || this._state.sources.some((s) => s.id === adoptId))) {
      throw new KeyringError(`Cannot adopt the secret under id "${adoptId}".`, 'invalid-input')
    }
    const source: SourceMeta = { ...meta, id: adoptId ?? newId(), createdAt: Date.now() }
    if (adoptId === undefined) await this._secrets.set(source.id, JSON.stringify(secret))
    try {
      const prepared: { index: number | null; addresses: Partial<Record<ChainKey, string>> }[] = []
      for (const index of indexes) prepared.push({ index, addresses: index === null ? await this.singleAddress(secret, source.chain!) : await this.deriveAddresses(secret, index) })
      const accounts = await this.store(source, prepared, undefined, true)
      return { source: clone(source), accounts }
    } catch (err) {
      if (adoptId === undefined) await this._secrets.delete(source.id).catch(() => undefined)
      throw err
    }
  }

  /** Persist prepared accounts (and the source when `withSource`). */
  private async store(source: SourceMeta, prepared: { index: number | null; addresses: Partial<Record<ChainKey, string>> }[], name?: string, withSource = false): Promise<AccountMeta[]> {
    const created: AccountMeta[] = prepared.map(({ index, addresses }) => ({
      id: index === null ? source.id : `${source.id}/${index}`,
      sourceId: source.id,
      index,
      name: name ?? '',
      hidden: false,
      addresses,
    }))
    await this.mutate(async (state) => {
      if (withSource) state.sources.push(source)
      for (const a of created) {
        if (state.accounts.some((x) => x.id === a.id)) continue
        a.name ||= `Account ${state.accounts.length + 1}`
        state.accounts.push(a)
      }
      state.activeAccountId ??= created[0]?.id ?? null
    })
    return clone(created)
  }

  /** Addresses of seed account `index` on every registered chain (or just `chains`). */
  private async deriveAddresses(secret: Secret, index: number, chains: ChainKey[] = this.chains): Promise<Partial<Record<ChainKey, string>>> {
    if (secret.type !== 'mnemonic') throw new KeyringError('Only a seed phrase derives indexed accounts.', 'unsupported')
    const out: Partial<Record<ChainKey, string>> = {}
    const seed = await seedFromMnemonic(secret.mnemonic, secret.passphrase ?? '')
    try {
      for (const chain of chains) {
        const { Manager, config } = this.chain(chain)
        const manager = new Manager(LocalSigner.fromSeed(seed, CHAIN_SPECS[chain].curve, CHAIN_SPECS[chain].root), config ?? {})
        try {
          out[chain] = await (await manager.getAccount(index)).getAddress()
        } finally {
          manager.dispose()
        }
      }
    } finally {
      zeroize(seed)
    }
    return out
  }

  private async singleAddress(secret: Secret, chain: ChainKey): Promise<Partial<Record<ChainKey, string>>> {
    if (secret.type === 'privateKey') return { [chain]: await this.withKeyAccount(chain, hex.decode(secret.key), (a) => a.getAddress()) }
    if (secret.type === 'tonMnemonic') return { ton: await this.withTonMnemonicAccount(secret.words, (a) => a.getAddress()) }
    throw new KeyringError('A seed phrase has indexed accounts.', 'unsupported')
  }

  private async seedManager(secret: Extract<Secret, { type: 'mnemonic' }>, chain: ChainKey): Promise<WalletManager<IWalletAccount, object>> {
    const { Manager, config } = this.chain(chain)
    const seed = await seedFromMnemonic(secret.mnemonic, secret.passphrase ?? '')
    try {
      return new Manager(LocalSigner.fromSeed(seed, CHAIN_SPECS[chain].curve, CHAIN_SPECS[chain].root), config ?? {})
    } finally {
      zeroize(seed)
    }
  }

  private async withKeyAccount<T>(chain: ChainKey, privateKey: Uint8Array, fn: (a: IWalletAccount) => Promise<T>): Promise<T> {
    const { Manager, config } = this.chain(chain)
    const manager = new Manager(privateKeySigner(CHAIN_SPECS[chain].curve, privateKey), config ?? {})
    try {
      return await fn(await manager.getAccount(0))
    } finally {
      manager.dispose()
    }
  }

  private async tonManager(words: string): Promise<WalletManager<IWalletAccount, object>> {
    const { Manager, config } = this.chain('ton')
    const fromTonMnemonic = (Manager as unknown as { fromTonMnemonic?: (w: string, c: object) => Promise<WalletManager<IWalletAccount, object>> }).fromTonMnemonic
    if (typeof fromTonMnemonic !== 'function') throw new KeyringError('The registered TON manager cannot import TON-native mnemonics.', 'unsupported')
    try {
      return await fromTonMnemonic.call(Manager, words, config ?? {})
    } catch (err) {
      throw new KeyringError(`Not a valid TON mnemonic: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async withTonMnemonicAccount<T>(words: string, fn: (a: IWalletAccount) => Promise<T>): Promise<T> {
    const manager = await this.tonManager(words)
    try {
      return await fn(await manager.getAccount(0))
    } finally {
      manager.dispose()
    }
  }

  private async secret(sourceId: string): Promise<Secret> {
    const raw = await this._secrets.get(sourceId)
    if (raw === null) throw new KeyringError('The secret for this wallet is missing from secure storage.', 'secret-missing')
    return JSON.parse(raw) as Secret
  }

  private nextIndex(sourceId: string): number {
    const used = this._state.accounts.filter((a) => a.sourceId === sourceId && a.index !== null).map((a) => a.index!)
    return used.length ? Math.max(...used) + 1 : 0
  }

  private nextLabel(prefix: string): string {
    return `${prefix} ${this._state.sources.length + 1}`
  }

  private source(id: string): SourceMeta {
    const s = this._state.sources.find((x) => x.id === id)
    if (!s) throw new KeyringError(`No key source ${id}.`, 'not-found')
    return s
  }

  private account(id: string): AccountMeta {
    const a = this._state.accounts.find((x) => x.id === id)
    if (!a) throw new KeyringError(`No account ${id}.`, 'not-found')
    return a
  }

  private chain(chain: ChainKey): KeyringChain {
    const c = this._chains[chain]
    if (!c) throw new KeyringError(`The ${chain} chain is not registered with this keyring.`, 'unsupported')
    return c
  }

  /** Serialize state changes: apply to a copy, persist, then swap in. A failed save leaves memory unchanged. */
  private mutate(change: (state: KeyringState) => Promise<void>): Promise<void> {
    const run = this._queue.then(async () => {
      const next = clone(this._state)
      await change(next)
      await this._storage.save(next)
      this._state = next
    })
    this._queue = run.catch(() => undefined)
    return run
  }
}

export interface DiscoverOptions {
  /** Whether account `index` (its addresses per chain) has balance or history. The app supplies it — the SDK has no indexer. */
  isUsed: (addresses: Partial<Record<ChainKey, string>>, index: number) => Promise<boolean>
  /** Unused accounts in a row before stopping. Default 1 (MetaMask / Phantom); BIP-44 says 20 for addresses. */
  gapLimit?: number
  /** Highest index probed. Default 20. */
  maxIndex?: number
}

/** Deep copy of JSON-safe state (Hermes has no structuredClone). */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function firstVisible(state: KeyringState): string | null {
  return state.accounts.find((a) => !a.hidden)?.id ?? null
}

function newId(): string {
  const b = new Uint8Array(8)
  globalThis.crypto.getRandomValues(b)
  return hex.encode(b)
}

/** A user-facing reason a phrase failed BIP-39 validation (never echoes the words). */
function mnemonicProblem(phrase: string): string {
  const n = phrase ? phrase.split(' ').length : 0
  if (![12, 15, 18, 21, 24].includes(n)) return `A seed phrase has 12, 15, 18, 21 or 24 words; this one has ${n}.`
  return 'This seed phrase is not valid — a word is misspelled, not in the English BIP-39 list, or the checksum does not match.'
}
