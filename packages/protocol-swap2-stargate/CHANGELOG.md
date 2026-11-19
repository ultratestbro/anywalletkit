# @anywalletkit/protocol-swap2-stargate

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
