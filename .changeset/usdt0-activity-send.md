---
"@forgewallet/protocol-swap2-usdt0": patch
---

Activity: an OFT `send` folds the LayerZero messaging fee (the native value) into `fee` instead of listing it as an asset the owner swapped away, and names both ends when the calldata carries the destination ("Bridged USDT → USDT0", subtitle "USDT0 · Ethereum → HyperEVM").
