---
"@anywalletkit/protocol-swap2-core": patch
---

A deposit whose broadcast answer was lost is reported as `Swap2MaybeSentError` (no approval revoke, no retry) in more shapes: every chain package's `BroadcastUnknownError` anywhere in the cause chain, undici's `fetch failed` with an `UND_ERR_*` cause, React Native's `Network request failed`, an error code only on the cause (`ECONNRESET`…), a `TimeoutError`. A node's explicit refusal (`answered: true`) stays a clean failure even when its message mentions a timeout.
