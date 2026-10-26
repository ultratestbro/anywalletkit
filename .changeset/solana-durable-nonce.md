---
"@anywalletkit/wallet-solana": minor
---

Durable-nonce transactions (first instruction `AdvanceNonceAccount`) never expire, so whoever holds the signature can broadcast it months later. They are now refused by default on every signing path (`sendTransaction`, `signTransaction`, `quoteSendTransaction`, `sendSerialized`, message, compiled or wire form) unless `allowDurableNonce: true` is set in the config or in the call's options (new `SolanaWriteOptions`). `describeTransaction` reports `lifetime: 'blockhash' | 'durable-nonce'` and a `durable-nonce` warning.
