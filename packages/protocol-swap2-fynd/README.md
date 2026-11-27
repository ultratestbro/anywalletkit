# @anywalletkit/protocol-swap2-fynd

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-swap2-fynd?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-fynd)

[Fynd](https://docs.fynd.xyz) — Propeller Heads' DEX aggregator — as a same-chain swap2 provider for Any Wallet Kit. Exact-input swaps on Ethereum, Base, Arbitrum, BNB Chain, Polygon, Unichain, Robinhood Chain, Arc and Elysium, routed over the pools Tycho indexes.

## Install

```sh
npm install @anywalletkit/protocol-swap2-fynd @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-swap2-fynd @anywalletkit/core  ·  yarn add @anywalletkit/protocol-swap2-fynd @anywalletkit/core
```

On npm: [@anywalletkit/protocol-swap2-fynd](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-fynd), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

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

**Routers.** `FYND_CHAINS` pins the active TychoRouterV3 from Propeller Heads' [deployment registry](https://github.com/propeller-heads/tycho/blob/main/crates/tycho-execution/config/deployment_registry.json):

| Chain | Router |
|---|---|
| Ethereum (1) | `0xe41c726421007e133a59365432fE886a73B45126` |
| Base (8453) | `0xd374c00614f95492D816b5957E3797ce3f0c445C` |
| Arbitrum (42161) | `0x1B82e8C16Ce8E17535C9B6b8AD107f61b0b192B5` |
| BNB Smart Chain (56) | `0xEe7eCe626064BDA1c6aFDb8A281afe44Eabd3242` |
| Polygon (137) | `0x4dB0B661dc706f7e09e54273028B22f61f8F94C2` |
| Unichain (130) | `0x556dff14e4A42259ebCE4fa087323c1047e9a55A` |
| Robinhood Chain (4663) | `0x6F460540B03651d2Ad0ec28f777e4A0480A756a5` |
| Arc (5042) | `0x52A1BC20F2B78461D7a03c32f6c7388D4587980f` |
| Elysium (99901) | `0x643577F3b0cB8CE1b1b73C6E872b907aCACD2662` |

On 2026-11-16 Propeller Heads paused every earlier router and redeployed TychoRouterV3 on every chain (registry commit `8aab890`). Versions up to 0.2.12 pin the paused routers and refuse every quote; upgrade. The paused routers stay in `FYND_PREVIOUS_ROUTERS`, which only `describeFyndActivity` reads, so past swaps keep their label in history; they are never a call target or a spender. Arc and Elysium were added after the redeploy, on its routers; no earlier router there was ever pinned, so they have no previous routers.

**Arc's native coin.** Arc pays gas in USDC with 18-decimal native accounting; the token catalog lists USDC only through its 6-decimal ERC-20 interface (`0x3600…`). Fynd prices a native leg on Arc in the 18-decimal units, so a swap with the native coin (zero address or the router's `0xEeee…` sentinel) on either side is refused there; swap the ERC-20 USDC instead. `fyndNativeSwaps(chainId)` says where native legs are allowed: wherever the catalog lists the chain's native coin (HYPE on Elysium, ETH, BNB, POL elsewhere).

**Not served yet: Plasma.** The registry lists a router on Plasma (9745), but the hosted API answers `unknown_chain` for it (2026-11-17), so it is not in `FYND_CHAINS`.

**Why `uniswap_v4_hooks` is excluded by default.** On 2026-10-24 every Ethereum route the hosted API built through Uniswap v4 hook pools was quoted about 0.6–1% above the market and reverted when simulated (4 of 4 native-input pairs, and USDT → USDC). The same pairs without those pools executed (8 of 8 across Ethereum, Base and Arbitrum). A route through an excluded family is refused even if the server returns one. The hosted API has neither its own simulation nor its price guard enabled, so these checks are the wallet's.

## Gas: `gasEstimate` and `gasLimit`

A quote states gas twice (see protocol-swap2-core, "Gas: `gasEstimate` vs `gasLimit`"):

