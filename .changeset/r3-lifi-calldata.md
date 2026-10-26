---
"@anywalletkit/protocol-swap2-lifi": patch
---

LI.FI quotes are checked against their Diamond calldata, not only the `action` / `estimate` beside it: a same-chain swap must pay the reviewed recipient at least the reviewed minimum in the requested tokens, a bridge's `BridgeData` must pay the reviewed recipient on the requested chain, bridging the input token. Routes with a destination call, EVM-source routes to a non-EVM chain (their receiver cannot be read here) and calldata that decodes as nothing known are refused.
