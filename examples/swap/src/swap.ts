// The "Swaps and bridges" guide on docs.anywallet.tech renders the #region blocks of this file.

// #region imports
import type { IWalletAccount, Swap2Options } from '@anywalletkit/core'
import { RouterSwap2Protocol, type Swap2Route } from '@anywalletkit/protocol-swap2-router'
import { lifiProvider } from '@anywalletkit/protocol-swap2-lifi/provider'
import { nearIntentsProvider } from '@anywalletkit/protocol-swap2-near-intents/provider'
import { thorchainProvider } from '@anywalletkit/protocol-swap2-thorchain/provider'
import { chainflipProvider } from '@anywalletkit/protocol-swap2-chainflip/provider'
import { jupiterProvider } from '@anywalletkit/protocol-swap2-jupiter/provider'
import { cctpProvider } from '@anywalletkit/protocol-swap2-cctp/provider'
import { usdt0Provider } from '@anywalletkit/protocol-swap2-usdt0/provider'
import { uniswapProvider } from '@anywalletkit/protocol-swap2-uniswap/provider'
import { wrapProvider } from '@anywalletkit/protocol-swap2-wrap/provider'
import {
  Swap2FeeLimitError, Swap2InFlightError, Swap2InsufficientGasError, Swap2MaybeSentError, Swap2QuoteError,
} from '@anywalletkit/protocol-swap2-core'
// #endregion imports

// #region providers
const RPC = {
  1: ['https://ethereum-rpc.publicnode.com'],
  8453: ['https://base-rpc.publicnode.com'],
  42161: ['https://arbitrum-one-rpc.publicnode.com'],
} as const

export function providers() {
  return [
    // Cross-chain venues: their APIs quote and build the route.
    lifiProvider({}), // apiKey: raises LI.FI's rate limit
    nearIntentsProvider({}), // jwt: removes 1Click's fee
    thorchainProvider({}),
    chainflipProvider(), // native BTC / SOL / TRX and stables; no key, 0 bps
    cctpProvider({ rpcUrls: { 'eip155:1': RPC[1][0], 'eip155:8453': RPC[8453][0] } }),
    usdt0Provider({ rpcUrls: { 'eip155:1': RPC[1], 'eip155:42161': RPC[42161] } }), // RPC for each source chain
    // Same-chain venues priced straight from the contracts: no API, no key.
    uniswapProvider({ rpcUrls: RPC }),
    wrapProvider({ rpcUrls: RPC }),
    // Same-chain Solana: Jupiter's /build instructions, checked and assembled locally; apiKey optional.
    jupiterProvider({ rpcUrls: ['https://api.mainnet-beta.solana.com'] }),
  ]
}
// #endregion providers

// #region router
export function swapsFor(account: IWalletAccount): RouterSwap2Protocol {
  return new RouterSwap2Protocol(account, {
    fromChain: account.chain, // the source chain is the account's chain
    providers: providers(),
    prefer: 'best', // or 'fastest'
    // Progress for your UI: approving → requoting → preflight → signing → broadcast.
    onExecutionPhase: (phase, detail) => console.log('swap', phase, detail ?? ''),
  })
}
// #endregion router

// #region options
// 100 USDC on Ethereum → USDC on Base, delivered to the same address.
export async function usdcToBase(account: IWalletAccount): Promise<Swap2Options> {
  return {
    fromToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC on Ethereum (or the symbol 'USDC')
    toToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base: the destination chain's own id
    toChain: 'eip155:8453',
    fromTokenAmount: 100_000_000n, // 100 USDC, 6 decimals
    recipient: await account.getAddress(),
  }
}
// #endregion options

// #region quote
export async function bestQuote(swaps: RouterSwap2Protocol, options: Swap2Options) {
  const quote = await swaps.quoteSwap2(options) // asks every provider in parallel, nothing is signed
  return {
    receive: quote.toTokenAmount, // expected output
    atLeast: quote.toTokenAmountMin, // guaranteed output: show this one
    seconds: quote.estimatedDuration,
    fees: quote.fees, // network / protocol / affiliate, each in its own token
  }
}
// #endregion quote

// #region routes
export async function routePicker(
  swaps: RouterSwap2Protocol,
  options: Swap2Options,
  render: (routes: Swap2Route[], searching: boolean) => void,
): Promise<Swap2Route[]> {
  return swaps.quoteSwap2Routes(options, {
    // Called each time another provider answers: show the first price at once.
    onUpdate: (routes, pending) => render(routes, pending.length > 0),
  })
}
// route = { provider, quote, netValueUsd, relativeValue, tags: ['best'] | ['fastest'] | … }
// #endregion routes

// #region execute
export async function execute(swaps: RouterSwap2Protocol, options: Swap2Options, route: Swap2Route) {
  const result = await swaps
    .using(route.provider) // exactly the route the user picked
    .swap2({ ...options, minAmountOut: route.quote.toTokenAmountMin }) // never accept less than you showed
  return result.id // keep it: status, claims and support all start from this id
}
// #endregion execute

// #region review
export function swapsWithReview(account: IWalletAccount, confirm: (text: string) => Promise<boolean>) {
  return new RouterSwap2Protocol(account, {
    fromChain: account.chain,
    providers: providers(),
    // Runs after every check passed and BEFORE the first approval or signature.
    // It receives exactly what will be signed; throwing cancels with nothing sent.
    reviewExecution: async (plan) => {
      const ok = await confirm(
        `${plan.sourceAmount} → at least ${plan.minDestAmount} on ${plan.destChain} via ${plan.provider}, ` +
          `${plan.approvals.length} approval(s), ~${plan.etaSeconds}s`,
      )
      if (!ok) throw new Error('cancelled by the user')
    },
  })
}
// #endregion review

// #region status
const DONE = new Set(['completed', 'failed', 'refunded', 'cancelled', 'expired', 'partial'])

export async function waitForDelivery(
  swaps: RouterSwap2Protocol,
  id: string,
  destinationAccount: () => Promise<IWalletAccount>,
) {
  for (;;) {
    const { status, transactions } = await swaps.getSwap2Status(id)
    if (status === 'action-required') {
      // Two-phase routes (CCTP): the mint is a transaction on the DESTINATION chain,
      // signed by the user's account there and paid in that chain's gas.
      await swaps.claimSwap2(id, await destinationAccount())
    } else if (DONE.has(status)) {
      return { status, transactions }
    }
    await new Promise((r) => setTimeout(r, 10_000))
  }
}
// #endregion status

// #region errors
export async function swapSafely(swaps: RouterSwap2Protocol, options: Swap2Options) {
  try {
    return await swaps.swap2(options)
  } catch (e) {
    if (e instanceof Swap2MaybeSentError) {
      // The broadcast may have reached the network. Do NOT retry: track e.id / e.hash.
      return { pending: e.id ?? e.hash }
    }
    if (e instanceof Swap2InFlightError) return null // the same swap is already running (double tap)
    if (e instanceof Swap2InsufficientGasError) throw new Error('Not enough native coin for gas')
    if (e instanceof Swap2FeeLimitError) throw new Error('Fees are above your cap')
    if (e instanceof Swap2QuoteError) throw new Error('No route right now: ' + e.message)
    throw e
  }
}
// #endregion errors
