---
"@forgewallet/protocol-swap2-omniston": minor
---

EVM → TON orders (gasless 1inch-LOP-fork typed orders) are implemented end to end: `trustedEvmOrderProtocols` (per-chain allowlist of the order protocol the wallet approves and signs against, separate from the escrow-factory table), `buildDeposit` returns a typed-order `UnsignedTx` after verifying the EIP-712 order, the pinned v1beta8 extension (with the live `allowedTime`/auction-start windows) and the serialized order details, `registerSignedOrder` hands the signature to Omniston, and `trackIntent` discloses the secret only after the `validateEvmInputPosition` (finalized `SrcEscrowCreated` + escrow state) AND `validateTonOutputPosition` (factory-deployed TON position with bound state) hooks both prove the positions. The hooks' inputs changed from the reserved shapes.
