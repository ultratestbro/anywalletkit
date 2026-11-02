---
"@anywalletkit/wallet-near": patch
---

A `send_tx` error is now a plain `NearRpcError` only when the node clearly refused the transaction (`INVALID_TRANSACTION`, or `REQUEST_VALIDATION_ERROR` / `PARSE_ERROR`). Any other JSON-RPC error — including gateway errors that carry no NEAR error name, such as `-32000 upstream request timeout` or `-32603 Internal error` — now throws `BroadcastUnknownError` (`maybeSent: true`, with the locally computed `hash`), because the transaction may still land. Treat it like a timeout: watch the hash, do not sign again. Reads are unchanged.
