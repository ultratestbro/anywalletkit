---
title: Networks and RPC
description: Where every read and broadcast goes, how to choose RPC providers per chain, and how to keep keys off the client.
sidebar:
  order: 4
---

**The job:** every balance, fee quote and broadcast goes through a node. This is where most
wallet outages come from: a rate limit, a node that lags, a method the plan doesn't serve.

**In the kit:**

- Every `wallet-*` package takes **a list** of endpoints and fails over in order, with a few
  retries across the list.
- `networks` holds the catalog of mainnets, each with public RPCs to fail over through. It
  also stores the RPCs and custom networks the user adds, and `verifyNetwork()` checks that an
  endpoint really serves the chain it claims before you trust it.

## What each chain package talks to

| Chain | Package expects | Public / free to start | Production options |
|---|---|---|---|
| EVM | JSON-RPC URL or EIP-1193 provider | [PublicNode](https://www.publicnode.com), endpoints on [Chainlist](https://chainlist.org) | [QuickNode](https://www.quicknode.com), [Alchemy](https://www.alchemy.com), [Infura](https://www.infura.io), [dRPC](https://drpc.org), [Ankr](https://www.ankr.com/rpc/), [Chainstack](https://chainstack.com) |
| Solana | JSON-RPC URL | [Public clusters](https://solana.com/docs/references/clusters) (not for production) | [Helius](https://www.helius.dev), [QuickNode](https://www.quicknode.com), [Alchemy](https://www.alchemy.com) |
| TON | toncenter v2 JSON-RPC; tonapi or toncenter v3 for emulation | [toncenter](https://toncenter.com) (low limit without a key), [tonapi](https://tonapi.io) | toncenter / tonapi with a key, [QuickNode](https://www.quicknode.com/chains) |
| Tron | Full-node HTTP API | [TronGrid](https://www.trongrid.io) (low limit without a key) | TronGrid with a key, [QuickNode](https://www.quicknode.com/chains), [GetBlock](https://getblock.io) |
| Bitcoin | Esplora or Blockbook HTTP | [mempool.space](https://mempool.space), [Blockstream](https://blockstream.info) | [QuickNode Blockbook](https://www.quicknode.com/docs/bitcoin), your own [Blockbook](https://github.com/trezor/blockbook) / [Esplora](https://github.com/Blockstream/esplora) / [mempool](https://github.com/mempool/mempool) |
| NEAR | JSON-RPC | [FastNEAR](https://fastnear.com) | [NEAR RPC providers](https://docs.near.org/api/rpc/providers) |
| Zcash | Blockchair or Blockbook | [Blockchair](https://blockchair.com/api) (low limit without a key) | Blockchair with a key, your own Blockbook |

**How we run it.** Our reference wallet uses QuickNode for its EVM chains, with public
endpoints as fallbacks. That is one setup that works, not the only one.

## Choosing a provider

| Option | Good for | Watch out |
|---|---|---|
| Public endpoints | Prototypes, fallback | Rate limits. Many refuse `eth_getLogs` without an address filter, archive reads, or `eth_simulateV1` |
| Paid providers | Production | Each plan has its own `eth_getLogs` block window (QuickNode: 10 000 blocks), per-method credit costs and per-second limits |
| Your own node | Full control | You run it: disks, upgrades, monitoring |

Before you pick, check the methods your features need on that provider's plan:

| Feature | Needs |
|---|---|
| [Review before signing](/build-a-wallet/review-and-safety/) | `eth_simulateV1` (EVM). Public endpoints on Ethereum, Base, Arbitrum, Optimism, Polygon and BNB Chain had it when we checked; Avalanche did not |
| [Approvals](/guides/approvals/) | `eth_getLogs` **without** an address filter, over long block ranges. Most free endpoints refuse it |
| [History](/build-a-wallet/history/) on Solana | `getSignaturesForAddress` and `getTransaction` with full history |
| Old transactions | Archive data |

## Keep keys off the client

A paid RPC key shipped inside an app or an extension is public: anyone can extract it and
spend your credits. Three ways out:

1. **A proxy** on your server that adds the key ([Your server](/build-a-wallet/your-server/)).
2. **Allow-listing** on the provider's dashboard: restrict the key to your app's bundle id or
   origin, and to the methods you use. This limits abuse; it does not hide the key.
3. **Client-safe keys**, where the provider designs them for that (toncenter, for one).

## Let users bring their own RPC

Power users want their own node, and some regions block public providers. `networks` stores
user RPCs per chain, can use **only** the user's RPC when asked, verifies the endpoint
before use, and parks endpoints that fail with the reason. Label screens that ran through a
user RPC: a simulation from an unknown node is not a guarantee.

:::caution[Check before you rely on a provider]
Links, plans and limits change. We checked these links on 2026-10-23. Read the provider's
current docs and pricing, test with your real traffic, and keep a second provider for
fallback. A listing here is not an endorsement.
:::
