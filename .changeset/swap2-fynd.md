---
"@anywalletkit/protocol-swap2-fynd": minor
---

New package: Fynd (Propeller Heads) as a same-chain swap2 provider on Ethereum, Base, Arbitrum, BNB Chain, Polygon, Unichain and Robinhood Chain — the hosted API (key kept server-side) or self-hosted `fynd serve` per chain. Every encoded transaction is decoded and checked before approval or signing: pinned TychoRouterV3, a plain singleSwap / sequentialSwap / splitSwap, the exact input and tokens, the user as receiver, the quoted output and minimum, Fynd's fee breakdown adding up, no client fee. Optional pre-broadcast simulation and receipts over `rpcUrls`. Fynd outputs are licensed under the Fynd License (settlement through the Tycho router, platform fee and positive-slippage capture, revenue share on revenue earned from such swaps) — see the package README.
