---
"@anywalletkit/wallet-btc": patch
"@anywalletkit/wallet-zcash": patch
"@anywalletkit/wallet-evm": patch
"@anywalletkit/wallet-near": patch
"@anywalletkit/wallet-solana": patch
"@anywalletkit/wallet-ton": patch
"@anywalletkit/wallet-tron": patch
---

The internal signing helpers (BTC `signPlan` / `signInputs` / `signSpend`, Zcash `signInputs` / `signSpend`, EVM `signHash` / `signPrepared` / `signAndBroadcast`, NEAR `signBytes`, Solana `signChecked` / `signPlan`, TON `signMessages`, Tron `signDigest`) are `#private` methods. They were private only in TypeScript, so code holding an account could call them at runtime and skip the checks the public methods run on what they sign.
