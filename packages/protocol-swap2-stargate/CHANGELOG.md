# @anywalletkit/protocol-swap2-stargate

## 0.1.4

### Patch Changes

- 96e754d: README: `QuoteParams.blockNumber` is not supported by this provider (its price comes from an API, or is not a pool price compared across venues at one block); its quotes name no block. No code change.
- dce6a13: README: a "Gas estimate" section saying why these quotes carry no `Quote.gasEstimate` (protocol-swap2-core): no API or contract answer states the gas the source transaction uses, and none is guessed. Relay's deposit-step `gas` is `eth_estimateGas` × 1.3, a limit with a margin (measured on ten live quotes, 2026-11-28); Across, Stargate, USDT0, CCTP and Symbiosis read no gas figure at all. No code change.
- Updated dependencies [94fdfb0]
- Updated dependencies [dce6a13]
  - @anywalletkit/protocol-swap2-core@0.18.0

## 0.1.3

### Patch Changes

- Updated dependencies [6020956]
- Updated dependencies [ffe1564]
  - @anywalletkit/protocol-swap2-core@0.17.0

## 0.1.2

### Patch Changes

- Updated dependencies [ef9b9d7]
  - @anywalletkit/protocol-swap2-core@0.16.0

## 0.1.1

### Patch Changes

- Updated dependencies [90eebd0]
  - @anywalletkit/protocol-swap2-core@0.15.1

## 0.1.0

### Minor Changes

- 6c0c3c2: New provider: direct Stargate V2 Taxi transfers between 15 EVM chains (USDC, USDT, ETH and
  the pinned OFT assets). Quotes read the pinned pools; the client rebuilds and checks the
  `sendToken` calldata, re-quotes after review and proves delivery from finalized destination
  receipts. Cached-token and LayerZero message recovery are separate reviewed, paid actions;
  historical Bus transfers stay trackable. Off until `enabled: true`.
  
  Opt-in `compose` route: Taxi into the pinned Ethereum LI.FI receiver plus one locally
  encoded 1inch `unoswap2` swap through two canonical Uniswap V3 pools, with client preflight,
  `completed` / `partial` tracking and a gas-bounded `lzCompose` retry.

### Patch Changes

- Updated dependencies [a096145]
- Updated dependencies [eba96eb]
- Updated dependencies [0d51c25]
- Updated dependencies [fb01615]
  - @anywalletkit/protocol-swap2-core@0.15.0
  - @anywalletkit/core@0.9.0
  - @anywalletkit/swap2-assets@0.3.0
