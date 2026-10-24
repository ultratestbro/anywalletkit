---
title: Accounts
description: One object that answers "what is my address on Base" and hands out accounts that can sign.
sidebar:
  order: 3
---

**The job:** one place that answers "what is my address on Base" and "give me something that
can sign on Solana", for every account the user has.

**In the kit:**

| Package | Role |
|---|---|
| `wallet-*` | One package per chain family. Its manager derives accounts and knows how to read, build, sign and send on that chain |
| `kit` | The `Wallet` object: register the chains you support, then `getAccount('eip155:8453')`. [Policies](/concepts/policies/) wrap every account it hands out |
| `keyring` | Several accounts from one seed, plus imported seeds and keys, in one list across chains ([guide](/guides/keyring/)) |

Chains are named by [CAIP-2 ids](/concepts/chain-ids/): `eip155:1` for Ethereum,
`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` for Solana, and so on. Register every EVM network
under its exact id with its own RPC (`eip155:1`, `eip155:8453`, …): an EVM manager talks to the
network of its RPC only, so one `eip155` registration would send Base transactions to Ethereum
([Chain ids](/concepts/chain-ids/#one-rpc-per-evm-network)). Non-EVM chains have one network each
and register by namespace (`solana`, `ton`, `tron`, `bip122`, `near`).

Start with the [Quickstart](/getting-started/quickstart/): it creates accounts on seven
chains in about twenty lines.

**Decisions you make:**

- **Which chains you register.** Each `wallet-*` package you install adds bundle size and
  needs its own data sources ([Networks and RPC](/build-a-wallet/networks-and-rpc/)).
- **How many accounts you show.** Most wallets show account 0 and let the user add more.
  Recovering a wallet means scanning accounts 0, 1, 2… until one has no history.
- **Read-only accounts.** A watched address (no key) is useful for portfolios and for a
  "watch wallet" feature. Protocol reads like balances and approvals work on it; writes do
  not.
- **Dispose.** Call `wallet.dispose()` when the user locks the app: it wipes the seed from
  the wallet and from every manager, and the wallet refuses any later call. Build a new one
  on unlock.
