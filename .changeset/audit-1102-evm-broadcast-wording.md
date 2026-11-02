---
"@anywalletkit/wallet-evm": patch
---

When `eth_sendRawTransaction` fails at the HTTP level (a gateway 5xx page, a timeout), the error is now always `BroadcastUnknownError` (`maybeSent: true`, with the signed `hash`), even when the gateway's page or the RPC URL happens to contain words like "nonce", "tip" or "insufficient funds". Before, such words could make the failure look like a clean node refusal. Node refusals are still read from the JSON-RPC error itself and stay plain errors. Nothing to change in apps.
