---
"@anywalletkit/wallet-btc": patch
"@anywalletkit/wallet-zcash": patch
---

Outputs are matched to the recipient and to the change by script, recipient first. A transfer to oneself and (BTC) a recipient written in uppercase bech32 are no longer refused at signing.
