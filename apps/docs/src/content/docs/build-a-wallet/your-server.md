---
title: Your server
description: What a wallet backend is for, what never goes on it, and the minimal set of routes.
sidebar:
  order: 12
---

A non-custodial wallet can run without a server. Most production wallets still have one,
for the parts that can't live in the app.

**What it is for:**

| Need | Why not in the app |
|---|---|
| RPC and explorer proxy | Paid keys in an app are public ([Networks and RPC](/build-a-wallet/networks-and-rpc/#keep-keys-off-the-client)) |
| Swap provider proxy | Provider JWTs and affiliate settings ([Swaps](/build-a-wallet/swaps-and-earn/)) |
| Swap status tracking | A cross-chain swap may need an action after the app is closed (Omniston disclosure, CCTP claim) |
| Notifications | Watching addresses and pushing to devices ([Notifications](/build-a-wallet/fiat-and-notifications/#notifications)) |
| Price cache | One price API call for all users instead of one per user |

**In the kit:**

- **Swap backend:** `createSwap2Handler` from `@anywalletkit/protocol-swap2-core/server` runs the
  providers on your server; the app reaches them with `remoteProvider`. It validates every
  request, seals quotes (HMAC) and builds deposits only for quotes it sealed, and requires a
  `guard` for authentication and rate limiting.
- **A reference server:** [`examples/server`](https://github.com/ultratestbro/anywalletkit/tree/main/examples/server)
  wires that handler and a JSON-RPC proxy (method allowlist, failover, no keys in errors) on
  `node:http`, tested in CI. [Ship a wallet](/build-a-wallet/ship-a-wallet/) walks through it
  with the app.
- **Everything else is configuration:** every package takes the URL you choose, so pointing it at
  your proxy needs no SDK change.
- **Not in the kit yet:** notifications (address watching → push), a shared price cache, and a
  durable store for Omniston's EVM → TON orders.

**Rules:**

- **The server never holds user keys.** Not encrypted, not "for recovery". If it signs, it
  signs for your own accounts (a relayer, a bot), with a backend signer.
- **Authenticate the app.** A public proxy is a free RPC for everyone; limit it by app
  attestation, a signed session or per-address rate limits.
- **Log nothing you'd regret.** Addresses and IPs together identify a user's whole portfolio.
- **Pin what you forward.** A proxy should allow the methods and hosts your app uses, not
  forward any URL it is given.
