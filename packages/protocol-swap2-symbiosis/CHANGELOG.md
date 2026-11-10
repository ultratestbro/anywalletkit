# @anywalletkit/protocol-swap2-symbiosis

## 0.1.0

### Minor Changes

- ddab8aa: New swap2 provider: Symbiosis. Cross-chain swaps between Ethereum, BNB Chain, Avalanche, Polygon, Arbitrum, Optimism, Base, Tron and TON through Symbiosis' public REST API, with TON jettons and (opt-in, `tronSource`) Tron TRC-20 as sources. The source transaction is decoded on the device at every level — the MetaRouterGateway call, the bridge request, the host-chain pool swaps and the destination call — and bound to the request against pinned contracts, pools and synthetic tokens before a quote is shown and again before signing; legs on venues the module cannot read are asked for again without them or refused. Every reported fee is on the quote, the API's limits are enforced locally, and the status mapping reports a refund only with the revert transaction. Bitcoin sources (API-assigned deposit address) are opt-in behind `btcSource` and `depositAddressRoutes`.

### Patch Changes

- Updated dependencies [6d6e801]
- Updated dependencies [ff6582a]
  - @anywalletkit/swap2-assets@0.3.0
  - @anywalletkit/protocol-swap2-core@0.10.3
