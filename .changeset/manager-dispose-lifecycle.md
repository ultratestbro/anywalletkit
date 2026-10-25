---
"@anywalletkit/core": minor
"@anywalletkit/conformance": minor
"@anywalletkit/wallet-evm": patch
"@anywalletkit/wallet-btc": patch
"@anywalletkit/wallet-near": patch
"@anywalletkit/wallet-solana": patch
"@anywalletkit/wallet-ton": patch
"@anywalletkit/wallet-tron": patch
"@anywalletkit/wallet-zcash": patch
---

No signing account outlives `WalletManager.dispose()`. Every chain manager awaited between its cache check and storing the account, so: an account whose build was in flight during `dispose()` was created afterwards with a live key (a child derived from an injected seed signer kept signing); concurrent `getAccount` calls for one path built two accounts and leaked the first; a signer-built manager handed out new accounts after `dispose()`. New protected `cachedAccount()` / `signerAccount()` in core build each account once, refuse after dispose, dispose an account finished late and a derived child that never became an account. All seven chain managers use them. `describeChainModule` checks the contract (one account under concurrent calls, none after dispose). Audit 2026-10-25, #3.
