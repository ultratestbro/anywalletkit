---
"@anywalletkit/wallet-btc": patch
"@anywalletkit/wallet-zcash": patch
---

`signTransaction(rawHex)` runs the checks `sendTransaction(rawHex)` runs (prevouts through the client, then `assertSafe`: fee-rate / fee ceiling, change that is not ours, outputs above inputs; then `transactionMaxFee` and `WriteOptions.maxFee`) and returns the bytes unchanged, never re-signed. It returned any hex as-is, so an app that "signs" one hex and broadcasts it elsewhere, or treats `signTransaction` as validation, could release a transaction `sendTransaction` would refuse. It now needs a client, as `sendTransaction(rawHex)` does. Audit 2026-10-25 (post-release), M4.
