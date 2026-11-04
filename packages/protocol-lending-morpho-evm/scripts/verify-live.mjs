#!/usr/bin/env node
// Read-only check against Base: the biggest listed USDC Vault V1 (else the
// biggest V2; the Morpho API lists both) is verified against the factories and
// described on-chain; the live cbBTC/USDC market is resolved from its id, its
// state accrued, position read, and a supply quote proven with eth_call. Nothing is sent. RPC: MORPHO_RPC.
//
// Dead-deposit rule (shares at 0x…dEaD, checked before every supply): which vault
// or market is biggest is third-party state, so one that fails the rule is not a
// module failure. It prints a `WARN … FAILED (third-party state …)` line, which
// scripts/watch/canary.mjs reports as warn, and the run still exits 0, provided
// the module refuses its supply quote with MorphoDeadDepositError. A failed read,
// a quote that goes through anyway or any other error still fails the run.
import { createMockAccount } from '@anywalletkit/conformance'
import { MorphoApi, MorphoDeadDepositError, MorphoMarketProtocolEvm, MorphoVaultProtocolEvm } from '../dist/index.js'

const rpc = process.env.MORPHO_RPC ?? 'https://base-rpc.publicnode.com'
const chainId = Number(process.env.MORPHO_CHAIN ?? 8453)
const who = process.env.MORPHO_USER ?? '0x000000000000000000000000000000000000dEaD'
// Asset / market default to Base's USDC vaults and cbBTC/USDC market; on another chain
// leave them unset and the biggest listed vault / first listed market is taken from the API.
const USDC = process.env.MORPHO_ASSET ?? (chainId === 8453 ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' : undefined)
const MARKET_ENV = process.env.MORPHO_MARKET ?? (chainId === 8453 ? '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836' : undefined)

/** Quotes a supply; a target that fails the dead-deposit rule must be refused with the typed error. */
async function quoteChecked(label, protocol, dead) {
  if (dead.ok) {
    try { console.log('   quoteSupply', await protocol.quoteSupply({ amount: 10n ** 6n })) } catch (e) { console.log('   quoteSupply →', e.name, e.message) }
    return
  }
  const f = dead.failure
  console.log(`   WARN deadDeposit FAILED (third-party state, not a module failure): ${label} ${f.reason} ${f.observed} < ${f.required}; supplies are refused`)
  let refused = null
  try { await protocol.quoteSupply({ amount: 10n ** 6n }) } catch (e) { refused = e }
  if (!refused) throw new Error(`${label} fails the dead-deposit rule but quoteSupply went through: the gate is not applied`)
  if (!(refused instanceof MorphoDeadDepositError) || refused.reason !== f.reason) throw refused
  console.log(`   quoteSupply refused as expected (${refused.code}, ${refused.reason})`)
}

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
const vaultDead = await vault.getDeadDeposit()
console.log('   deadDeposit', vaultDead)
await quoteChecked(`vault ${info.name} ${top.address}`, vault, vaultDead)

const MARKET = MARKET_ENV ?? (await api.listMarkets({ chainId, first: 1 }))[0]?.id
if (!MARKET) throw new Error(`no listed Morpho market on eip155:${chainId}`)
console.log('--- market', MARKET)
const market = new MorphoMarketProtocolEvm(account, { chainId, market: MARKET, provider: rpc })
const m = await market.getMarket()
console.log('  ', { loan: m.loan.symbol, collateral: m.collateral?.symbol, lltv: m.lltv, utilization: m.utilization.toFixed(4), borrowApy: m.borrowApy.toFixed(3), supplyApy: m.supplyApy.toFixed(3), liquidity: String(m.liquidity), price: String(m.price) })
const stats = await market.getStats()
console.log('   api', stats && { supplyApy: stats.supplyApy?.toFixed(3), borrowApy: stats.borrowApy?.toFixed(3), utilization: stats.utilization?.toFixed(4), listed: stats.listed })
console.log('   position', await market.getPosition())
const marketDead = await market.getDeadDeposit()
console.log('   deadDeposit', marketDead)
await quoteChecked(`market ${m.collateral?.symbol ?? 'idle'}/${m.loan.symbol} ${MARKET}`, market, marketDead)
console.log('ok')
