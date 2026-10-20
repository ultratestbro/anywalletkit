---
title: Introduction
description: What Any Wallet Kit is, who it is for and the principles it is built on.
sidebar:
  order: 1
---

Any Wallet Kit is an open-source SDK for building self-custodial multichain wallets.
One seed phrase gives you accounts on EVM networks, Bitcoin, Solana, TON, Tron, NEAR and Zcash
behind a single account interface. Protocol modules — swaps, cross-chain swaps, staking,
lending, token approvals — are written against that interface, so a wallet picks the blocks
it needs and nothing else.

:::caution[Pre-release]
The SDK is not on npm yet. Package names on this site use the final `@anywalletkit/` scope;
APIs may still change before `1.0`.
:::

## Who it is for

- **Wallet developers** — ship a multichain wallet (mobile app, extension) without writing
  chain plumbing, derivation, fee models or swap integrations yourself.
- **dApp and Mini App developers** — embed wallet features next to your product
  (an embedded, semi-custodial kit is planned).

## Principles

- **Signer is separate from the account.** The private key lives in a `Signer`. The local
  seed signer is one implementation; a Safe, a hardware wallet, MPC or a backend signer are
  others. The SDK never *requires* a seed.
- **Built for mobile apps.** React Native / Hermes is the primary target and the release
  gate: every chain is tested in the real Hermes VM. No native modules and no polyfill magic
  inside packages — one runtime package installs what Hermes is missing.
- **Refusals are named, never silent.** When a quote, transaction or route cannot be used,
  you get an error that says why, not a `null`.
- **Zeroize by design.** Everything that holds a key has `dispose()`.
- **Open contribution model.** A module is accepted when it passes the conformance suite and
  names a maintainer. Modules are tiered `core` / `verified` / `community`; an unmaintained
  module becomes `deprecated` instead of being silently kept or deleted.

## How it fits together

| Layer | Packages | Role |
|---|---|---|
| Core | `core`, `conformance` | Signer and account interfaces, protocol base classes, errors, key derivation, test suites every module must pass |
| Chains | `wallet-evm`, `wallet-btc`, `wallet-solana`, `wallet-ton`, `wallet-tron`, `wallet-near`, `wallet-zcash` | Accounts, balances, transfers, signing and fees per chain family |
| Protocols | `protocol-swap2-*`, `protocol-staking-*`, `protocol-lending-*`, `protocol-approvals-evm` | Swaps and bridges, staking, lending, approvals |
| Orchestration | `kit`, `keyring` | Register chains and modules, look accounts up by chain, enforce policies before every broadcast; many accounts and imported keys |
| Data & safety | `tx-preview-evm`, `history-evm`, `names-ens` | Pre-sign transaction review, activity history, ENS names |
| Runtime | `runtime-hermes` | React Native / Hermes polyfills |

See [Packages](/getting-started/packages/) for the full list.
