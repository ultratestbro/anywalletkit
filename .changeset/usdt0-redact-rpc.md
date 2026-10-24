---
"@forgewallet/protocol-swap2-usdt0": patch
"@forgewallet/protocol-swap2-core": minor
---

USDT0 no longer puts raw viem transport errors into refusal reasons or preflight errors. Those errors carry `URL: …`, which includes the key of a keyed RPC.

- **USDT0:** an RPC failure becomes `usdt0: RPC for <chain> unavailable — try again`, and any other text loses its URLs.
- **swap2-core:** new `redactUrls()`. Servers that forward refusal text to clients should pass it through this.
