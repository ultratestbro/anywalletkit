import type { IWalletAccount, IWalletAccountReadOnly, Signer, WalletManager } from '@forgewallet/core'
import { applyPolicies, type Policies } from './policies.js'

/** A chain package's manager class. */
export type ManagerClass<M extends WalletManager<IWalletAccount, object>, C extends object> = new (seedOrSigner: string | Signer, config: C) => M

/** A protocol module's class: (account, config) → protocol. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProtocolClass<P, C = any> = new (account: IWalletAccountReadOnly | IWalletAccount, config: C) => P

interface WalletRegistration<M extends WalletManager<IWalletAccount, object>, C extends object> { Manager: ManagerClass<M, C>; config: C; manager: M | undefined }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface ProtocolRegistration { Protocol: ProtocolClass<unknown, any>; chain: string; config: unknown }

export interface WalletOptions {
  policies?: Policies
}

/**
 * The orchestrator. Register chain wallets by CAIP-2 namespace prefix (or exact
 * chain id) and protocol modules by name; ask for accounts and protocols. One
 * seed phrase (or external signer) feeds every registered chain. Policies wrap
 * every account handed out. `dispose()` zeroizes everything.
 *
 *   const w = new Wallet(seed, { policies: { maxFee: { 'eip155:1': 10n ** 16n } } })
 *   w.registerWallet('eip155', WalletManagerEvm, { provider: RPC })
 *   w.registerWallet('solana', WalletManagerSolana, { provider: SOL_RPC })
 *   w.registerProtocol('lido', LidoProtocolEvm, { chain: 'eip155:1' })
 *   const eth = await w.getAccount('eip155:1')
 *   const lido = await w.getProtocol<LidoProtocolEvm>('lido')
 */
export class Wallet {
  private readonly _seedOrSigner: string | Signer
  private readonly _policies: Policies | undefined
  private readonly _wallets = new Map<string, WalletRegistration<WalletManager<IWalletAccount, object>, object>>()
  private readonly _protocols = new Map<string, ProtocolRegistration>()
  private readonly _protocolInstances = new Map<string, unknown>()

  constructor(seedOrSigner: string | Signer, options: WalletOptions = {}) {
    this._seedOrSigner = seedOrSigner
    this._policies = options.policies
  }

  /**
   * Register a chain package under a CAIP-2 key: a full chain id ("eip155:1") or a
   * namespace ("eip155", "solana", "ton", "tron", "bip122") that matches every chain id in it.
   */
  registerWallet<M extends WalletManager<IWalletAccount, object>, C extends object>(key: string, Manager: ManagerClass<M, C>, config: C): this {
    if (this._wallets.has(key)) throw new Error(`A wallet is already registered for "${key}".`)
    this._wallets.set(key, { Manager: Manager as unknown as ManagerClass<WalletManager<IWalletAccount, object>, object>, config, manager: undefined })
    return this
  }

  /** Register a protocol module under a name, bound to the chain its account must come from. */
  registerProtocol<P, C>(name: string, Protocol: ProtocolClass<P, C>, options: { chain: string; config?: C }): this {
    if (this._protocols.has(name)) throw new Error(`A protocol is already registered as "${name}".`)
    this._protocols.set(name, { Protocol, chain: options.chain, config: options.config })
    return this
  }

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
    const reg = this.registration(chain)
    reg.manager ??= new reg.Manager(this._seedOrSigner, reg.config)
    return reg.manager as M
  }

  /** Account `index` on `chain`, wrapped with the wallet's policies. */
  async getAccount<A extends IWalletAccount = IWalletAccount>(chain: string, index = 0): Promise<A> {
    const account = (await this.getManager(chain).getAccount(index)) as A
    return this._policies ? applyPolicies(account, this._policies) : account
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

  /** Zeroize every manager and drop protocol instances. */
  dispose(): void {
    for (const reg of this._wallets.values()) { reg.manager?.dispose(); reg.manager = undefined }
    this._protocolInstances.clear()
    if (typeof this._seedOrSigner !== 'string') this._seedOrSigner.dispose()
  }
}
