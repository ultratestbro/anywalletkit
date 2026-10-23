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

**In the kit:** today, every package takes a URL you choose, so pointing it at your proxy is
configuration. The swap engine can run behind HTTP (the remote provider in
`protocol-swap2-core`). A deployable server with the RPC proxy and the remote swap engine is
planned.

**Rules:**

- **The server never holds user keys.** Not encrypted, not "for recovery". If it signs, it
  signs for your own accounts (a relayer, a bot), with a backend signer.
- **Authenticate the app.** A public proxy is a free RPC for everyone; limit it by app
  attestation, a signed session or per-address rate limits.
- **Log nothing you'd regret.** Addresses and IPs together identify a user's whole portfolio.
- **Pin what you forward.** A proxy should allow the methods and hosts your app uses, not
  forward any URL it is given.
