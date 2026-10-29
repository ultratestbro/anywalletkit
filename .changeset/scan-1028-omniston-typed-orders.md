---
"@anywalletkit/protocol-swap2-core": minor
"@anywalletkit/protocol-swap2-omniston": minor
---

A remote typed order is opened on the device before it is signed (scan 2026-10-28, F6). The engine bound only the domain, the maker and the input of a backend's EIP-712 order; `takingAmount`, the receiver, `makerTraits` and the extension were the backend's.

- **Engine:** a remote stub's typed order is signed only when the stub has the app's own `verifyBuild`, as for TON cell bodies. `UnsignedTx` gains `orderExtension` (0x-hex), the order extension the salt commits to; a build with it but without `typedData` is refused as ambiguous.
- **Omniston:** EVM-source builds carry `orderExtension`, and `omnistonVerifyBuild` now opens EVM typed orders (EVM → TON, EVM → EVM): the 1inch v4 domain on a trusted order protocol and the source chain, the exact Order schema, the trader as maker selling exactly the input, `takingAmount` at least the quote's minimum and the app's floor, a single-fill order with no allowed sender or series and an expiry minutes away, the salt committing the extension, and in the extension the pinned v1beta8 auction and fee terms, one trusted escrow factory as target, the whitelisted resolver as the order's receiver, the destination chain and token, the audited timelocks, the TON destination token and recipient, and the quote id. New options `trustedEvmOrderProtocols` / `trustedSettlementContracts` (default the audited tables). The HTLC hashlock is the server's, as is the secret.

**Breaking:** without `verifyBuild` a remote typed order is refused, and `omnistonVerifyBuild` refuses an EVM order without `orderExtension`: deploy the server on this release before the app, or remote EVM → TON and EVM → EVM orders are refused. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.
