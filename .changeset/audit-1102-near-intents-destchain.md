---
"@anywalletkit/protocol-swap2-near-intents": patch
---

With `recipientType: "INTENTS"` or `"CONFIDENTIAL_INTENTS"`, the provider now claims and quotes only a NEAR `destChain` (`near:mainnet`). The output of such a swap is credited inside intents.near and never reaches another chain, so a route like "USDC on Base to 0x…" in these modes made the swap review name Base while the funds stayed in NEAR Intents; it is now refused by name. Every intents token is still reachable: pass `destChain: "near:mainnet"` with the catalog's NEAR token or the intents token id itself (for example `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` for Base USDC held in intents). `DESTINATION_CHAIN` (the default) is unchanged.