- **`txRequest.gasLimit`** is `gas_estimate × 1.3 + 80 000`, unchanged: the bound the swap is sent with and the figure the engine's native-gas check counts.
- **`gasEstimate`** (`gasEstimateSource: "venue"`) is the gas the router call is expected to use, for comparing routes: Fynd's order-level `gas_estimate` plus `FYND_GAS_ESTIMATE_OVERHEAD`, which is **0**. No headroom and no approval (the router prices the approval itself). A quote whose order states no `gas_estimate` (or 0) carries none, rather than a made-up figure.

**Why the overhead is 0.** Fynd's `gas_estimate` is not the sum of its pools' estimates: it already carries Fynd's own model of the router around them (2 300–439 701 above that sum in the recordings). Measured 2026-11-28: 20 live quotes (`fixtures/quotes`) on Ethereum, Base, Arbitrum, BNB Chain, Polygon, Unichain and Robinhood Chain, recorded for a throwaway sender = receiver that holds nothing, each transaction run with `eth_simulateV1` right after the quote, at the chain's gas price and with the module's gas limit (the sender funded by a state override, a token input approved exactly in the same simulated block; nothing sent):

| | Gas used ÷ `gas_estimate` | Gas used − `gas_estimate` |
|---|---|---|
| 20 recordings | 0.71–1.54, median 0.99 | −152 010 … +73 820, median −2 633 |
| of them, one pool (15) | | median +3 105 |
| of them, several pools or a split (5) | | median −46 363 |
| 19 more quotes, simulated from real holders of the input at a zero gas price (not kept) | 0.70–1.16, median 0.91 | −221 933 … +39 313, median −37 474 |

So the router adds nothing measurable beyond Fynd's figure at the median. A split route tends to be over-estimated (by up to 152 000 here), a single-pool one is off either way (by up to +74 000 on an Ekubo USDT → USDC swap, +57 000 through `lunarbase` and PancakeSwap v3 on Base), and any constant would mis-state one side to help the other. The limit's headroom holds: no simulated swap used more than 82 % of its `gasLimit`. The receiver here held none of the output, so writing its first balance is in the figures (a receiver that already holds the token uses up to ~17 000 less); an exact approval spent to zero refunds 4 800, also in them. On Arbitrum the figures are L2 execution gas without the L1 data component (the router leaves the L1 data fee out too). `tests/gas-estimate.test.ts` recomputes the median from the recordings and holds the constant to it.

Six of the 20 live answers (five of the six on Base, one of the two on BNB Chain) are refused as they are, as before: their fee breakdown (router fee + client fee + max slippage + minimum) came 3 to 3 250 000 000 001 base units short of `amount_out`, and a breakdown that does not add up is refused (`price_check_failed`). Their simulations still count above: the transaction is Fynd's either way.

## Configure

```ts
import { fyndProvider } from '@anywalletkit/protocol-swap2-fynd'

const fynd = fyndProvider({
  apiKey: process.env.FYND_API_KEY,      // hosted API; keep it on your server (remoteProvider)
  // selfHosted: { 8453: 'https://fynd-base.internal' },  // or your own `fynd serve` per chain
  rpcUrls: { 8453: ['https://base.example/rpc'] },        // optional: pre-broadcast simulation + receipts
})
```

Behind `remoteProvider` (the API key on your server), the app wires the router pins and the
transaction check: `remoteProvider({name: "fynd", baseUrl, ...fyndPins})`. The engine then
accepts only the Tycho router in `FYND_CHAINS` as call target and spender, and re-runs
`checkFyndTransaction` on the client against the app's own request (input, tokens, recipient,
minimum, no client fee) — a backend cannot point the swap anywhere else. Without the pins the
stub gets no route.

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

## `blockNumber`

`QuoteParams.blockNumber` (one block for a comparison round) is not supported: the price comes from the Fynd API, so the quote names no block (`Quote.blockNumber` absent).

Apache-2.0 (this module's code). Fynd outputs: the Fynd License.
