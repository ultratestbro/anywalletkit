---
"@anywalletkit/protocol-swap2-core": minor
---

`claimSwap2` now returns a status id that carries the claim transaction's hash (`awk1.<provider>.<intent>.<sourceHash>.<claimHash>`), and `getSwap2Status` passes it to the provider as `destTxHash`. A two-phase route (CCTP) whose provider has no destination RPC used to stay "action-required" after the claim; it now completes. Older ids keep working.
