---
"@anywalletkit/wallet-ton": minor
---

A gateway error on `sendBoc` is "maybe sent", not a refusal (re-audit 2026-10-30, #2). Any JSON error from an endpoint used to count as the node's refusal, so a JSON 502 / 504 / 408 or an empty `{}` after the node had taken the message surfaced as a plain `NetworkError`, and a retry could pay twice. Only toncenter's refusal envelope (`{ok: false, error}` outside 408/502/503/504, not a timeout — e.g. `INVALID_BAG_OF_CELLS`, `cannot apply external message`, a rate limit) stays a refusal; everything else throws `BroadcastUnknownError` with the body hash. Apps that already handle `BroadcastUnknownError` / `maybeSent` need nothing new.
