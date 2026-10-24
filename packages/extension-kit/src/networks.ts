/**
 * Default EVM networks for an extension built on this kit: the chains Vaulty's in-app
 * browser can read and sign on, with the same public RPC failover lists
 * (`mobile/lib/swap2.ts`), no API keys. A wallet build may prepend its own
 * endpoints; `wallet_addEthereumChain` may add a chain the asset catalog
 * (`@anywalletkit/swap2-assets`) knows — an unknown chain id is refused, so a
 * site cannot point the wallet at a look-alike network.
 */
import { ccChain } from '@anywalletkit/swap2-assets'
import { RELAY_ERRORS, relayError, type RelayError } from './relay.js'
import type { JsonStorage } from './storage.js'

export interface EvmNetwork {
  /** CAIP-2, `eip155:<chainId>`. */
  caip2: string
  chainId: number
  name: string
  /** Native currency symbol, 18 decimals on every chain here (on Arc that is the 18-decimal native view of USDC). */
  symbol: string
  /** Tried in order; the client fails over. */
  rpcs: string[]
  explorer?: string
  /** Set when a SITE supplied the RPC list (wallet_addEthereumChain): every sheet on this network says so and simulations are not trusted. */
  custom?: { origin: string; addedAt: number }
}

export const DEFAULT_CHAIN = 'eip155:1'

const net = (chainId: number, name: string, symbol: string, rpcs: string[], explorer?: string): EvmNetwork =>
  explorer === undefined ? { caip2: `eip155:${chainId}`, chainId, name, symbol, rpcs } : { caip2: `eip155:${chainId}`, chainId, name, symbol, rpcs, explorer }

