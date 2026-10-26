---
"@anywalletkit/kit": minor
---

`transfer` intents now name `recipient`, the only field every chain package pays, instead of `to ?? recipient`. A call that also passes a different `to` is reported with `destinationUnknown: true`, so an allowlist refuses it and a blocklist without a `confirm` hook refuses it.
