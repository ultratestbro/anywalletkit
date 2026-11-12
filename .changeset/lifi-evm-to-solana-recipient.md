---
"@anywalletkit/protocol-swap2-lifi": patch
---

LI.FI routes from an EVM chain to Solana work. Up to 0.7.0 every such quote was refused ("the recipient on a non-EVM destination sits in bridge-specific data and cannot be checked here"), because `BridgeData.receiver` is only LI.FI's non-EVM placeholder and the Solana recipient sits in the bridge's own data. The module now reads it there, on the device, for the bridges whose delivery the transaction binds, and holds it to the requested recipient and token:

- Mayan (`mayan`, `mayanMCTP`, `mayanFastMCTP`): the facet's `nonEVMReceiver` and the destination address inside the Mayan order or transfer (Swift v2, MCTP `createOrder` / `bridgeWithFee`, Fast MCTP `createOrder` / `bridge`) must both be the recipient; the order must go to Solana, carry no custom payload and name the requested mint. Other Mayan entry points are refused.
- Polymer CCTP (`polymer`, `polymerStandard`): CCTP mints to a token account the facet cannot check; it must be the recipient's USDC associated token account, derived on the device.
- Chainflip: the 32-byte destination address and the Solana asset (SOL, USDC, USDT).
- LI.FI Intents: the escrowed order's recipient and output token.

`BridgeData` must name LI.FI's Solana chain id and exactly the non-EVM placeholder. EVM → Solana requests ask LI.FI for those bridges only (`allowBridges`; a `chooseRoute` pick is kept among them), so pairs are not lost to a bridge whose recipient cannot be read. NEAR Intents and LayerSwap pay a deposit address whose off-chain order names the recipient, and Smart Deposits a deposit address outright: refused for this direction with a named reason. Other bridges to Solana keep the existing refusal text. `lifiVerifyQuote` / `lifiPins` run the same check on a remote quote. A dry EVM → Solana quote with no recipient now prices a Solana placeholder recipient instead of the EVM sender.

EVM → EVM and Solana-source requests are unchanged. New dependencies: `@noble/curves` and `@noble/hashes` (the associated-token-account derivation). Apps that kept LI.FI away from EVM → Solana pairs can stop doing so.
