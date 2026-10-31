---
"@anywalletkit/wallet-near": patch
---

Back-to-back NEAR sends no longer reuse a nonce. The nonce was read from the access key at `final`, which lags the block that holds the previous transaction, so a second `transfer()` / `sendTransaction()` right after the first signed the same nonce and was refused with `InvalidNonce`. The account now remembers the last nonce it broadcast (accepted or maybe sent, not after a definitive refusal) and signs at least that + 1, and it runs its sends one at a time. A nonce you set yourself, or an already-serialized transaction, is used as given. Nothing to change in apps.
