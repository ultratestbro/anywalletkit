import { copyBytes, isValidSeedPhrase, normalizeMnemonic, seedFromMnemonicSync, zeroize, type ActivityItem, type ChainTx, type DescribeActivityContext, type HistorySource, type IWalletAccount, type IWalletAccountReadOnly, type Signer, type WalletManager } from '@anywalletkit/core'
import { isConcreteChain, sameChain } from './chain-id.js'
import { applyPolicies, type Policies } from './policies.js'
import { buildFeed, describeSingle, type ActivityOptions, type ActivityRecognizer, type FeedAddress, type FeedItem, type HistoryFeedPage, type HistoryFeedQuery } from './activity/feed.js'
import type { IntentJournal } from './activity/journal.js'

/** A chain package's manager class. */
export type ManagerClass<M extends WalletManager<IWalletAccount, object>, C extends object> = new (seedOrSigner: string | Uint8Array | Signer, config: C) => M

/** A protocol module's class: (account, config) → protocol. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProtocolClass<P, C = any> = new (account: IWalletAccountReadOnly | IWalletAccount, config: C) => P

interface WalletRegistration<M extends WalletManager<IWalletAccount, object>, C extends object> { Manager: ManagerClass<M, C>; config: C; manager: M | undefined }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface ProtocolRegistration { Protocol: ProtocolClass<unknown, any>; chain: string; config: unknown }

/** Options for {@link Wallet}. */
export interface WalletOptions {
  /**
   * Safety rules applied to every account and protocol the wallet hands out; see {@link Policies}.
   */
  policies?: Policies
  /** Activity feed options: known-contract labels per chain, native coins, error hook, pending-intent TTL. */
  activity?: ActivityOptions
}

/**
 * The wallet's seed, outside the object: never an own property, so logging or
 * serializing a Wallet shows no secret. Zeroized and dropped by `dispose()`.
 */
const WALLET_SEEDS = new WeakMap<object, Uint8Array>()

type Describer = { describeActivity?: (tx: ChainTx, ctx: DescribeActivityContext) => ActivityItem | null }

/**
 * The orchestrator. Register chain wallets by CAIP-2 namespace prefix (or exact
 * chain id) and protocol modules by name; ask for accounts and protocols. One
 * seed phrase (or external signer) feeds every registered chain. Policies wrap
 * every account handed out. `dispose()` zeroizes everything.
 *
 * A seed phrase is turned into the 64-byte seed in the constructor and the
 * string is not kept (a JS string cannot be zeroized); each chain manager gets
 * its own copy of the bytes. Pass the seed bytes instead of the phrase to never
 * hand the words to the SDK at all.
 *
 * ```ts
 * const w = new Wallet(seed, { policies: { maxFee: { 'eip155:1': 10n ** 16n } } })
 * w.registerWallet('eip155', WalletManagerEvm, { provider: RPC })
 * w.registerWallet('solana', WalletManagerSolana, { provider: SOL_RPC })
 * w.registerProtocol('lido', LidoProtocolEvm, { chain: 'eip155:1' })
 * const eth = await w.getAccount('eip155:1')
 * const lido = await w.getProtocol<LidoProtocolEvm>('lido')
 * ```
 */
export class Wallet {
  private readonly _signer: Signer | undefined
  private _disposed = false
  private readonly _policies: Policies | undefined
  private readonly _wallets = new Map<string, WalletRegistration<WalletManager<IWalletAccount, object>, object>>()
  private readonly _protocols = new Map<string, ProtocolRegistration>()
  private readonly _protocolInstances = new Map<string, unknown>()
  private readonly _historySources = new Map<string, HistorySource>()
  private readonly _guarded = new WeakMap<object, Map<string, IWalletAccount>>()
  private readonly _activity: ActivityOptions
  private _journal: IntentJournal | undefined

