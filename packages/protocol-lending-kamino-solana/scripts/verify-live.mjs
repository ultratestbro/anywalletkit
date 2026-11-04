// Live verification against Kamino's API and Solana mainnet, no keys and no
// writes: markets, reserves and vaults read; then the exact transactions the
// module would sign for the given wallet — an Earn vault deposit and a Lend
// deposit, and a Lend withdraw for a wallet that has supplied USDC — are built
// by the API and run through the wallet's serialized guard (program allowlist,
// the operation's instruction rules, bounds read from the chain, simulation
// with balance proof) as a read-only account. Pass a USDC holder to see the
// deposit proofs pass, and a USDC supplier on the main market for the withdraw.
// A holder whose USDC account is frozen cannot back a simulation: it is named
// and refused before anything is built.
//
//   node scripts/verify-live.mjs [address] [rpcUrl] [lendAddress]
import { WalletAccountReadOnlySolana } from '@anywalletkit/wallet-solana'
import {
  KLEND_PROGRAM, KaminoApi, KaminoMarketProtocolSolana, KaminoVaultProtocolSolana, MAIN_MARKET, associatedTokenAddress, decodeObligation, decodeReserve,
  depositedLiquidity, vanillaObligation,
} from '../dist/index.js'
import { TOKEN_PROGRAM, holderProblem, readTokenAccount } from './holder.mjs'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const STEAKHOUSE_USDC = 'HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E'
// Default: a busy exchange hot wallet with a large, unfrozen USDC account (~1.05M USDC, 22.8K SOL,
// ~3 transactions a minute on 2026-11-04), so the simulated deposits have funds to move. The previous
// default, 5tzFkiKs…uAi9, had its main USDC account frozen.
const address = process.argv[2] ?? process.env.LIVE_ADDRESS ?? 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'
const rpc = process.argv[3] ?? process.env.LIVE_RPC ?? process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com'
// Default: a long-held vanilla obligation on the main market with ~2.5M USDC supplied (2026-11-04).
const lendAddress = process.argv[4] ?? process.env.LIVE_LEND_ADDRESS ?? 'k9nmkzGVVtNKDKXzGRi8u3Y2pbaBLSVbaRjfmbh8zGV'

/** The wallet's USDC account must be usable before it backs a simulation; a frozen one ends the run. */
async function requireUsableUsdc(owner) {
  const tokenAccount = associatedTokenAddress(owner, USDC, TOKEN_PROGRAM)
  const problem = holderProblem(await readTokenAccount(rpc, tokenAccount, USDC, owner), { address: owner, tokenAccount, symbol: 'USDC' })
  if (problem) { console.error(problem); process.exit(1) }
}
await requireUsableUsdc(address)

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
const vault = new KaminoVaultProtocolSolana(account, { vault: STEAKHOUSE_USDC, asset: USDC })
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

// Lend withdraw, from a wallet that has USDC supplied on the main market's vanilla obligation. What it
// holds is read from the chain, as the guard reads it; the API's figure is printed beside it.
const lendAccount = lendAddress === address ? account : new WalletAccountReadOnlySolana(lendAddress, { provider: rpc })
const lender = lendAddress === address ? market : new KaminoMarketProtocolSolana(lendAccount)
const usdcReserve = (await lender.resolveReserve(USDC)).reserve
const obligation = vanillaObligation(lendAddress, MAIN_MARKET, KLEND_PROGRAM)
const [r, o] = await lendAccount.getAccountInfos([usdcReserve, obligation])
const supplied = o ? depositedLiquidity(decodeObligation(obligation, o), decodeReserve(usdcReserve, r ?? null), usdcReserve) : 0n
const reported = (await lender.getPosition()).supplied[USDC]
console.log(`${lendAddress}: ${Number(supplied) / 1e6} USDC supplied on chain (obligation ${obligation.slice(0, 6)}…), API position ${reported === undefined ? 'none' : `${Number(reported) / 1e6} USDC`}`)
if (supplied === 0n) {
  console.log('no USDC supplied — pass a USDC supplier on the main market as the third argument or LIVE_LEND_ADDRESS to simulate a Lend withdraw')
} else {
  await requireUsableUsdc(lendAddress)
  const take = supplied >= 5_000_000n ? 5_000_000n : supplied
  const wq = await lender.quoteWithdraw({ token: USDC, amount: take })
  console.log(`[lend withdraw ${Number(take) / 1e6} USDC ← reserve ${wq.reserve.slice(0, 6)}…] guard OK: ≥ ${wq.minReceived} base units, fee ${wq.fee} lamports`)
}
