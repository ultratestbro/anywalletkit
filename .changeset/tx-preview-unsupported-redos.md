---
"@anywalletkit/tx-preview-evm": patch
---

"eth_simulateV1 is unsupported" (→ the `eth_call` fallback) is decided from the structured error first — JSON-RPC code -32601 / -32004 or viem's `MethodNotFoundRpcError` / `MethodNotSupportedRpcError` anywhere on the cause chain, then a -32601/-32004 code in an HTTP error's JSON body — and only then by a bounded, linear text match on the first 300 characters of `details` / `shortMessage` / `message` (Monad's -32000 "`validation: false` is not supported yet" still falls back). The old `method.*not` regex ran over the whole node-supplied message and backtracked quadratically on a crafted megabyte (scan F23). New export `simulateUnsupported`.
