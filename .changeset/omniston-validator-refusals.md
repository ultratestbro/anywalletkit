---
"@anywalletkit/protocol-swap2-omniston": patch
---

Validators report why they refuse: `createOmnistonEvmInputValidator({onRefusal})` and `createOmnistonTonValidators({onRefusal})` call the hook with a reason (`no-fill-event`, `immutables-mismatch`, `receipt-or-confirmations`, `past-disclosure-margin`, `escrow-state`, `account-fetch`, `position-code-hash`, `state`, `deploy-transaction`, `error`, …) and the numbers compared — never a secret. A refusal was a silent `false` before, which cost four live orders their disclosure window on 2026-10-20 before the cause could be read.
