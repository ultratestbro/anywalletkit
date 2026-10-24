# @anywalletkit/protocol-swap2-fynd

[Fynd](https://docs.fynd.xyz) — Propeller Heads' DEX aggregator — as a same-chain swap2 provider for Any Wallet Kit. Exact-input swaps on Ethereum, Base, Arbitrum, BNB Chain, Polygon, Unichain and Robinhood Chain, routed over the pools Tycho indexes.

> **Fynd License.** Quotes, routes and transactions produced by Fynd are licensed under the [Fynd License](https://github.com/propeller-heads/fynd/blob/main/LICENSE.md). In short:
> - every swap built from a Fynd quote must settle through the Tycho router for its chain (the [router registry](https://docs.propellerheads.xyz/tycho/for-solvers/execution/contract-addresses)), with its fees intact, and must not be re-routed around it;
> - the router may take a platform fee and keeps positive slippage;
> - if you earn revenue on such swaps (your own fees, spreads), Propeller Heads is owed a share of it, with reporting.
>
> This module only ever sends the router transaction Fynd encoded. Read the license before you ship it.

## What the module checks

Before anything is approved or signed, the encoded transaction is decoded and checked against the request:
- it targets the pinned TychoRouterV3 for that chain;
- the method is a plain `singleSwap`, `sequentialSwap` or `splitSwap` (no Permit2, no vault funds);
- it spends exactly the requested amount of the requested token, for the requested output token;
- it pays the user, not anyone else;
- the expected output and the minimum match the quote, and Fynd's fee breakdown adds up;
- it carries no client fee.

The router reverts below the minimum. With `rpcUrls` set, the exact transaction is also simulated: at quote time for native input (no allowance needed), and right before broadcast for every swap.

**Why `uniswap_v4_hooks` is excluded by default.** On 2026-10-24 every Ethereum route the hosted API built through Uniswap v4 hook pools was quoted about 0.6–1% above the market and reverted when simulated (4 of 4 native-input pairs, and USDT → USDC). The same pairs without those pools executed (8 of 8 across Ethereum, Base and Arbitrum). A route through an excluded family is refused even if the server returns one. The hosted API has neither its own simulation nor its price guard enabled, so these checks are the wallet's.

## Configure

```ts
import { fyndProvider } from '@anywalletkit/protocol-swap2-fynd'

const fynd = fyndProvider({
  apiKey: process.env.FYND_API_KEY,      // hosted API; keep it on your server (remoteProvider)
  // selfHosted: { 8453: 'https://fynd-base.internal' },  // or your own `fynd serve` per chain
  rpcUrls: { 8453: ['https://base.example/rpc'] },        // optional: pre-broadcast simulation + receipts
})
```

| Option | Default | Meaning |
|---|---|---|
| `apiKey` | none | Hosted API key from Propeller Heads, sent as the raw `Authorization` header. |
| `baseUrl` | `https://fynd-api.propellerheads.xyz` | Hosted API; requests go to `{baseUrl}/v1/{chain}/quote`. |
| `selfHosted` | none | `{ chainId: url }` — your own Fynd servers; requests go to `{url}/v1/quote`, without a key. |
| `rpcUrls` | none | `{ chainId: [url…] }` for simulation and receipts. |
| `defaultSlippageBps` | `50` | Used when the caller passes none. |
| `quoteTtlMs` | `30000` | Fynd prices at one block; the engine re-checks this before broadcast. |
| `excludeProtocols` | `["uniswap_v4_hooks"]` | Liquidity Fynd must not route through (names, or family prefixes ending in `:`). |

A chain is served when it has a self-hosted server or the hosted API key is set.

## Not supported (yet)

- Exact-output swaps — Fynd only sells an exact input.
- A swap deadline. The router enforces a deadline only through a signed client-fee message; this module sends no client-fee parameters, so the on-chain protection is the minimum output.
- Integrator fees.

Apache-2.0 (this module's code). Fynd outputs: the Fynd License.
