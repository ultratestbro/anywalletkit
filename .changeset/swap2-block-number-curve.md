---
"@anywalletkit/protocol-swap2-curve": minor
---

`QuoteParams.blockNumber`: every `get_dy` of a quote (the candidate routes and the impact probe) goes to that block and the quote names it (`Quote.blockNumber`; `honorsBlockNumber: true`). The router's code and version check, `preflightDeposit` and `curveRemotePins`' `verifyBuild` stay at "latest". A node without the block fails its endpoint: the next is asked, every endpoint once more after a second, then the quote is refused as `stale_node` naming the block, never priced at "latest". `CURVE_LATEST_ONLY_CHAINS` (`[999]`): HyperEVM's RPCs answer any block number from their head; there the quote is read at "latest" and names no block. `verify:live` checks every chain takes a block number and quotes one route at a block. Without `blockNumber` every request is 0.1.10's, byte for byte.
