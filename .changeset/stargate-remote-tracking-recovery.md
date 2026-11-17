---
"@anywalletkit/protocol-swap2-core": minor
---

Allow provider pins to supply independent client tracking and paid-recovery validation.
When a remote provider receives a local tracker, it uses that tracker without falling
back to backend status. Existing providers retain their current tracking behavior.

Stargate's private integration now supplies these hooks together with its source-call
pins, so server/mobile clients can verify payouts and recover pending transfers using
their own RPC evidence.
