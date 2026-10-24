#!/usr/bin/env node
// Read-only check against Base: the biggest listed USDC vault (from the Morpho
// API) is verified against the factories and described on-chain; the live
// cbBTC/USDC market is resolved from its id, its state accrued, position read,
// and a supply quote proven with eth_call. Nothing is sent. RPC: MORPHO_RPC.
import { createMockAccount } from '@anywalletkit/conformance'
import { MorphoApi, MorphoMarketProtocolEvm, MorphoVaultProtocolEvm } from '../dist/index.js'

const rpc = process.env.MORPHO_RPC ?? 'https://base-rpc.publicnode.com'
const chainId = Number(process.env.MORPHO_CHAIN ?? 8453)
const who = process.env.MORPHO_USER ?? '0x000000000000000000000000000000000000dEaD'
// Asset / market default to Base's USDC vaults and cbBTC/USDC market; on another chain
// leave them unset and the biggest listed vault / first listed market is taken from the API.
const USDC = process.env.MORPHO_ASSET ?? (chainId === 8453 ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' : undefined)
const MARKET_ENV = process.env.MORPHO_MARKET ?? (chainId === 8453 ? '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836' : undefined)

const account = createMockAccount({ chain: `eip155:${chainId}`, address: who }).toReadOnlyAccount()
const api = new MorphoApi()

console.log(USDC ? '--- API: listed vaults for ' + USDC : '--- API: listed vaults (biggest first)')
const vaults = (await api.listVaults({ chainId, ...(USDC ? { asset: USDC } : {}), first: 5 })).filter((v) => v.listed)
if (vaults.length === 0) throw new Error(`no listed Morpho vault on eip155:${chainId}`)
for (const v of vaults) console.log(`  ${v.version} ${v.symbol.padEnd(12)} ${v.name.padEnd(28)} netApy ${v.netApy?.toFixed(2)}%  tvl $${((v.totalAssetsUsd ?? 0) / 1e6).toFixed(1)}M  factory ${v.factory}`)
const top = vaults.find((v) => v.version === 'v1') ?? vaults[0]

console.log('--- vault on-chain', top.address)
const vault = new MorphoVaultProtocolEvm(account, { chainId, vault: top.address, provider: rpc })
const info = await vault.getVault()
console.log('  ', { version: info.version, factory: info.factory, name: info.name, asset: info.asset.symbol, totalAssets: String(info.totalAssets), fees: info.fees, timelock: info.timelockSeconds, sharePriceWad: String(info.sharePriceWad) })
console.log('   apy', (await vault.getApy()).toFixed(3), '% · position', await vault.getPosition())
try { console.log('   quoteSupply', await vault.quoteSupply({ amount: 10n ** 6n })) } catch (e) { console.log('   quoteSupply →', e.name, e.message) }

const MARKET = MARKET_ENV ?? (await api.listMarkets({ chainId, first: 1 }))[0]?.id
if (!MARKET) throw new Error(`no listed Morpho market on eip155:${chainId}`)
console.log('--- market', MARKET)
const market = new MorphoMarketProtocolEvm(account, { chainId, market: MARKET, provider: rpc })
const m = await market.getMarket()
console.log('  ', { loan: m.loan.symbol, collateral: m.collateral?.symbol, lltv: m.lltv, utilization: m.utilization.toFixed(4), borrowApy: m.borrowApy.toFixed(3), supplyApy: m.supplyApy.toFixed(3), liquidity: String(m.liquidity), price: String(m.price) })
const stats = await market.getStats()
console.log('   api', stats && { supplyApy: stats.supplyApy?.toFixed(3), borrowApy: stats.borrowApy?.toFixed(3), utilization: stats.utilization?.toFixed(4), listed: stats.listed })
console.log('   position', await market.getPosition())
try { console.log('   quoteSupply', await market.quoteSupply({ amount: 10n ** 6n })) } catch (e) { console.log('   quoteSupply →', e.name, e.message) }
console.log('ok')
