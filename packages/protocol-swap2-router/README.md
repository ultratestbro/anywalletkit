# @anywalletkit/protocol-swap2-router

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-swap2-router?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-router)

The optional swap2 aggregator. Every provider module (`-lifi`, `-near-intents`, `-thorchain`,
`-omniston`, `-cctp`, `-uniswap`, `-balancer`, `-wrap`) works on its own; install this package when
you want one protocol that auctions a route across the providers **you** pass in. It bundles none.

## Install

```sh
npm install @anywalletkit/protocol-swap2-router @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-swap2-router @anywalletkit/core  ·  yarn add @anywalletkit/protocol-swap2-router @anywalletkit/core
```

On npm: [@anywalletkit/protocol-swap2-router](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-router), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

## Three ways to offer cross-chain swaps

**1. One protocol, no aggregator.** Install a single provider and use its own protocol class.

```ts
import {LifiSwap2Protocol} from "@anywalletkit/protocol-swap2-lifi";
const swap2 = new LifiSwap2Protocol(account, {fromChain: "eip155:1"});
```

**2. Aggregator picks for the user.** Quotes every provider in parallel, validates each quote the
same way and executes the winner.

```ts
import {RouterSwap2Protocol, evmSourceGas, usdValue} from "@anywalletkit/protocol-swap2-router";

const swap2 = new RouterSwap2Protocol(account, {
  fromChain: "eip155:1",
  providers: [lifiProvider({}), nearIntentsProvider({}), cctpProvider({rpcUrls})],
  valueUsd: usdValue(prices),   // optional: rank on net USD (see below)
  sourceGasUsd: evmSourceGas({prices, rpcUrl: (chain) => rpcUrls[chain]}), // optional: and net of the source gas
  prefer: "best",               // or "fastest"
});
await swap2.swap2({fromToken: "USDC", toToken, toChain: "eip155:8453", fromTokenAmount, minAmountOut});
```

**3. Aggregator with a route picker.** List every route with the best and the fastest tagged, let
the user choose, then execute that provider and route.

```ts
const routes = await swap2.quoteSwap2Routes(options, {
  // Called each time another provider answers: show the first price at once,
  // a "searching…" hint while `pending` is non-empty.
  onUpdate: (routes, pending) => render(routes, pending),
});
// routes[i] = {provider, routeId?, quote, netValueUsd, gasUsd, gasEstimate?, gasEstimateSource?, relativeValue, tags: ["best"] | ["fastest"] | …}
await swap2.using(picked.provider, picked.routeId).swap2({...options, minAmountOut: picked.quote.toTokenAmountMin});
```

The same is available one level down on `CrossChainRouter#getQuotes(params, {onUpdate})`.

A provider can implement optional `getQuotes(params, signal)` to return up to 32
display candidates with unique, stable `routeId` values (for example, Taxi and Bus).
Its default `getQuote` answer must also identify its route.
Each candidate is validated and ranked independently. Missing or duplicate selectors
are excluded, as are expired quotes and quotes below the caller's floor. Provider
failures leave other venues available. Progressive snapshots have independent quote
data, and expired candidates are removed before the final ranking.

Execution calls `getQuote` once per provider with `dry: false`; it never creates live
quotes for every candidate. A selected `routeId` must be returned unchanged, even if
the provider's default or cheapest mode changed. A quote that expires during approval
is refreshed using the same provider, route and caller floor; failure stops the swap
and attempts to revoke the engine-created allowance (or leaves it, with
`revokeUnspentApproval: false`). The selected route is included
in `reviewExecution`. The engine's approval options (`allowanceReuse`, `revokeUnspentApproval`; see
protocol-swap2-core's "Approvals") go on this config like any engine option, carry over to
`using(provider, routeId)`, and can be set for one execution as `swap2(options, {allowanceReuse: "sufficient"})`. Providers without `getQuotes` and callers using only
`using(provider)` retain the existing API; choosing a particular candidate requires
passing its `routeId`.

Remote providers opt in with `remoteProvider({name, baseUrl, multiQuotes: true, ...pins})`
after their backend supports the `/quotes` action. Omit that flag for older servers.
The new action requires `dry: true`, applies the same guard, seals each accepted quote
including its selector, and leaves `/quote` unchanged. Client-side provider validators
must also bind calldata to the mode represented by `routeId`; string equality alone
does not validate a transaction's behavior.

## How the winner is chosen

