# @anywalletkit/walletconnect-ton

## 0.1.1

### Patch Changes

- Updated dependencies [9677422]
- Updated dependencies [ca72d9b]
  - @anywalletkit/wallet-ton@0.8.1

## 0.1.0

### Minor Changes

- 023f997: New package `@anywalletkit/walletconnect-ton`: WalletConnect for TON, so TON dApps that offer WalletConnect (`@tonconnect/sdk` 3.4+ `initializeWalletConnect`, STON.fi among them) connect to a wallet that is not listed in the TON wallets registry. `tonSessionNamespace` (user-friendly CAIP-10 account), `tonSessionProperties` (`ton_getPublicKey`, `ton_getStateInit`), `tonProofAuthentication` (the proposal's CAIP-122 `ton_proof`), and `handleTonRequest` for `ton_sendMessage` / `ton_signData`: parsed and checked, shown to the app's review, then one signing call (`sendTransaction` under the account's policies, one signature, the broadcast bytes as the reply; `signTonConnectData` bound to the peer domain). No WalletConnect runtime dependency.
  
  `wallet-ton`: TON Connect request parsing now lives here, in one place for every transport — `parseConnectRequest`, `parseSendTransaction` (network / `from` / `valid_until` / message cap checks, structured items and extra currencies refused), `parseSignData` (`cell` refused), `TonConnectError` / `TONCONNECT_ERRORS`, address helpers (`tonConnectRawAddress`, `tonConnectFriendlyAddress`, `sameTonConnectAddress`) — from the main entry and the light subpath `@anywalletkit/wallet-ton/tonconnect` (no `@ton/core`). `sendTransaction` and `transfer` also return `boc`: the external message exactly as broadcast.
  
  `extension-kit`: its TON Connect parsing and digests are the shared ones from `wallet-ton/tonconnect` (same exports; `wallet-ton` is now a dependency). `parseSendTransaction` / `parseSignData` additionally check `from` against the wallet when given an `address`, and refuse structured items and extra currencies (400).

### Patch Changes

- Updated dependencies [993fb58]
- Updated dependencies [023f997]
  - @anywalletkit/wallet-ton@0.8.0