  constructor(seedOrSigner: string | Uint8Array | Signer, options: WalletOptions = {}) {
    if (typeof seedOrSigner === 'string') {
      if (!isValidSeedPhrase(seedOrSigner)) throw new Error('Invalid seed phrase.')
      WALLET_SEEDS.set(this, seedFromMnemonicSync(normalizeMnemonic(seedOrSigner)))
    } else if (seedOrSigner instanceof Uint8Array) {
      if (seedOrSigner.length !== 64) throw new Error(`A BIP-39 seed is 64 bytes; got ${seedOrSigner.length}.`)
      WALLET_SEEDS.set(this, copyBytes(seedOrSigner))
    } else {
      this._signer = seedOrSigner
    }
    this._policies = options.policies
    this._activity = options.activity ?? {}
  }

  /**
   * Register a chain package under a CAIP-2 key: a full chain id ("eip155:1") or a
   * namespace ("eip155", "solana", "ton", "tron", "bip122") that matches every chain id in it.
   */
  registerWallet<M extends WalletManager<IWalletAccount, object>, C extends object>(key: string, Manager: ManagerClass<M, C>, config: NoInfer<C>): this {
    if (this._wallets.has(key)) throw new Error(`A wallet is already registered for "${key}".`)
    this._wallets.set(key, { Manager: Manager as unknown as ManagerClass<WalletManager<IWalletAccount, object>, object>, config, manager: undefined })
    return this
  }

  /** Register a protocol module under a name, bound to the chain its account must come from. */
  registerProtocol<P, C>(name: string, Protocol: ProtocolClass<P, C>, options: { chain: string; config?: NoInfer<C> }): this {
    if (this._protocols.has(name)) throw new Error(`A protocol is already registered as "${name}".`)
    this._protocols.set(name, { Protocol, chain: options.chain, config: options.config })
    return this
  }

  /** Register the history source of one chain (exact CAIP-2 id, one per chain). */
  registerHistorySource(source: HistorySource): this {
    if (this._historySources.has(source.chain)) throw new Error(`A history source is already registered for "${source.chain}".`)
    this._historySources.set(source.chain, source)
    return this
  }

  /** The app's intent journal (what it meant when it broadcast): `history()` folds it in. Pass `undefined` to detach. */
  setIntentJournal(journal: IntentJournal | undefined): this {
    this._journal = journal
    return this
  }

  /** Chains with a registered history source. */
  get historyChains(): string[] { return [...this._historySources.keys()] }

  /** Registered wallet keys. */
  get chains(): string[] { return [...this._wallets.keys()] }
  /** Registered protocol names. */
  get protocols(): string[] { return [...this._protocols.keys()] }

  private registration(chain: string) {
    const exact = this._wallets.get(chain)
    if (exact) return exact
    const ns = chain.split(':')[0]!
    const byNs = this._wallets.get(ns)
    if (byNs) return byNs
    throw new Error(`No wallet registered for chain "${chain}" (registered: ${this.chains.join(', ') || 'none'}).`)
  }

  /** The chain package's manager (lazily constructed). */
  getManager<M extends WalletManager<IWalletAccount, object> = WalletManager<IWalletAccount, object>>(chain: string): M {
    if (this._disposed) throw new Error('This wallet has been disposed.')
    const reg = this.registration(chain)
    reg.manager ??= new reg.Manager(WALLET_SEEDS.get(this) ?? this._signer!, reg.config)
    return reg.manager as M
  }

  /**
   * Account `index` on `chain`, wrapped with the wallet's policies. Its writes are refused
   * (`PolicyViolationError`, `policy: 'chain'`) when the account signs on another network than
   * `chain` — one namespace registration with its RPC elsewhere — with or without policies; its
   * reads (the address is the same across a family) keep working, so history and activity do.
   */
  async getAccount<A extends IWalletAccount = IWalletAccount>(chain: string, index = 0): Promise<A> {
    const account = (await this.getManager(chain).getAccount(index)) as A
    // No policies: still guard the network when it is not known to match.
    const matches = isConcreteChain(account.chain) && sameChain(chain, account.chain)
    if (!this._policies && (!isConcreteChain(chain) || matches)) return account
    // One wrapper per account and asked-for chain: the same object every call, as the account is.
    let byChain = this._guarded.get(account)
    if (!byChain) this._guarded.set(account, (byChain = new Map()))
    let guarded = byChain.get(chain)
    if (!guarded) byChain.set(chain, (guarded = applyPolicies(account, this._policies ?? {}, chain)))
    return guarded as A
  }