1. **Value.** With `valueUsd` (e.g. `usdValue(prices, {gasUsd})`) each quote is worth its guaranteed
   output in USD minus what the route charges on top: a native bridge fee and, when you can say it,
   the source gas. The fee is the transaction's `txRequest.nativeFee`; a price-only quote, which carries
   no transaction (a dry LI.FI quote without the sender), declares it as `providerData.nativeFee`, read only
   when there is no `txRequest` (a value that is not a base-unit integer leaves the quote unpriced).
   Without prices for every quote the auction compares guaranteed outputs.
   With `sourceGasUsd` the source gas comes off too (EVM sources), so a route whose swap a third party
   pays for (`quote.gasless`: a CoW solver, an Omniston resolver) is compared on what the user really gets.
   `evmSourceGas({prices, rpcUrl})` counts the venue's `txRequest.gasLimit` (capped at 3M; 250k when it names
   none) for a calldata route, a transfer (21k native, 65k ERC-20) for a deposit-address route, nothing for a
   gasless one, plus 50k for an ERC-20 approval of the route's spender unless `params.sender`'s allowance
   already covers the amount; at the chain's `eth_gasPrice` (cached 15 s) and the native coin's price. It is an
   estimate from the quote, not a dry run (a dry quote has no funded sender to run it from), and leaves out an
   L2's L1 data fee. Each quote is asked once as it arrives (3 s at most); when any quote of the auction has no
   answer, gas comes off no quote, so the comparison stays like for like. `RankedQuote.gasUsd` and
   `Swap2Route.gasUsd` say what was subtracted.

   `evmSourceGas({prices, rpcUrl, useGasEstimate: true})` counts, for a quote that has one, the gas its source
   transaction is expected to use instead (`quote.gasEstimate`, see protocol-swap2-core's "Gas: `gasEstimate` vs
   `gasLimit`"), kept between 21k and 3M; a quote without one is counted as above, and the approval is added the
   same way. Off by default: an app that does not set it ranks exactly as before (`swapGasUnits(quote, params,
   {useGasEstimate})` likewise). What changes with it: a venue whose limit carries headroom (Fynd's is its
   estimate × 1.3 + 80 000) is no longer charged for it, and a quote without a transaction that states its gas (a
   dry KyberSwap quote, a 0x price) is charged that figure instead of a plain transfer (65k), several times more.
   The figures are not all alike: 0x's and KyberSwap's run about a third above the gas used, Fynd's, Uniswap's,
   Curve's and Balancer's near it (the table in protocol-swap2-core's README), so the comparison is fairer than on
   gas limits, not exact. A `gasEstimate` is the venue's or the module's word, as a gas limit was: core holds it to
   its contract (at most the gas limit, `"0"` only when gasless) and the router to at least 21k, nothing more.
   `Swap2Route.gasEstimate` / `gasEstimateSource` carry the quote's figure either way.

   A one-cent race stays a one-cent race. 2026-11-27 on Ethereum Fynd quoted 294.50 USDC against CoW's 294.49
   (gasless): Fynd's own recording of a comparable route that evening (USDT → USDC through Ekubo, block
   26,509,322, `protocol-swap2-fynd/fixtures/quotes/ethereum-usdt-usdc.json`) priced its 136,311-gas estimate at
   $0.00997 — the whole lead — and the transaction used 210,131 gas when simulated. With `tieBand: 0` that is a
   tie to a hundredth of a cent on the estimate and a CoW win on the gas really used; with the default band the two
   are the same price and speed and reliability decide (step 3). The estimate removes the headroom from the
   comparison; it does not decide a race smaller than the gas itself.
2. **Price first.** Quotes within `tieBand` (default 0.2%) of the best value are the same price.
3. **Speed and reliability inside the tie.** Among equal prices the faster, then the more reliable,
   route wins (`weights`, default `price:0.6,speed:0.3,reliability:0.1`). A sliver of extra output no
   longer beats a route that lands twenty times faster; a real price gap still wins.

`fastest` is the lowest known ETA, or `null` when all ETAs are unknown. Unknown
`etaSeconds: null` gets no speed bonus or fastest tag; `prefer: "fastest"` falls back
to the best route when no estimate exists. Every quote passes the engine's checks before it is ranked, and
the executed route is re-validated against its sealed quote before anything is signed.

## Activity

The router executes through whichever provider wins, so it has no transactions
of its own: `describeActivity(tx, ctx)` asks every installed provider in order
and returns the first description (null when none claims the transaction, or
when the router holds no providers). Each provider package documents what it
recognizes (`@anywalletkit/protocol-swap2-lifi` → LI.FI Diamond calls,
`-thorchain` → router `depositWithExpiry` / `transferOut`, `-cctp` → burn and
claim, `-uniswap` / `-balancer` / `-wrap` → the DEX router / Vault / WETH9 calls,
`-omniston` → STON.fi router and Omniston escrow on TON, `-near-intents` → the
`intents.near` legs). The conformance fixture here is a public WETH9 deposit
recognized by an in-test provider, proving the delegation; the negative is a
LI.FI swap no installed provider claims.
