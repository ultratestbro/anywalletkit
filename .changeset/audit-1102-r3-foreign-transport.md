---
"@anywalletkit/wallet-evm": patch
---

When `provider` is an EIP-1193 object backed by another copy of viem, an `HttpRequestError` or `TimeoutError` it throws from `eth_sendRawTransaction` now always ends as `BroadcastUnknownError` (`maybeSent: true`), even when the HTTP page it carries contains a node's exact words such as "insufficient funds for gas", "transaction underpriced" or "already known". Before, viem's `UnknownRpcError` wrapper repeated that page in its own text, so the page could be read as a definite refusal, or as a successful send for "already known". Such errors are also recognised by their fields (`url` with `status` / `headers`) when a bundler renamed the class. Errors with a JSON-RPC code and plain provider errors with a node's exact words are read as before. Treat `BroadcastUnknownError` like a timeout: watch the hash, do not sign again.
