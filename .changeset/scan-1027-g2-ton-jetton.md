---
"@anywalletkit/wallet-ton": minor
---

Jetton `transfer()` refuses a `responseDestination` other than the wallet itself (`UnsafeTransactionError` code `foreign-response-destination`) unless the new option `allowForeignResponseDestination` is set, and refuses attaching more than `maxJettonAttachedValue` nanotons (new config, default 1 TON, `forwardTonAmount` included; code `attached-value`). Both received TON that the caller's recipient check never saw.
