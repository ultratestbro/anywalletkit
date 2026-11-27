---
"@anywalletkit/protocol-swap2-uniswap": minor
---

`QuoteParams.blockNumber`: every price read of a quote goes to that block and the quote names it (`Quote.blockNumber`; `honorsBlockNumber: true`) — v3's QuoterV2 candidates and 1/1000 probe, with `maxPriceImpactBps` the probe, `getPool` and `slot0()` (the block the gate pinned itself before: no `eth_blockNumber`), v4's discovery, V4Quoter aggregates, gas re-reads and probe, and the block gas limit the routes are bounded by (`eth_getBlockByNumber` of that block, kept per block; a node without the block is retried at the next endpoint, and when none gives it the chain's newest gas limit in hand stands in — never a new read at "latest"). With `venueRoutes: "both"` both candidates come from that one block.

- At "latest" whatever it says: the deployment checks, the token-input simulation (`eth_simulateV1` and its fallbacks), `preflightDeposit` and the engine's own gas estimate. The impact gate, the gas bound, the module's own v4 check and the pins apply unchanged; the RPC rate floor (13, 34 with v4) is unchanged.
- A node without the block ("header not found", "block not found", Monad's "Block requested not found", a null result, an HTTP 400 "block is out of range", "missing trie node", an HTTP 403 for archive state) is retried as any unanswered call, each retry at the next endpoint, then refused as `stale_node` naming the block — nothing is read at "latest" instead.
- `UNISWAP_LATEST_ONLY_CHAINS` (`[999]`): HyperEVM's RPCs answer any block number from their head; there the request's `blockNumber` is not honoured and the quote names no block (Uniswap does not quote HyperEVM today). Every other chain takes a block number on its public and keyed RPCs; `verify:live` checks each endpoint (head − 2 answers its own number, head + 100,000 is refused) and quotes each corridor chain's first corridor at a block.
- `uniswapRemoteProvider({honorsBlockNumber: true})` declares the flag once the backend runs this release.
- Without `blockNumber` every request is 0.5.0's, byte for byte (`fixtures/unpinned-0.5.0.json`: v3 ungated and gated, v4 "best" and "both", ungated and gated, a routeId pick, the token input with a sender).