export const DEFAULT_NETWORKS: readonly EvmNetwork[] = Object.freeze([
  net(1, 'Ethereum', 'ETH', ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'], 'https://etherscan.io'),
  net(8453, 'Base', 'ETH', ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org'], 'https://basescan.org'),
  net(56, 'BNB Chain', 'BNB', ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc.drpc.org'], 'https://bscscan.com'),
  net(42161, 'Arbitrum', 'ETH', ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc', 'https://arbitrum.drpc.org'], 'https://arbiscan.io'),
  net(10, 'Optimism', 'ETH', ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io', 'https://optimism.drpc.org'], 'https://optimistic.etherscan.io'),
  net(137, 'Polygon', 'POL', ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'], 'https://polygonscan.com'),
  net(43114, 'Avalanche', 'AVAX', ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc', 'https://avalanche.drpc.org'], 'https://snowtrace.io'),
  net(999, 'HyperEVM', 'HYPE', ['https://rpc.hyperliquid.xyz/evm', 'https://hyperliquid.drpc.org', 'https://hyperliquid-json-rpc.stakely.io']),
  net(4663, 'Robinhood Chain', 'ETH', ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood.drpc.org'], 'https://robinhoodchain.blockscout.com'),
  net(324, 'zkSync Era', 'ETH', ['https://mainnet.era.zksync.io', 'https://zksync.drpc.org'], 'https://era.zksync.network'),
  net(42220, 'Celo', 'CELO', ['https://forno.celo.org', 'https://celo.drpc.org'], 'https://celoscan.io'),
  net(4326, 'MegaETH', 'ETH', ['https://mainnet.megaeth.com/rpc']),
  net(130, 'Unichain', 'ETH', ['https://mainnet.unichain.org', 'https://unichain-rpc.publicnode.com'], 'https://uniscan.xyz'),
  net(143, 'Monad', 'MON', ['https://rpc.monad.xyz']),
  net(9745, 'Plasma', 'XPL', ['https://rpc.plasma.to']),
  net(59144, 'Linea', 'ETH', ['https://rpc.linea.build', 'https://linea-rpc.publicnode.com'], 'https://lineascan.build'),
  net(100, 'Gnosis', 'xDAI', ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com'], 'https://gnosisscan.io'),
  net(146, 'Sonic', 'S', ['https://rpc.soniclabs.com', 'https://sonic-rpc.publicnode.com'], 'https://sonicscan.org'),
  net(480, 'World Chain', 'ETH', ['https://worldchain-mainnet.g.alchemy.com/public', 'https://worldchain-mainnet.gateway.tenderly.co'], 'https://worldscan.org'),
  net(1329, 'Sei', 'SEI', ['https://evm-rpc.sei-apis.com'], 'https://seitrace.com'),
  net(57073, 'Ink', 'ETH', ['https://rpc-gel.inkonchain.com'], 'https://explorer.inkonchain.com'),
  net(98866, 'Plume', 'PLUME', ['https://rpc.plume.org'], 'https://explorer.plume.org'),
  net(196, 'X Layer', 'OKB', ['https://rpc.xlayer.tech', 'https://xlayerrpc.okx.com'], 'https://www.okx.com/web3/explorer/xlayer'),
  net(534352, 'Scroll', 'ETH', ['https://rpc.scroll.io', 'https://scroll-rpc.publicnode.com'], 'https://scrollscan.com'),
  net(80094, 'Berachain', 'BERA', ['https://rpc.berachain.com', 'https://berachain-rpc.publicnode.com'], 'https://berascan.com'),
  // Arc (Circle's L1): the gas token is USDC. eth_getBalance / msg.value / gas are accounted in 18-decimal units (the
  // `symbol` here names that native view); the ERC-20 interface at 0x3600…0000 reads the SAME balance in 6 decimals
  // and is what the catalog, LI.FI and CCTP address (see swap2-assets). Balances must show one view, not both.
  net(5042, 'Arc', 'USDC', ['https://rpc.mainnet.arc.io'], 'https://explorer.arc.io'),
  net(5000, 'Mantle', 'MNT', ['https://rpc.mantle.xyz', 'https://mantle-rpc.publicnode.com'], 'https://mantlescan.xyz'),
  net(747474, 'Katana', 'ETH', ['https://rpc.katana.network'], 'https://explorer.katanarpc.com'),
  net(2818, 'Morph', 'ETH', ['https://rpc.morphl2.io', 'https://rpc-quicknode.morphl2.io'], 'https://explorer.morphl2.io'),
  net(14, 'Flare', 'FLR', ['https://flare-api.flare.network/ext/C/rpc', 'https://flare.rpc.thirdweb.com'], 'https://flare-explorer.flare.network'),
])

export const chainHex = (caip2: string): string => `0x${Number(caip2.split(':')[1]).toString(16)}`

/** `0x1` / `1` → `eip155:1`; `null` for anything that is not a positive integer chain id. */
export function caip2FromChainId(value: unknown): string | null {
  let n: number
  if (typeof value === 'string') {
    const s = value.trim()
    if (/^0x[0-9a-f]+$/i.test(s)) n = Number.parseInt(s, 16)
    else if (/^[0-9]+$/.test(s)) n = Number.parseInt(s, 10)
    else return null
  } else if (typeof value === 'number') n = value
  else return null
  return Number.isSafeInteger(n) && n > 0 ? `eip155:${n}` : null
}

/** Whether the asset catalog knows this chain — the gate for `wallet_addEthereumChain`. */
export function isCatalogChain(caip2: string): boolean {
  return ccChain(caip2) !== undefined
}

/**
 * Shipped networks plus the ones the user accepted from sites, persisted. Lookup
 * by CAIP-2; a custom entry for a shipped chain is ignored (the build's RPC list
 * wins — a site must not be able to replace Ethereum's endpoints).
 */
export class NetworksTable {
  private _custom: EvmNetwork[] | null = null
  private _loading: Promise<EvmNetwork[]> | null = null
  /** add/remove run one after another (scan F22, as PermissionStore). */
  private _queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly storage: JsonStorage<EvmNetwork[]>, private readonly defaults: readonly EvmNetwork[] = DEFAULT_NETWORKS) {}

  async list(): Promise<EvmNetwork[]> {
    return [...this.defaults, ...(await this.custom())]
  }

  async get(caip2: string): Promise<EvmNetwork | null> {
    return this.defaults.find((n) => n.caip2 === caip2) ?? (await this.custom()).find((n) => n.caip2 === caip2) ?? null
  }

  add(network: EvmNetwork): Promise<void> {
    return this.serialize(async () => {
      if (this.defaults.some((n) => n.caip2 === network.caip2)) return
      const custom = (await this.custom()).filter((n) => n.caip2 !== network.caip2)
      custom.push(network)
      await this.write(custom)
    })
  }

  remove(caip2: string): Promise<void> {
    return this.serialize(async () => {
      const current = await this.custom()
      if (!current.some((n) => n.caip2 === caip2)) return
      await this.write(current.filter((n) => n.caip2 !== caip2))
    })
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._queue.then(fn, fn)
    this._queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Cache first (readers see it at once), rolled back when storage refuses. */
  private async write(custom: EvmNetwork[]): Promise<void> {
    const prev = await this.custom()
    this._custom = custom
    try {
      await this.storage.set(custom)
    } catch (e) {
      if (this._custom === custom) this._custom = prev
      throw e
    }
  }

  private async custom(): Promise<EvmNetwork[]> {
    if (this._custom) return this._custom
    this._loading ??= this.storage.get().then(
      (s) => (this._custom ??= s ?? []),
      (e: unknown) => { this._loading = null; throw e },
    )
    return this._loading
  }
}

/**
 * EIP-3085 `wallet_addEthereumChain` parameter → {@link EvmNetwork}, or the error
 * to answer with. https RPC urls only; the chain id must be in the catalog.
 */
export function parseAddChainParams(params: unknown, known: (caip2: string) => boolean = isCatalogChain): EvmNetwork | RelayError {
  const p = (Array.isArray(params) ? params[0] : params) as Record<string, unknown> | undefined
  if (!p || typeof p !== 'object') return relayError(RELAY_ERRORS.invalidParams, 'wallet_addEthereumChain expects one object parameter.')
  const caip2 = caip2FromChainId(p.chainId)
  if (!caip2) return relayError(RELAY_ERRORS.invalidParams, 'chainId must be a 0x-prefixed hex string.')
  if (!known(caip2)) return relayError(RELAY_ERRORS.chainNotAdded, `Chain ${String(p.chainId)} is not in this wallet's catalog.`)
  const rpcs = Array.isArray(p.rpcUrls) ? p.rpcUrls.filter((u): u is string => typeof u === 'string' && /^https:\/\/[^\s/?#]+/i.test(u)) : []
  if (rpcs.length === 0) return relayError(RELAY_ERRORS.invalidParams, 'rpcUrls must contain at least one https URL.')
  const name = typeof p.chainName === 'string' && p.chainName.trim() ? p.chainName.trim().slice(0, 64) : caip2
  const currency = p.nativeCurrency as { symbol?: unknown; decimals?: unknown } | undefined
  if (currency && currency.decimals !== undefined && currency.decimals !== 18) return relayError(RELAY_ERRORS.invalidParams, 'nativeCurrency.decimals must be 18.')
  const symbol = typeof currency?.symbol === 'string' && /^[A-Za-z0-9]{1,12}$/.test(currency.symbol) ? currency.symbol : 'ETH'
  const explorers = Array.isArray(p.blockExplorerUrls) ? p.blockExplorerUrls.filter((u): u is string => typeof u === 'string' && /^https:\/\//i.test(u)) : []
  const network: EvmNetwork = { caip2, chainId: Number(caip2.split(':')[1]), name, symbol, rpcs }
  return explorers[0] ? { ...network, explorer: explorers[0] } : network
}

// ---- non-EVM chains: the CAIP-2 ids the asset catalog / swap2 engine use, and public endpoints only (Vaulty's lists minus its proxies) ----

/** Solana mainnet as the catalog names it (`solana:mainnet`); the wallet package also accepts the genesis-hash form. */
export const SOLANA_CHAIN = 'solana:mainnet'
export const SOLANA_RPCS: readonly string[] = Object.freeze(['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'])
export const TON_CHAIN = 'ton:-239'
export const TON_ENDPOINTS: readonly string[] = Object.freeze(['https://ton.access.orbs.network/1/mainnet/toncenter-api-v2/jsonRPC', 'https://toncenter.com/api/v2/jsonRPC'])
export const TRON_CHAIN = 'tron:728126428'
export const TRON_PROVIDERS: readonly string[] = Object.freeze(['https://api.trongrid.io'])
export const BTC_CHAIN = 'bitcoin:mainnet'
export const BTC_ESPLORA: readonly string[] = Object.freeze(['https://mempool.space/api', 'https://blockstream.info/api'])
export const NEAR_CHAIN = 'near:mainnet'
export const NEAR_PROVIDERS: readonly string[] = Object.freeze(['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'])
/** Zcash transparent (t1…) accounts over Blockchair's public API, as `@anywalletkit/wallet-zcash` reads and broadcasts them. */
export const ZCASH_CHAIN = 'zcash:mainnet'
export const ZCASH_BLOCKCHAIR = 'https://api.blockchair.com/zcash'

export interface ChainDescriptor {
  caip2: string
  key: 'solana' | 'ton' | 'tron' | 'btc' | 'near' | 'zcash'
  name: string
  symbol: string
  decimals: number
  explorerTx: string
  explorerAddress: string
}

export const NON_EVM_CHAINS: readonly ChainDescriptor[] = Object.freeze([
  { caip2: SOLANA_CHAIN, key: 'solana', name: 'Solana', symbol: 'SOL', decimals: 9, explorerTx: 'https://solscan.io/tx/', explorerAddress: 'https://solscan.io/account/' },
  { caip2: TON_CHAIN, key: 'ton', name: 'TON', symbol: 'GRAM', decimals: 9, explorerTx: 'https://tonviewer.com/transaction/', explorerAddress: 'https://tonviewer.com/' },
  { caip2: TRON_CHAIN, key: 'tron', name: 'Tron', symbol: 'TRX', decimals: 6, explorerTx: 'https://tronscan.org/#/transaction/', explorerAddress: 'https://tronscan.org/#/address/' },
  { caip2: BTC_CHAIN, key: 'btc', name: 'Bitcoin', symbol: 'BTC', decimals: 8, explorerTx: 'https://mempool.space/tx/', explorerAddress: 'https://mempool.space/address/' },
  { caip2: NEAR_CHAIN, key: 'near', name: 'NEAR', symbol: 'NEAR', decimals: 24, explorerTx: 'https://nearblocks.io/txns/', explorerAddress: 'https://nearblocks.io/address/' },
  { caip2: ZCASH_CHAIN, key: 'zcash', name: 'Zcash', symbol: 'ZEC', decimals: 8, explorerTx: 'https://blockchair.com/zcash/transaction/', explorerAddress: 'https://blockchair.com/zcash/address/' },
])

export const nonEvmChain = (caip2: string): ChainDescriptor | undefined => NON_EVM_CHAINS.find((c) => c.caip2 === caip2)
