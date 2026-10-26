#!/usr/bin/env node
// Live check on Ethereum and Solana mainnet, nothing signed: tokens read from the chain and
// assessed, then tokens outside the swap catalog quoted through the real router and providers
// (the same code an app runs) with `allowUnlistedTokens`, and refused without it.
//
//   node scripts/verify-live.mjs            (EVM_RPC=… SOLANA_RPC=… to use your own endpoints)
//
// Monorepo only: the swap providers are imported from their sibling packages' dist (pnpm build first).
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WalletAccountReadOnlyEvm } from '@anywalletkit/wallet-evm'
import { WalletAccountReadOnlySolana } from '@anywalletkit/wallet-solana'
import { inspectToken, swapSource } from '../dist/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = (name, file = 'index.js') => import(pathToFileURL(resolve(here, '../..', name, 'dist', file)).href)
const { RouterSwap2Protocol } = await pkg('protocol-swap2-router')
const { lifiProvider } = await pkg('protocol-swap2-lifi', 'provider.js')
const { uniswapProvider } = await pkg('protocol-swap2-uniswap', 'provider.js')
const { balancerProvider } = await pkg('protocol-swap2-balancer', 'provider.js')
const { jupiterProvider } = await pkg('protocol-swap2-jupiter', 'provider.js')

const EVM_RPC = process.env.EVM_RPC ?? 'https://ethereum-rpc.publicnode.com'
const SOLANA_RPC = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com'
const EVM_ADDR = '0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA'
const SOL_ADDR = '2tKRnQTAXmryVYxDNSajdZg1DfX2FbHKNboWr5EBiKhW'
const PEPE = '0x6982508145454Ce325dDbE47a25d4ec3d2311933'
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

let failures = 0
async function step(name, run) {
  try {
    const out = await run()
    console.log(`ok   ${name}${out === undefined ? '' : ` — ${out}`}`)
  } catch (e) {
    failures++
    console.log(`FAIL ${name} — ${String(e?.message ?? e).replace(/https?:\/\/\S+/g, '<url>').slice(0, 300)}`)
  }
}
const describe = (r) => (r.listed ? `listed: ${r.listed.symbol}` : `${r.token.symbol} / ${r.token.name}, ${r.token.decimals} dec, ${r.token.standard}, ${r.assessment.level}: ${r.assessment.risks.map((x) => x.code).join(', ')}`)
const expectRefusal = async (run, pattern) => {
  try { await run() } catch (e) { if (pattern.test(String(e?.message ?? e))) return `refused (${e.name})`; throw e }
  throw new Error('was not refused')
}

// ── Reading and assessing ────────────────────────────────────────────────────
const evm = new WalletAccountReadOnlyEvm(EVM_ADDR, { provider: EVM_RPC, chainId: 1 })
const sol = new WalletAccountReadOnlySolana(SOL_ADDR, { provider: SOLANA_RPC })
await step('inspect PEPE (Ethereum, unlisted)', async () => describe(await inspectToken(evm, PEPE)))
await step('inspect USDC (Ethereum, in the catalog)', async () => describe(await inspectToken(evm, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')))
await step('inspect MKR (bytes32 symbol)', async () => describe(await inspectToken(evm, '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2')))
await step('inspect BAYC (an NFT) is refused', () => expectRefusal(() => inspectToken(evm, '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D'), /not a token/))
await step('inspect BONK (Solana, unlisted)', async () => describe(await inspectToken(sol, BONK)))
await step('inspect JUP (Solana, unlisted)', async () => describe(await inspectToken(sol, 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN')))
await step('inspect a wallet address on Solana is refused', () => expectRefusal(() => inspectToken(sol, SOL_ADDR), /not a token/))

// ── Swapping tokens the catalog does not list ────────────────────────────────
const venueRpc = { 1: [EVM_RPC] }
const evmProviders = () => [lifiProvider(), uniswapProvider({ rpcUrls: venueRpc }), balancerProvider({ rpcUrls: venueRpc })]
const routes = (rs) => rs.map((r) => `${r.provider} ${r.quote.toTokenAmount}`).join(' | ') || 'none'
const open = new RouterSwap2Protocol(evm, { fromChain: 'eip155:1', providers: evmProviders(), allowUnlistedTokens: true })
const closed = new RouterSwap2Protocol(evm, { fromChain: 'eip155:1', providers: evmProviders() })
const pepeSell = { fromToken: PEPE, toToken: 'USDC', fromTokenAmount: 10_000_000n * 10n ** 18n, recipient: EVM_ADDR }
await step('quote 10M PEPE → USDC on Ethereum (decimals read from the chain)', async () => {
  const rs = await open.quoteSwap2Routes(pepeSell)
  if (!rs.length) throw new Error('no route')
  return routes(rs)
})
await step('the same without allowUnlistedTokens is refused', async () => {
  const rs = await closed.quoteSwap2Routes(pepeSell).catch((e) => { throw e })
  if (rs.length) throw new Error(`quoted anyway: ${routes(rs)}`)
  return 'no routes'
})
await step('quote 100 USDC → PEPE on Ethereum', async () => routes(await open.quoteSwap2Routes({ fromToken: 'USDC', toToken: PEPE, fromTokenAmount: 100_000_000n, recipient: EVM_ADDR })))
await step('quote 10M PEPE (Ethereum) → USDC on Base (cross-chain)', async () => routes(await open.quoteSwap2Routes({ ...pepeSell, toChain: 8453, toToken: BASE_USDC })))
await step('a fromTokenDecimals that disagrees with the chain is refused', () => expectRefusal(() => open.quoteSwap2Routes({ ...pepeSell, fromTokenDecimals: 9 }), /does not match/))

const jup = new RouterSwap2Protocol(sol, { fromChain: 'solana:mainnet', providers: [jupiterProvider({ rpcUrls: [SOLANA_RPC] }), lifiProvider()], allowUnlistedTokens: true })
await step('quote 2M BONK → USDC on Solana', async () => routes(await jup.quoteSwap2Routes({ ...swapSource({ address: BONK, decimals: 5 }), toToken: SOL_USDC, fromTokenAmount: 2_000_000n * 10n ** 5n, recipient: SOL_ADDR })))
await step('quote 20 USDC → BONK on Solana', async () => routes(await jup.quoteSwap2Routes({ fromToken: 'USDC', toToken: BONK, fromTokenAmount: 20_000_000n, recipient: SOL_ADDR })))

console.log(failures ? `\n${failures} live check(s) failed` : '\nall live checks passed')
process.exit(failures ? 1 : 0)
