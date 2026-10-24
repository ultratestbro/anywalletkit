# @anywalletkit/protocol-swap2-fynd

## 0.1.1

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [6b164bd]
- Updated dependencies [65c3bca]
  - @anywalletkit/protocol-swap2-core@0.3.1
  - @anywalletkit/core@0.3.1
  - @anywalletkit/swap2-assets@0.1.3

## 0.1.0

### Minor Changes

- a8f1e72: New package: Fynd (Propeller Heads) as a same-chain swap2 provider on Ethereum, Base, Arbitrum, BNB Chain, Polygon, Unichain and Robinhood Chain — the hosted API (key kept server-side) or self-hosted `fynd serve` per chain. Every encoded transaction is decoded and checked before approval or signing: pinned TychoRouterV3, a plain singleSwap / sequentialSwap / splitSwap, the exact input and tokens, the user as receiver, the quoted output and minimum, Fynd's fee breakdown adding up, no client fee. Optional pre-broadcast simulation and receipts over `rpcUrls`. Fynd outputs are licensed under the Fynd License (settlement through the Tycho router, platform fee and positive-slippage capture, revenue share on revenue earned from such swaps) — see the package README.

### Patch Changes

- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
- Updated dependencies [0d68fda]
- Updated dependencies [6568e08]
- Updated dependencies [06cecff]
- Updated dependencies [24b888a]
- Updated dependencies [bdc77c2]
- Updated dependencies [4fcb9b6]
- Updated dependencies [d08e37e]
  - @anywalletkit/core@0.3.0
  - @anywalletkit/protocol-swap2-core@0.3.0
  - @anywalletkit/swap2-assets@0.1.2
