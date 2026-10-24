/**
 * Builtin networks: every mainnet the asset catalog (`@anywalletkit/swap2-assets`)
 * knows and a wallet package serves, with the public, CORS-open RPC failover
 * lists the mobile app and the extension share (no API keys here — a build
 * prepends its own keyed endpoints through `NetworksTable`), plus the default
 * testnets (shipped disabled).
 *
 * Endpoints were called on 2026-10-21 (see README for the ones that were not).
 */
import { ccChain } from '@anywalletkit/swap2-assets'
import type { Network, NetworkFamily } from './types.js'

const evm = (chainId: number, name: string, symbol: string, rpcs: string[], explorer?: string, kind: 'catalog' | 'testnet' = 'catalog'): Network => ({
  caip2: `eip155:${chainId}`,
  family: 'evm',
  name,
  symbol,
  decimals: 18,
  kind,
  rpcs,
  ...(explorer === undefined ? {} : { explorer }),
  source: 'builtin',
  enabled: kind === 'catalog',
})

/** EVM mainnets — the same lists as the mobile app's `RPC_URLS` and the extension's `DEFAULT_NETWORKS`. */
export const EVM_MAINNETS: readonly Network[] = Object.freeze([
  evm(1, 'Ethereum', 'ETH', ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'], 'https://etherscan.io'),
  evm(8453, 'Base', 'ETH', ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org'], 'https://basescan.org'),
  evm(56, 'BNB Chain', 'BNB', ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc.drpc.org'], 'https://bscscan.com'),
  evm(42161, 'Arbitrum', 'ETH', ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc', 'https://arbitrum.drpc.org'], 'https://arbiscan.io'),
  evm(10, 'Optimism', 'ETH', ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io', 'https://optimism.drpc.org'], 'https://optimistic.etherscan.io'),
  evm(137, 'Polygon', 'POL', ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'], 'https://polygonscan.com'),
  evm(43114, 'Avalanche', 'AVAX', ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc', 'https://avalanche.drpc.org'], 'https://snowtrace.io'),
  evm(999, 'HyperEVM', 'HYPE', ['https://rpc.hyperliquid.xyz/evm', 'https://hyperliquid.drpc.org', 'https://hyperliquid-json-rpc.stakely.io']),
  evm(4663, 'Robinhood Chain', 'ETH', ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood.drpc.org'], 'https://robinhoodchain.blockscout.com'),
  evm(324, 'zkSync Era', 'ETH', ['https://mainnet.era.zksync.io', 'https://zksync.drpc.org'], 'https://era.zksync.network'),
  evm(42220, 'Celo', 'CELO', ['https://forno.celo.org', 'https://celo.drpc.org'], 'https://celoscan.io'),
  evm(4326, 'MegaETH', 'ETH', ['https://mainnet.megaeth.com/rpc']),
  evm(130, 'Unichain', 'ETH', ['https://mainnet.unichain.org', 'https://unichain-rpc.publicnode.com'], 'https://uniscan.xyz'),
  evm(143, 'Monad', 'MON', ['https://rpc.monad.xyz']),
  evm(9745, 'Plasma', 'XPL', ['https://rpc.plasma.to']),
  evm(59144, 'Linea', 'ETH', ['https://rpc.linea.build', 'https://linea-rpc.publicnode.com'], 'https://lineascan.build'),
  evm(100, 'Gnosis', 'xDAI', ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com'], 'https://gnosisscan.io'),
  evm(146, 'Sonic', 'S', ['https://rpc.soniclabs.com', 'https://sonic-rpc.publicnode.com'], 'https://sonicscan.org'),
  evm(480, 'World Chain', 'ETH', ['https://worldchain-mainnet.g.alchemy.com/public', 'https://worldchain-mainnet.gateway.tenderly.co'], 'https://worldscan.org'),
  evm(1329, 'Sei', 'SEI', ['https://evm-rpc.sei-apis.com'], 'https://seitrace.com'),
  evm(57073, 'Ink', 'ETH', ['https://rpc-gel.inkonchain.com'], 'https://explorer.inkonchain.com'),
  evm(98866, 'Plume', 'PLUME', ['https://rpc.plume.org'], 'https://explorer.plume.org'),
  evm(196, 'X Layer', 'OKB', ['https://rpc.xlayer.tech', 'https://xlayerrpc.okx.com'], 'https://www.okx.com/web3/explorer/xlayer'),
  evm(534352, 'Scroll', 'ETH', ['https://rpc.scroll.io', 'https://scroll-rpc.publicnode.com'], 'https://scrollscan.com'),
  evm(80094, 'Berachain', 'BERA', ['https://rpc.berachain.com', 'https://berachain-rpc.publicnode.com'], 'https://berascan.com'),
  // Arc (Circle's L1): gas is USDC and the chain's native accounting (eth_getBalance, value, fees) is 18-decimal — the
  // 6-decimal USDC the catalog, LI.FI and CCTP address is the ERC-20 view at 0x3600…0000. One view at a time.
  evm(5042, 'Arc', 'USDC', ['https://rpc.mainnet.arc.io'], 'https://explorer.arc.io'),
  evm(5000, 'Mantle', 'MNT', ['https://rpc.mantle.xyz', 'https://mantle-rpc.publicnode.com'], 'https://mantlescan.xyz'),
  evm(747474, 'Katana', 'ETH', ['https://rpc.katana.network'], 'https://explorer.katanarpc.com'),
  evm(2818, 'Morph', 'ETH', ['https://rpc.morphl2.io', 'https://rpc-quicknode.morphl2.io'], 'https://explorer.morphl2.io'),
  evm(14, 'Flare', 'FLR', ['https://flare-api.flare.network/ext/C/rpc', 'https://flare.rpc.thirdweb.com'], 'https://flare-explorer.flare.network'),
])

// ---- non-EVM mainnets: the CAIP-2 ids the asset catalog / swap2 engine use, public endpoints only ----

export const SOLANA_CHAIN = 'solana:mainnet'
/** Shipped Solana mainnet endpoints. */
export const SOLANA_RPCS: readonly string[] = Object.freeze(['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'])
export const TON_CHAIN = 'ton:-239'
export const TON_ENDPOINTS: readonly string[] = Object.freeze(['https://ton.access.orbs.network/1/mainnet/toncenter-api-v2/jsonRPC', 'https://toncenter.com/api/v2/jsonRPC'])
export const TRON_CHAIN = 'tron:728126428'
export const TRON_PROVIDERS: readonly string[] = Object.freeze(['https://api.trongrid.io'])
/** Catalog id of Bitcoin mainnet. */
export const BTC_CHAIN = 'bitcoin:mainnet'
export const BTC_ESPLORA: readonly string[] = Object.freeze(['https://mempool.space/api', 'https://blockstream.info/api'])
export const NEAR_CHAIN = 'near:mainnet'
export const NEAR_PROVIDERS: readonly string[] = Object.freeze(['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'])
export const ZCASH_CHAIN = 'zcash:mainnet'
export const ZCASH_PROVIDERS: readonly string[] = Object.freeze(['https://api.blockchair.com/zcash'])

/** A non-EVM catalog chain: id, family, native currency and explorer links. */
export interface ChainDescriptor {
  caip2: string
  key: Exclude<NetworkFamily, 'evm'>
  name: string
  symbol: string
  decimals: number
  explorerTx: string
  explorerAddress: string
}

/** The non-EVM catalog chains. */
export const NON_EVM_CHAINS: readonly ChainDescriptor[] = Object.freeze([
  { caip2: SOLANA_CHAIN, key: 'solana', name: 'Solana', symbol: 'SOL', decimals: 9, explorerTx: 'https://solscan.io/tx/', explorerAddress: 'https://solscan.io/account/' },
  { caip2: TON_CHAIN, key: 'ton', name: 'TON', symbol: 'GRAM', decimals: 9, explorerTx: 'https://tonviewer.com/transaction/', explorerAddress: 'https://tonviewer.com/' },
  { caip2: TRON_CHAIN, key: 'tron', name: 'Tron', symbol: 'TRX', decimals: 6, explorerTx: 'https://tronscan.org/#/transaction/', explorerAddress: 'https://tronscan.org/#/address/' },
  { caip2: BTC_CHAIN, key: 'btc', name: 'Bitcoin', symbol: 'BTC', decimals: 8, explorerTx: 'https://mempool.space/tx/', explorerAddress: 'https://mempool.space/address/' },
  { caip2: NEAR_CHAIN, key: 'near', name: 'NEAR', symbol: 'NEAR', decimals: 24, explorerTx: 'https://nearblocks.io/txns/', explorerAddress: 'https://nearblocks.io/address/' },
  { caip2: ZCASH_CHAIN, key: 'zcash', name: 'Zcash', symbol: 'ZEC', decimals: 8, explorerTx: 'https://blockchair.com/zcash/transaction/', explorerAddress: 'https://blockchair.com/zcash/address/' },
])

/** A non-EVM catalog chain by id. */
export const nonEvmChain = (caip2: string): ChainDescriptor | undefined => NON_EVM_CHAINS.find((c) => c.caip2 === caip2)

const explorerBase = (txUrl: string): string => txUrl.replace(/\/(tx|transaction|txns)\/$/, '').replace(/\/#$/, '').replace(/\/$/, '')

const nonEvm = (d: ChainDescriptor, rpcs: readonly string[]): Network => ({
  caip2: d.caip2,
  family: d.key,
  name: d.name,
  symbol: d.symbol,
  decimals: d.decimals,
  kind: 'catalog',
  rpcs: [...rpcs],
  explorer: explorerBase(d.explorerTx),
  source: 'builtin',
  enabled: true,
})

const NON_EVM_RPCS: Record<string, readonly string[]> = {
  [SOLANA_CHAIN]: SOLANA_RPCS,
  [TON_CHAIN]: TON_ENDPOINTS,
  [TRON_CHAIN]: TRON_PROVIDERS,
  [BTC_CHAIN]: BTC_ESPLORA,
  [NEAR_CHAIN]: NEAR_PROVIDERS,
  [ZCASH_CHAIN]: ZCASH_PROVIDERS,
}

/** The non-EVM mainnets as networks, with their shipped endpoints. */
export const NON_EVM_MAINNETS: readonly Network[] = Object.freeze(NON_EVM_CHAINS.map((d) => nonEvm(d, NON_EVM_RPCS[d.caip2] ?? [])))

/** Every mainnet: EVM then the other families. */
export const CATALOG_NETWORKS: readonly Network[] = Object.freeze([...EVM_MAINNETS, ...NON_EVM_MAINNETS])

// ---- default testnets (owner decision 6) — shipped disabled; chain ids / genesis hashes checked against the live endpoints on 2026-10-21 ----

/** Solana devnet, as `@anywalletkit/wallet-solana` names it (`CAIP2_GENESIS.devnet`). */
export const SOLANA_DEVNET_CHAIN = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
/** Bitcoin testnet4 (genesis 00000000da84f2ba…, mempool.space/testnet4). `wallet-btc`'s `testnet` option (tb1…, coin type 1') serves it. */
export const BTC_TESTNET4_CHAIN = 'bip122:00000000da84f2bafbbc53dee25a72ae'
export const TON_TESTNET_CHAIN = 'ton:-3'
/** Tron Nile. `wallet-tron` also accepts `nile` and the genesis form `tron:0xcd8690dc`. */
export const TRON_NILE_CHAIN = 'tron:nile'
export const NEAR_TESTNET_CHAIN = 'near:testnet'
export const ZCASH_TESTNET_CHAIN = 'zcash:testnet'

const testnet = (family: Exclude<NetworkFamily, 'evm'>, caip2: string, name: string, symbol: string, decimals: number, rpcs: string[], explorer?: string): Network => ({
  caip2,
  family,
  name,
  symbol,
  decimals,
  kind: 'testnet',
  rpcs,
  ...(explorer === undefined ? {} : { explorer }),
  source: 'builtin',
  enabled: false,
})

/** Testnets the table ships switched off. */
export const DEFAULT_TESTNETS: readonly Network[] = Object.freeze([
  evm(11155111, 'Sepolia', 'ETH', ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org'], 'https://sepolia.etherscan.io', 'testnet'),
  evm(84532, 'Base Sepolia', 'ETH', ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'], 'https://sepolia.basescan.org', 'testnet'),
  evm(421614, 'Arbitrum Sepolia', 'ETH', ['https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia-rpc.publicnode.com'], 'https://sepolia.arbiscan.io', 'testnet'),
  evm(11155420, 'OP Sepolia', 'ETH', ['https://sepolia.optimism.io', 'https://optimism-sepolia-rpc.publicnode.com'], 'https://sepolia-optimism.etherscan.io', 'testnet'),
  evm(80002, 'Polygon Amoy', 'POL', ['https://polygon-amoy-bor-rpc.publicnode.com', 'https://polygon-amoy.drpc.org'], 'https://amoy.polygonscan.com', 'testnet'),
  evm(97, 'BSC testnet', 'tBNB', ['https://bsc-testnet-rpc.publicnode.com', 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'], 'https://testnet.bscscan.com', 'testnet'),
  evm(10143, 'Monad testnet', 'MON', ['https://testnet-rpc.monad.xyz'], 'https://testnet.monadexplorer.com', 'testnet'),
  testnet('solana', SOLANA_DEVNET_CHAIN, 'Solana devnet', 'SOL', 9, ['https://api.devnet.solana.com'], 'https://solscan.io?cluster=devnet'),
  testnet('btc', BTC_TESTNET4_CHAIN, 'Bitcoin testnet4', 'tBTC', 8, ['https://mempool.space/testnet4/api'], 'https://mempool.space/testnet4'),
  testnet('ton', TON_TESTNET_CHAIN, 'TON testnet', 'GRAM', 9, ['https://testnet.toncenter.com/api/v2/jsonRPC'], 'https://testnet.tonviewer.com'),
  testnet('tron', TRON_NILE_CHAIN, 'Tron Nile', 'TRX', 6, ['https://nile.trongrid.io'], 'https://nile.tronscan.org'),
  testnet('near', NEAR_TESTNET_CHAIN, 'NEAR testnet', 'NEAR', 24, ['https://rpc.testnet.near.org', 'https://test.rpc.fastnear.com'], 'https://testnet.nearblocks.io'),
  // No public Zcash testnet API answered on 2026-10-21 (Blockchair has no zcash/testnet route); the user supplies a Blockbook.
  testnet('zcash', ZCASH_TESTNET_CHAIN, 'Zcash testnet', 'TAZ', 8, []),
])

/** Mainnets and default testnets: what a fresh `NetworksTable` starts with. */
export const BUILTIN_NETWORKS: readonly Network[] = Object.freeze([...CATALOG_NETWORKS, ...DEFAULT_TESTNETS])

/** A built-in network (catalog mainnet or default testnet) by id. */
export const builtinNetwork = (caip2: string): Network | undefined => BUILTIN_NETWORKS.find((n) => n.caip2 === caip2)

/** `eip155:1` → `0x1`. */
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

/** Whether the asset catalog knows this chain — the gate for `wallet_addEthereumChain` on a catalog build. */
export function isCatalogChain(caip2: string): boolean {
  return ccChain(caip2) !== undefined
}

/** Chain family from a CAIP-2 namespace (`eip155`, `solana`, `ton`, `tron`, `bip122` / `bitcoin`, `near`, `zcash`). */
export function familyOf(caip2: string): NetworkFamily | null {
  const ns = caip2.split(':')[0]
  switch (ns) {
    case 'eip155': return 'evm'
    case 'solana': return 'solana'
    case 'ton': return 'ton'
    case 'tron': return 'tron'
    case 'bip122':
    case 'bitcoin': return 'btc'
    case 'near': return 'near'
    case 'zcash': return 'zcash'
    default: return null
  }
}
