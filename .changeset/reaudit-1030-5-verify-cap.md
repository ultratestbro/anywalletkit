---
"@anywalletkit/networks": patch
---

`verifyNetwork` caps an endpoint's answer at 1 MiB (`MAX_RESPONSE_BYTES`, re-audit 2026-10-30, #5). The answer was read whole with `res.text()` before any check, so a hostile RPC could make the verifier buffer whatever it sent within the deadline. A declared `content-length` over the cap is not read, a stream is cancelled once it passes it, and the result is `too-large: …`. A transport without a stream (React Native's fetch) is still bounded by the deadline and checked on the text.
