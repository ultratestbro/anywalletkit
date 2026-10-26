---
"@anywalletkit/protocol-swap2-lifi": patch
---

Bridge calldata must use one of LI.FI's ABI-encoded bridge entry points (`startBridgeTokensVia*` / `swapAndStartBridgeTokensVia*`, computed from the facet sources): a packed call whose bytes merely look like a `BridgeData` is refused. Routes with source swaps are no longer refused for comparing the bridged amount (the swapped token) with the input. The README states what is not checked: a bridge's output minimum lives in bridge-specific data.
