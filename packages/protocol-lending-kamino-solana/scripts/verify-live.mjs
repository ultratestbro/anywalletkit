// Live verification against Kamino's API and Solana mainnet, no keys and no
// writes: markets, reserves and vaults read; then the exact transactions the
// module would sign for the given wallet — an Earn vault deposit and a Lend
// deposit — are built by the API and run through the wallet's serialized
// guard (program allowlist + simulation with balance proof) as a read-only
// account. Pass a USDC holder to see both proofs pass.
//
//   node scripts/verify-live.mjs [address] [rpcUrl]
import { WalletAccountReadOnlySolana } from '@forgewallet/wallet-solana'
import { KaminoApi, KaminoMarketProtocolSolana, KaminoVaultProtocolSolana, MAIN_MARKET } from '../dist/index.js'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const STEAKHOUSE_USDC = 'HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E'
// Default: a large USDC holder, so the simulated deposits have funds to move.
const address = process.argv[2] ?? process.env.LIVE_ADDRESS ?? '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'
const rpc = process.argv[3] ?? process.env.LIVE_RPC ?? process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com'

const api = new KaminoApi()
const markets = await api.listMarkets()
console.log(`markets: ${markets.length}; primary ${markets.filter((m) => m.isPrimary).map((m) => `${m.name} ${m.lendingMarket}`).join(', ')}`)
const reserves = await api.getReserves(MAIN_MARKET)
const top = [...reserves].sort((a, b) => b.totalSupplyUsd - a.totalSupplyUsd).slice(0, 6)
console.log(`main market reserves: ${reserves.length}; top by supplied: ${top.map((r) => `${r.symbol} ${r.supplyApy.toFixed(2)}% $${(r.totalSupplyUsd / 1e6).toFixed(1)}M`).join(' · ')}`)
const vaults = await api.listVaults()
const usdcVaults = vaults.filter((v) => v.tokenMint === USDC).sort((a, b) => Number(b.sharesIssued - a.sharesIssued)).slice(0, 5)
console.log(`vaults: ${vaults.length}; USDC vaults by shares: ${usdcVaults.map((v) => `${v.name} (${v.address.slice(0, 6)}…)`).join(' · ')}`)

const account = new WalletAccountReadOnlySolana(address, { provider: rpc })
const vault = new KaminoVaultProtocolSolana(account, { vault: STEAKHOUSE_USDC })
const info = await vault.getVault()
console.log(`vault ${info.name}: ${info.asset.symbol} apy ${info.apy.toFixed(2)}% (7d ${info.apy7d.toFixed(2)}%) tvl $${(Number(info.totalAssets) / 1e6 / 1e6).toFixed(1)}M holders ${info.holders} fees perf ${info.fees.performanceBps} bps, farm ${info.farm ?? 'none'}`)
const position = await vault.getPosition()
console.log(`position: ${position.shares} shares ≈ ${Number(position.assets) / 1e6} USDC (${position.stakedShares} staked)`)

const usdc = await account.getTokenBalance(USDC).catch(() => 0n)
console.log(`${address}: ${Number(usdc) / 1e6} USDC, ${Number(await account.getBalance()) / 1e9} SOL`)
const amount = usdc >= 5_000_000n ? 5_000_000n : usdc
if (amount === 0n) { console.log('no USDC to simulate with — pass a USDC holder'); process.exit(0) }

const q = await vault.quoteSupply({ amount })
console.log(`[vault deposit ${Number(amount) / 1e6} USDC] guard OK: fee ${q.fee} lamports, expected ${q.expectedShares} shares`)

const market = new KaminoMarketProtocolSolana(account)
const mq = await market.quoteSupply({ token: USDC, amount })
console.log(`[lend deposit ${Number(amount) / 1e6} USDC → reserve ${mq.reserve.slice(0, 6)}…] guard OK: fee ${mq.fee} lamports`)
const pos = await market.getPosition()
console.log(`lend position: ${pos.obligations.length} obligation(s); supplied ${JSON.stringify(Object.fromEntries(Object.entries(pos.supplied).map(([k, v]) => [k.slice(0, 6), String(v)])))}`)
if (position.shares > 0n) {
  const w = await vault.quoteWithdraw({ amount: 'max' })
  console.log(`[vault withdraw max] guard OK: ${w.shares} shares → ≥ ${w.minAssets} USDC base units, fee ${w.fee}`)
}
