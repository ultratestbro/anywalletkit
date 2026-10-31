---
"@anywalletkit/protocol-staking-tonstakers-ton": patch
---

A TON node's answer is now capped at 1 MiB before `@ton/ton` validates it. `@ton/ton` checks answers with zod 3, which can spend memory in proportion to an oversized payload, and there is no fixed zod 3 release. A `{ url, secretKey }` endpoint is now read through `fetch` with a byte cap (counted while it streams, or on the text where React Native's fetch has no stream), and a wallet-ton `TonRpc` result over the cap is refused before it reaches `@ton/ton`. The pool and balance reads this module makes are a few KiB, so honest nodes are unaffected; an oversized answer fails that client and the next configured one is tried. A `TonClient` instance you pass in yourself keeps its own transport.
