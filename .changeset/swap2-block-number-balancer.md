---
"@anywalletkit/protocol-swap2-balancer": minor
---

`QuoteParams.blockNumber`: the Vault's `queryBatchSwap`, the quote's price, runs at that block and the quote names it (`Quote.blockNumber`; `honorsBlockNumber: true`); the SOR's paths come from the API as before. The Vault's `WETH()` check and `preflightDeposit` stay at "latest". A node without the block fails its endpoint and the next one is asked; with none left the quote is refused as `stale_node` naming the block, never priced at "latest" (a revert is still the Vault's answer, `simulation_failed`). New `verify:live`: the Vault pin, a block number taken on every endpoint of every chain, a quote at a block naming it. Without `blockNumber` every request is 0.3.13's, byte for byte.
