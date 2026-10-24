# @anywalletkit/protocol-swap2-router

The optional swap2 aggregator. Every provider module (`-lifi`, `-near-intents`, `-thorchain`,
`-omniston`, `-cctp`, `-uniswap`, `-balancer`, `-wrap`) works on its own; install this package when
you want one protocol that auctions a route across the providers **you** pass in. It bundles none.

## Three ways to offer cross-chain swaps

**1. One protocol, no aggregator.** Install a single provider and use its own protocol class.

```ts
import {LifiSwap2Protocol} from "@anywalletkit/protocol-swap2-lifi";
const swap2 = new LifiSwap2Protocol(account, {fromChain: "eip155:1"});
```

**2. Aggregator picks for the user.** Quotes every provider in parallel, validates each quote the
same way and executes the winner.

```ts
import {RouterSwap2Protocol, usdValue} from "@anywalletkit/protocol-swap2-router";

const swap2 = new RouterSwap2Protocol(account, {
  fromChain: "eip155:1",
  providers: [lifiProvider({}), nearIntentsProvider({}), cctpProvider({rpcUrls})],
  valueUsd: usdValue(prices),   // optional: rank on net USD (see below)
  prefer: "best",               // or "fastest"
});
await swap2.swap2({fromToken: "USDC", toToken, toChain: "eip155:8453", fromTokenAmount, minAmountOut});
```

**3. Aggregator with a route picker.** List every route with the best and the fastest tagged, let
the user choose, then execute exactly that provider.

```ts
const routes = await swap2.quoteSwap2Routes(options, {
  // Called each time another provider answers: show the first price at once,
  // a "searching…" hint while `pending` is non-empty.
  onUpdate: (routes, pending) => render(routes, pending),
});
// routes[i] = {provider, quote, netValueUsd, relativeValue, tags: ["best"] | ["fastest"] | …}
await swap2.using(picked.provider).swap2({...options, minAmountOut: picked.quote.toTokenAmountMin});
```

The same is available one level down on `CrossChainRouter#getQuotes(params, {onUpdate})`.

## How the winner is chosen

1. **Value.** With `valueUsd` (e.g. `usdValue(prices, {gasUsd})`) each quote is worth its guaranteed
   output in USD minus what the route charges on top: a native bridge fee and, when you can say it,
   the source gas. Without prices for every quote the auction compares guaranteed outputs.
2. **Price first.** Quotes within `tieBand` (default 0.2%) of the best value are the same price.
3. **Speed and reliability inside the tie.** Among equal prices the faster, then the more reliable,
   route wins (`weights`, default `price:0.6,speed:0.3,reliability:0.1`). A sliver of extra output no
   longer beats a route that lands twenty times faster; a real price gap still wins.

`fastest` is always the lowest ETA. Every quote passes the engine's checks before it is ranked, and
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
