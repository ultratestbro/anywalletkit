---
title: Swaps and Earn
description: Adding swaps, bridges, staking and lending — which modules, which keys, and what the UI must handle.
sidebar:
  order: 9
---

## Swaps and bridges

**The job:** "I have USDT on Tron, I want ETH on Base" in one screen.

**In the kit:** eleven providers behind one `Swap2Protocol` interface, and a router that asks
all of them in parallel and tags the best and the fastest route. Before it signs, the engine
checks every quote: amounts, recipient, refund address, fee caps. The full flow is in
[Swaps and bridges](/guides/swaps/).

**You bring:**

| Provider | Key | Get one |
|---|---|---|
| LI.FI | Optional; raises the rate limit, needed for an integrator fee | [li.fi](https://li.fi), [docs](https://docs.li.fi) |
| NEAR Intents (1Click) | JWT for volume and fees | [docs.near-intents.org](https://docs.near-intents.org) |
| Jupiter | Optional; keyless is 0.5 requests per second, a key is per organisation (keep it on your server) | [developers.jup.ag](https://developers.jup.ag/portal) |
| THORChain, Chainflip, CCTP, USDT0, Uniswap, Balancer, Wrap | None | — |
| STON.fi Omniston | None; EVM orders keep an HTLC secret until delivery, so a serverless backend needs a durable store | See the module README |

- **Secrets stay on a server.** The router can reach providers through your backend (the
  remote provider in `protocol-swap2-core`), so JWTs and affiliate settings never ship in
  the app.
- **Track status.** Cross-chain swaps take minutes. Persist the swap id, poll
  `getSwap2Status`, and handle `action-required` (a CCTP claim on the destination chain).
- **Pick routes in the app.** The router tags `best` and `fastest`; which one is the default,
  and how close two routes must be to count as a tie, is your product's call.

## Earn

**The job:** staking and lending with a clear yield and a clear way out.

**In the kit:** eight modules behind two interfaces: `StakingProtocol` (stake → request
withdrawal → claim) and `LendingProtocol` (supply and withdraw; borrow and repay where the
market allows). See [Earn](/guides/earn/).

**You bring:** RPC on each chain. Some modules read rates from the protocol's own public API
(Lido's APR), which you may want to cache on your server.

**Show the user, before they deposit:**

- **How long the exit takes.** Lido's withdrawal queue takes days; a Jito exit can be
  instant at a fee, or wait for the epoch.
- **What the yield is made of**, and that it changes.
- **The health factor** before a borrow, and what happens when it drops below 1.
