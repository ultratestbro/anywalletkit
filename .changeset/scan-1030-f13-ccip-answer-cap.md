---
"@anywalletkit/names-ens": minor
---

A CCIP-Read gateway's answer is capped and timed on the device too (scan 2026-10-30, F13). `ensCcipRequest` (the default for `ensResolver({ rpcUrl })`) buffered the whole answer a name's gateway sent — any size, never ending, error statuses included.

- The status and the declared `content-length` are checked first: a non-2xx or oversized answer is not read, and its body is cancelled.
- The body is read to at most `EnsCcipOptions.maxResponseBytes` (default 1 MiB) — streamed where the runtime has a stream, `text()` otherwise (React Native) — then parsed.
- `EnsCcipOptions.timeoutMs` (default 10 s) covers one gateway's request and whole answer, next to the caller's signal (merged by hand; Hermes-safe).
- The reader is shared with `createEnsCcipHandler`, whose cap and deadline are unchanged.

Behaviour: a gateway answer above 1 MiB or slower than 10 s fails the lookup (`lookup-failed`) where it used to be waited for; real gateway answers are a few KB.
