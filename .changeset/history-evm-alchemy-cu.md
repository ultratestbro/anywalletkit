---
"@forgewallet/history-evm": patch
---

Alchemy limiter counts compute units (batches charged the sum of their calls), 10-call batches, rate-limit answers retried up to 3× with backoff; `alchemyComputeUnitsPerSecond` replaces `alchemyRateLimit`.
