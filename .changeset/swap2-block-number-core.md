---
"@anywalletkit/protocol-swap2-core": minor
"@anywalletkit/protocol-swap2-router": minor
---

One block per comparison round. `QuoteParams.blockNumber` (a decimal block of the source chain; `validBlockNumber`, `blockTagOf`): the app reads `eth_blockNumber` once per chain per round and hands it to every provider. A provider that prices on chain and honours it (`CrossChainProvider.honorsBlockNumber`) reads every price of the quote at that block and names it (`Quote.blockNumber`); providers that price from an API ignore it. Unset, nothing changes: "latest", every request as before.

- `quoteRejection` / `validQuote` refuse a quote naming a block other than the request's (`policy_refused`) and a malformed one (`upstream_unavailable`); a request whose `blockNumber` is not a decimal block number is the caller's error.
- The swap2 server takes `params.blockNumber` (digits only, no leading zero, at most a uint64; anything else is a 400 before the provider is asked) and seals `Quote.blockNumber` with the rest of the quote. `remoteProvider` forwards it and declares `honorsBlockNumber` only with `honorsBlockNumber: true`.
- `nodeLacksBlock(error)` / `blockLackedInBody(text)`: the texts nodes answer a block they do not have yet or no longer keep with (read live on the Uniswap, Curve and Balancer chains, 2026-11-28), for the providers that pin — they refuse as `stale_node` naming the block, never answer from "latest".
- Router: `getQuotes` / `getBestQuote` pass the field to every provider unchanged (candidates, a `routeId` request, an `only()` re-quote), and never pick a block; the provider snapshot carries `honorsBlockNumber`; a `blockNumber` that is not a decimal block number refuses the round before any provider is asked. `RouterSwap2Protocol.quoteSwap2Routes(options, {blockNumber})` takes it for a picker, and `Swap2Route.blockNumber` names the routes priced at it.

Deployment checks, simulations and gas estimates stay at "latest" whatever the field says. Pass it in the comparison round, not on the execution quote.
