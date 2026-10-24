---
title: Anatomy of a wallet
description: What a crypto wallet is made of, which Any Wallet Kit package covers each part, and what you bring yourself.
sidebar:
  order: 1
---

A crypto wallet looks like one app, but it is about eighteen parts. Some are cryptography,
some are network data, some are product decisions. This section goes through them in the
order you'll need them. For each part it says what the job is, which package does it, and
what you have to bring yourself: an RPC, an API key, a storage layer.

| # | Part | What the user sees | Any Wallet Kit | You bring |
|---|---|---|---|---|
| 1 | [Keys](/build-a-wallet/keys-and-storage/) | "Create wallet", "Import seed phrase" | `core` | Nothing |
| 2 | [Key storage](/build-a-wallet/keys-and-storage/#key-storage) | Face ID unlock, "Back up your phrase" | `secure-storage-react-native` (iOS Keychain, Android Keystore), `seed-vault` (encrypted backup file), `backup-cloud` (iCloud), `extension-kit` (browser) | Nothing on iOS; an Android cloud backup is planned |
| 3 | [Accounts](/build-a-wallet/accounts/) | One address per chain, several accounts | `kit`, `keyring`, `wallet-*` | Nothing |
| 4 | [Networks and RPC](/build-a-wallet/networks-and-rpc/) | Nothing, until it breaks | `networks` | RPC endpoints |
| 5 | [Balances](/build-a-wallet/balances-and-prices/) | Total, list of assets | `wallet-*`, `swap2-assets` | RPC; an indexer to find tokens |
| 6 | [Prices](/build-a-wallet/balances-and-prices/#prices) | $ next to every amount | Not in the SDK yet | A price API |
| 7 | [Send](/build-a-wallet/send-and-receive/) | Recipient, amount, fee, confirm | `wallet-*` | RPC |
| 8 | [Receive](/build-a-wallet/send-and-receive/#receive) | Address and QR code | `wallet-*` | A QR library |
| 9 | [Names](/build-a-wallet/send-and-receive/#names) | `name.eth` in the recipient field | `names-ens` | An Ethereum RPC |
| 10 | [History](/build-a-wallet/history/) | Activity list with readable titles | `history-evm`, `wallet-*`, `kit` | Explorer / indexer keys |
| 11 | [Review before signing](/build-a-wallet/review-and-safety/) | "You send 100 USDC, you get 0.03 ETH" | `tx-preview-evm`, `kit` | An RPC with `eth_simulateV1` |
| 12 | [Safety](/build-a-wallet/review-and-safety/#safety) | Approvals list, warnings | `protocol-approvals-evm`, `kit` | Blocklist sources |
| 13 | [Swaps and bridges](/build-a-wallet/swaps-and-earn/) | Swap screen, route picker | `protocol-swap2-*` | Provider keys (some) |
| 14 | [Earn](/build-a-wallet/swaps-and-earn/#earn) | Stake, lend, APY | `protocol-staking-*`, `protocol-lending-*` | RPC |
| 15 | [dApp connection](/build-a-wallet/dapp-connection/) | "Connect wallet" on websites | `extension-kit` | WalletConnect on mobile |
| 16 | [Buy and sell](/build-a-wallet/fiat-and-notifications/) | "Buy crypto" button | `FiatProtocol` interface only | An on-ramp provider |
| 17 | [Notifications](/build-a-wallet/fiat-and-notifications/#notifications) | "You received 50 USDT" | Not in the SDK yet | A webhook service and push |
| 18 | [Your server](/build-a-wallet/your-server/) | Nothing | `protocol-swap2-core/server` (swap backend), [`examples/server`](https://github.com/ultratestbro/anywalletkit/tree/main/examples/server) (RPC proxy + swaps) | Hosting, user auth, rate limits |

[Ship a wallet](/build-a-wallet/ship-a-wallet/) puts the parts together end to end, with the server.
A minimal wallet is parts 1–8. A wallet people keep using adds 10, 11 and 13. Everything
else is what sets one wallet apart from another.

## Build order

1. **Keys, storage, accounts.** The wallet can be created and restored.
2. **Networks, balances, prices, send, receive.** A usable wallet.
3. **History, review before signing.** A wallet people trust.
4. **Swaps, Earn, approvals.** A wallet people come back to.
5. **dApp connection, fiat, notifications, names.** A complete product.

## About the providers on these pages

These pages name third-party services (RPC nodes, indexers, price APIs, on-ramps) as
examples of what fits each part.

:::caution[Always check the provider yourself]
- **Links, plans, limits and prices change.** We checked the links on 2026-10-23. Before
  you rely on a provider, open its current documentation and pricing page.
- **Test with your real traffic.** Free tiers and "unlimited" plans have limits that show up
  only under load: rate limits, block-range caps, missing methods.
- **A listing is not an endorsement.** We have no partnership with any provider named here.
- **Keep two providers for anything critical**, so one outage does not take your wallet
  down.
:::
