---
"@anywalletkit/wallet-evm": patch
---

A broadcast error with JSON-RPC code `-32002` (resource unavailable), which gateways give when their upstream node cannot be reached, is now treated like `-32603` and `-32005`: it ends as `BroadcastUnknownError` (`maybeSent: true`) unless its message carries a node's exact refusal words ("nonce too low", "insufficient funds for gas", "transaction underpriced", …). Before, a loose word such as "nonce", "tip" or "fee cap" in such a message read as a definite refusal. Ordinary `-32000` node refusals are unchanged.
