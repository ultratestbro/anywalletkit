---
"@anywalletkit/wallet-solana": minor
"@anywalletkit/protocol-swap2-core": minor
"@anywalletkit/protocol-swap2-lifi": minor
---

Bridges out of Solana are now bound to the recipient you reviewed, not only to a SOL-out ceiling.

- `protocol-swap2-core`: for a cross-chain serialized leg the engine adds `bridgeOut: {destChain, recipient}` to the expectation it hands `account.sendSerializedTransaction`.
- `wallet-solana`: `sendSerialized` / `checkSerialized` accept `expect.bridgeOut` (`BridgeOutExpectation`). With it, every top-level instruction must be one the guard can follow — transfers to this wallet's own accounts or to a fee wallet (LI.FI's `LIFI_FEE_WALLET_ADDRESS` by default, at most 3 % of what may leave), a Jupiter swap into the wallet or the bridge, Mayan's Swift / MCTP / Fast MCTP orders — and every Mayan order must pay `recipient` on `destChain`; otherwise the wire is refused with `bridge-recipient`, `bridge-payee`, `bridge-instruction`, `bridge-missing` or `bridge-fee`. Instructions sent through Mayan's CPI proxy (`MAYAN_CPI_PROXY_PROGRAM_ADDRESS`) are now described and guarded as the instruction they run, so a program allowlist and the core-instruction checks see through it; the legacy empty-data ATA Create is described as an ATA creation.
- `protocol-swap2-lifi`: a Solana source is quoted through Mayan only (`allowBridges` mayan / mayanMCTP / mayanFastMCTP; NEAR Intents, LayerSwap and Relay deposit to an off-chain order the transaction does not bind — the direct NEAR Intents provider still serves those pairs), and the provider and `lifiVerifyQuote` refuse a Solana bridge transaction that calls no Mayan program or transfers SOL to a wallet other than the sender or LI.FI's fee wallet. Solana → HyperEVM, which LI.FI served only through Relay, now gets no LI.FI quote.

What to do: if your app maps the swap2 expectation onto `account.sendSerialized` itself, forward the new field — `...(expect.bridgeOut ? {bridgeOut: expect.bridgeOut} : {})` next to `maxLamportsOut` / `tokenIn` / `maxTokenOut`. Without it the account cannot prove where a bridge pays.
