---
"@anywalletkit/kit": minor
---

TON jetton `transfer()` is judged on everything that receives TON, not only `recipient`: the jetton master (`token`, it names the contract that receives `attachedValue`) and a `responseDestination` other than the wallet itself are destinations, and a forward or custom payload cell makes the write `destinationUnknown`. Under a TON allowlist the jetton master must now be listed. `WriteIntent` gains `attachedValue` and `forwardTonAmount` for confirm screens.
