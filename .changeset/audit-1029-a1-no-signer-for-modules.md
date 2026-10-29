---
"@anywalletkit/kit": minor
"@anywalletkit/core": minor
"@anywalletkit/wallet-evm": minor
"@anywalletkit/wallet-solana": minor
"@anywalletkit/wallet-ton": minor
"@anywalletkit/wallet-tron": minor
"@anywalletkit/wallet-btc": minor
"@anywalletkit/wallet-near": minor
"@anywalletkit/wallet-zcash": minor
---

A protocol module can no longer reach the private key. On a `Wallet` without `policies`, `getProtocol` handed the module the raw account, and `account.signer.key()` — private in TypeScript only — returned the 32-byte key, a copy of which outlived `dispose()`. Three layers now close it:

- `kit`: a module always gets the restricted account. Without policies it is a wrapper with no rules: no limits, but the signer, internal helpers and the account's settings stay out of reach, as they did with `policies: {}`.
- `core`: `LocalSigner` reads its key through a function of the module, not a method: nothing outside `@anywalletkit/core` can call it.
- every chain account keeps its signer in a private field (`#signer`). The new `signerKind` field (`'seed' | 'key' | 'external'`) says what holds the key.

**Breaking:** chain accounts (`WalletAccountEvm`, `WalletAccountSolana`, `WalletAccountTon`, `WalletAccountTron`, `WalletAccountBtc`, `WalletAccountNear`, `WalletAccountZcash`) no longer have a `signer` property, the app's own accounts included. Read `account.signerKind` instead of `account.signer.kind`; keep a reference to the `Signer` you injected if you need it.

**Breaking:** a protocol module registered on a wallet without policies gets the policy wrapper instead of the raw account: it is a different object from `wallet.getAccount(chain)`, and writes through it are refused when they sign on another network than the module's chain.

**Breaking:** `LocalSigner` has no `key()` method at runtime any more (it was private in TypeScript).
