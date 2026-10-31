---
"@anywalletkit/wallet-evm": patch
---

An ambiguous JSON-RPC error from `eth_sendRawTransaction` is now "maybe sent". Before, any numeric error code (for example `-32603` internal error, `-32005` limit exceeded, `-32000` "upstream request timeout" from a gateway) counted as the node's refusal, so the send threw a plain error without the hash even when the node had already taken the transaction, and a retry could pay twice. Now only a node's refusal wording (nonce, underpriced, insufficient funds, …) or a request-level code (`-32700`, `-32600`, `-32601`, `-32602`, `-32003`) is a plain error; anything else throws `BroadcastUnknownError` with the signed hash. Apps that already handle `BroadcastUnknownError` / `maybeSent` (check the hash before retrying) need nothing new.