  /** The protocol instance (one per name), constructed over the account of its chain. */
  async getProtocol<P>(name: string, index = 0): Promise<P> {
    const key = `${name}#${index}`
    const cached = this._protocolInstances.get(key)
    if (cached) return cached as P
    const reg = this._protocols.get(name)
    if (!reg) throw new Error(`No protocol registered as "${name}" (registered: ${this.protocols.join(', ') || 'none'}).`)
    const account = await this.getAccount(reg.chain, index)
    const instance = new reg.Protocol(account, reg.config)
    this._protocolInstances.set(key, instance)
    return instance as P
  }

  /** Every registered protocol module as a recognizer, in registration order; a module whose chain has no wallet is skipped (reported through `onError`). */
  private async recognizers(index: number): Promise<ActivityRecognizer[]> {
    const out: ActivityRecognizer[] = []
    for (const name of this._protocols.keys()) {
      let instance: Describer
      try { instance = (await this.getProtocol<Describer>(name, index)) } catch (error) {
        this._activity.onError?.({ stage: 'recognizer', module: name, error })
        continue
      }
      if (typeof instance.describeActivity !== 'function') continue
      const describe = instance.describeActivity.bind(instance)
      out.push({ name, describe: (tx, ctx) => describe(tx, ctx) ?? null })
    }
    return out
  }

  /** `addresses` from the query, or account `index` on every chain with a history source. */
  private async feedAddresses(query: HistoryFeedQuery): Promise<FeedAddress[]> {
    if (query.addresses) return query.addresses
    const index = query.index ?? 0
    const out: FeedAddress[] = []
    for (const chain of this._historySources.keys()) {
      if (query.chains && !query.chains.includes(chain)) continue
      try { out.push({ chain, address: await (await this.getAccount(chain, index)).getAddress() }) } catch (error) {
        this._activity.onError?.({ stage: 'source', chain, error })
      }
    }
    return out
  }

  private activityOptions(): ActivityOptions {
    const sources = this._historySources
    return {
      ...this._activity,
      explorerUrl: this._activity.explorerUrl ?? ((chain, hash) => sources.get(chain)?.explorerTxUrl(hash)),
    }
  }

  /**
   * The activity feed: one page across every chain with a history source, newest first.
   * Each row is described by the first registered protocol module that recognizes it,
   * else by the generic fallback (send / receive / self / approve / revoke / contract);
   * the intent journal adds pending rows, inherited kinds and cross-chain joins.
   */
  async history(query: HistoryFeedQuery = {}): Promise<HistoryFeedPage> {
    const addresses = await this.feedAddresses(query)
    const input = { sources: this._historySources, addresses, recognizers: await this.recognizers(query.index ?? 0), query, opts: this.activityOptions() }
    return buildFeed(this._journal ? { ...input, journal: this._journal } : input)
  }

  /** One transaction through the same pipeline, for a detail screen. `own` defaults to the row's own address. */
  async describeTransaction(tx: ChainTx, own: Iterable<string> = [tx.address], index = 0): Promise<FeedItem> {
    const set = new Set<string>()
    for (const a of own) { set.add(a); if (a.startsWith('0x')) set.add(a.toLowerCase()) }
    return describeSingle(tx, set, await this.recognizers(index), this._journal, this.activityOptions())
  }

  /** Zeroize every manager and drop protocol instances. */
  dispose(): void {
    for (const reg of this._wallets.values()) { reg.manager?.dispose(); reg.manager = undefined }
    this._protocolInstances.clear()
    zeroize(WALLET_SEEDS.get(this))
    WALLET_SEEDS.delete(this)
    this._signer?.dispose()
    this._disposed = true
  }
}
