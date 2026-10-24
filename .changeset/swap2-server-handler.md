---
"@anywalletkit/protocol-swap2-core": minor
---

New `@anywalletkit/protocol-swap2-core/server`: `createSwap2Handler({ providers, sealSecret, guard })`, the server side of `remoteProvider`. Framework-free (`handle(action, body, context)` → `{status, body}`), it validates every field, seals quotes with HMAC-SHA256 and refuses `build` / `preflight` on an unsealed, altered or expired quote, passes a provider's named refusal through with URLs redacted, and requires a `guard` for authentication and rate limiting. WebCrypto, server-only (Node ≥ 20, edge runtimes); not part of the main entry, so apps never bundle it.
