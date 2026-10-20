# @forgewallet/protocol-swap2-omniston

## 0.2.0

### Minor Changes

- 1fe0b26: EVM ↔ EVM orders and X Layer, HyperEVM and Plasma; the RPC/indexer validators and audited contract tables move into the package (`./validators`). The destination-escrow proof now requires the immutables to derive to the announced escrow through the trusted factory; one HTLC execution by default (matches the TON escrow validator).
- 384c562: EVM → TON orders (gasless 1inch-LOP-fork typed orders) are implemented end to end: `trustedEvmOrderProtocols` (per-chain allowlist of the order protocol the wallet approves and signs against, separate from the escrow-factory table), `buildDeposit` returns a typed-order `UnsignedTx` after verifying the EIP-712 order, the pinned v1beta8 extension (with the live `allowedTime`/auction-start windows) and the serialized order details, `registerSignedOrder` hands the signature to Omniston, and `trackIntent` discloses the secret only after the `validateEvmInputPosition` (finalized `SrcEscrowCreated` + escrow state) AND `validateTonOutputPosition` (factory-deployed TON position with bound state) hooks both prove the positions. The hooks' inputs changed from the reserved shapes.

### Patch Changes

- 29af9d6: EIP-712 domain `chainId` sent as a string (hex "0x89" or decimal) is now hashed as a NUMBER. viem includes `chainId` in the EIP712Domain type only for numeric values, so such typed data was signed over a domain without chainId and the verifying contract rejected the signature (Omniston EVM→TON order on Polygon, 2026-10-16: registered, never filled). `WalletAccountEvm.signTypedData` normalizes (and the cross-chain guard now recognizes hex strings), the swap2 engine normalizes before handing typed orders to any signer, and the Omniston provider returns typed data with a numeric chainId.
- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
- Updated dependencies [412164a]
- Updated dependencies [f427dec]
- Updated dependencies [7004ecf]
- Updated dependencies [e0edbf6]
- Updated dependencies [29af9d6]
  - @forgewallet/core@0.2.0
  - @forgewallet/protocol-swap2-core@0.2.0
  - @forgewallet/swap2-assets@0.1.1

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`forgewallet` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @forgewallet/core@0.1.0
  - @forgewallet/protocol-swap2-core@0.1.0
  - @forgewallet/swap2-assets@0.1.0
