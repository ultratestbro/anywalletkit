---
title: Packages
description: Every Any Wallet Kit package, grouped by layer.
sidebar:
  order: 4
---

Install only what your wallet uses. Every package is published under the `@anywalletkit/` scope.

:::note[Pre-1.0]
Every package is on npm under [`@anywalletkit`](https://www.npmjs.com/org/anywalletkit), published from CI with provenance. Versions are `0.x`: a minor release may still change the API.
:::

## Core

| Package | What it does |
|---|---|
| `@anywalletkit/core` | Signer and account interfaces, protocol base classes, errors, BIP-39 / BIP-32 / SLIP-10 helpers |
| `@anywalletkit/conformance` | Golden vectors and the test suites every chain and protocol module must pass |
| `@anywalletkit/kit` | Orchestrator: one seed or signer, registered chain wallets and protocol modules, accounts by CAIP-2 chain id, policies (fee cap, allow / block lists, confirmation) before every broadcast |
| `@anywalletkit/keyring` | Many accounts from one seed plus imported seeds and private keys, one account list across chains, per-execution accounts that dispose the key after use |
| `@anywalletkit/runtime-hermes` | One-call React Native / Hermes polyfills the SDK relies on |
| `@anywalletkit/secure-storage-react-native` | The keyring's secret storage on iOS / Android: Face ID, Touch ID or fingerprint with a passcode fallback on every read (Expo module) |
| `@anywalletkit/seed-vault` | Encrypted backup file for one seed or key, opened by a password (Argon2id) or a 32-byte key |
| `@anywalletkit/backup-cloud` | iCloud Drive backups of seed-vault files, with the key in iCloud Keychain or a password |

## Chains

| Package | Chains | Derivation |
|---|---|---|
| `@anywalletkit/wallet-evm` | Ethereum and 30+ EVM networks | `m/44'/60'/0'/0/i` |
| `@anywalletkit/wallet-btc` | Bitcoin (BIP-84 SegWit, BIP-86 Taproot) | `m/84'/0'/0'/0/i` (Taproot `m/86'/0'/0'/0/i`) |
| `@anywalletkit/wallet-solana` | Solana | `m/44'/501'/i'/0'` |
| `@anywalletkit/wallet-ton` | TON (WalletContractV5R1) | `m/44'/607'/i'` |
| `@anywalletkit/wallet-tron` | Tron | `m/44'/195'/0'/0/i` |
| `@anywalletkit/wallet-near` | NEAR (implicit and named accounts) | `m/44'/397'/i'` |
| `@anywalletkit/wallet-zcash` | Zcash (transparent addresses) | `m/44'/133'/0'/0/i` |

## Swaps and bridges

All swap modules implement one `Swap2Protocol` interface, so each works on its own or
inside the router.

| Package | What it does |
|---|---|
| `@anywalletkit/protocol-swap2-core` | Swap engine, cross-chain router base, quote and execution safety rails |
| `@anywalletkit/protocol-swap2-router` | Auctions every provider you install, tags the best and the fastest route, executes the winner, resumes status |
| `@anywalletkit/swap2-assets` | CAIP-19 asset registry shared by the swap packages |
| `@anywalletkit/protocol-swap2-near-intents` | NEAR Intents (1Click) — cross-chain |
| `@anywalletkit/protocol-swap2-lifi` | LI.FI — same-chain and cross-chain |
| `@anywalletkit/protocol-swap2-thorchain` | THORChain — native cross-chain swaps |
| `@anywalletkit/protocol-swap2-chainflip` | Chainflip — native BTC, ETH, SOL, TRX and stablecoins between Ethereum, Arbitrum, Solana, Tron and Bitcoin; no key, 0 bps |
| `@anywalletkit/protocol-swap2-omniston` | STON.fi Omniston — TON swaps, TON ↔ EVM and EVM ↔ EVM stablecoin orders |
| `@anywalletkit/protocol-swap2-cctp` | Circle CCTP V2 — native USDC between EVM chains |
| `@anywalletkit/protocol-swap2-usdt0` | USDT0 — Tether's LayerZero OFT: USDT between 16 EVM chains in one transaction |
| `@anywalletkit/protocol-swap2-uniswap` | Uniswap v3 straight from the contracts |
| `@anywalletkit/protocol-swap2-balancer` | Balancer v2, priced and enforced on-chain by the Vault |
| `@anywalletkit/protocol-swap2-fynd` | Fynd (Propeller Heads) same-chain swaps on 7 EVM chains, settled through TychoRouterV3 — Fynd outputs are under the Fynd License |
| `@anywalletkit/protocol-swap2-wrap` | Native ↔ wrapped native (ETH ↔ WETH and others) |
| `@anywalletkit/protocol-swap2-jupiter` | Jupiter — same-chain Solana swaps; the transaction is assembled and checked locally, no Jupiter fee |

## Earn

| Package | Protocol | Interface |
|---|---|---|
| `@anywalletkit/protocol-staking-lido-evm` | Lido (ETH → stETH) | `StakingProtocol` |
| `@anywalletkit/protocol-staking-ssv-evm` | SSV Network | `StakingProtocol` |
| `@anywalletkit/protocol-staking-tonstakers-ton` | Tonstakers (TON → tsTON) | `StakingProtocol` |
| `@anywalletkit/protocol-staking-spl-stake-pool-solana` | SPL stake pools (Jito by default) | `StakingProtocol` |
| `@anywalletkit/protocol-staking-native-solana` | Native SOL staking to the validators your app lists (Stake program) | `StakingProtocol` |
| `@anywalletkit/protocol-staking-native-monad` | Native MON staking to the validators your app lists (staking precompile) | `StakingProtocol` |
| `@anywalletkit/protocol-lending-aave-evm` | Aave v3 | `LendingProtocol` |
| `@anywalletkit/protocol-lending-morpho-evm` | Morpho Vaults and Blue markets | `LendingProtocol` |
| `@anywalletkit/protocol-lending-mellow-evm` | Mellow Core Vaults (EarnETH / EarnUSD) | `LendingProtocol` |
| `@anywalletkit/protocol-lending-kamino-solana` | Kamino Earn vaults and Lend markets | `LendingProtocol` |

## Data and safety

| Package | What it does |
|---|---|
| `@anywalletkit/tx-preview-evm` | What an EVM transaction will do before it is signed: decoded calls, approvals, simulated balance changes, a verdict |
| `@anywalletkit/protocol-approvals-evm` | Discover token approvals (ERC-20 / 721 / 1155 / Permit2 / EIP-7702), flag risky ones, revoke |
| `@anywalletkit/history-evm` | Activity history for every supported EVM chain |
| `@anywalletkit/names-ens` | ENS names → the address for one chain |
| `@anywalletkit/extension-kit` | The core of a Chromium (MV3) wallet extension: encrypted vault with passkey unlock, auto-locking session, dApp request router, per-origin permissions, approval queue, signing checks; no UI. See the [Browser extension guide](/guides/extension-kit/) |
| `@anywalletkit/networks` | Networks: catalog mainnets with public RPC failover lists, default testnets, user RPCs and custom networks (`NetworksTable`), per-family endpoint verification, EIP-3085 parsing |
