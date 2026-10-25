---
"@anywalletkit/backup-cloud": patch
"@anywalletkit/conformance": patch
"@anywalletkit/core": patch
"@anywalletkit/extension-kit": patch
"@anywalletkit/history-evm": patch
"@anywalletkit/keyring": patch
"@anywalletkit/kit": patch
"@anywalletkit/names-ens": patch
"@anywalletkit/networks": patch
"@anywalletkit/protocol-approvals-evm": patch
"@anywalletkit/protocol-lending-aave-evm": patch
"@anywalletkit/protocol-lending-kamino-solana": patch
"@anywalletkit/protocol-lending-mellow-evm": patch
"@anywalletkit/protocol-lending-morpho-evm": patch
"@anywalletkit/protocol-staking-lido-evm": patch
"@anywalletkit/protocol-staking-spl-stake-pool-solana": patch
"@anywalletkit/protocol-staking-ssv-evm": patch
"@anywalletkit/protocol-staking-tonstakers-ton": patch
"@anywalletkit/protocol-swap2-balancer": patch
"@anywalletkit/protocol-swap2-cctp": patch
"@anywalletkit/protocol-swap2-chainflip": patch
"@anywalletkit/protocol-swap2-core": patch
"@anywalletkit/protocol-swap2-fynd": patch
"@anywalletkit/protocol-swap2-jupiter": patch
"@anywalletkit/protocol-swap2-lifi": patch
"@anywalletkit/protocol-swap2-near-intents": patch
"@anywalletkit/protocol-swap2-omniston": patch
"@anywalletkit/protocol-swap2-router": patch
"@anywalletkit/protocol-swap2-thorchain": patch
"@anywalletkit/protocol-swap2-uniswap": patch
"@anywalletkit/protocol-swap2-usdt0": patch
"@anywalletkit/protocol-swap2-wrap": patch
"@anywalletkit/runtime-hermes": patch
"@anywalletkit/secure-storage-react-native": patch
"@anywalletkit/seed-vault": patch
"@anywalletkit/swap2-assets": patch
"@anywalletkit/tx-preview-evm": patch
"@anywalletkit/wallet-btc": patch
"@anywalletkit/wallet-evm": patch
"@anywalletkit/wallet-near": patch
"@anywalletkit/wallet-solana": patch
"@anywalletkit/wallet-ton": patch
"@anywalletkit/wallet-tron": patch
"@anywalletkit/wallet-zcash": patch
---

Audit 2026-10-25, findings 16 and 17.

- **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
- **engines.** Every package declares `"engines": { "node": ">=20" }`.
- **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
