---
title: Chain ids
description: CAIP-2 chain ids, registering chain packages by namespace or by exact id, and the EVM one-RPC-per-network rule.
sidebar:
  order: 2
---

The SDK names chains with [CAIP-2](https://chainagnostic.org/CAIPs/caip-2) ids:
`<namespace>:<reference>`. One format works for every ecosystem, so a swap from USDT on
Tron to SOL on Solana is just two ids.

| Chain | CAIP-2 id |
|---|---|
| Ethereum | `eip155:1` |
| Base | `eip155:8453` |
| Arbitrum One | `eip155:42161` |
| Any EVM network | `eip155:<chain id>` |
| Bitcoin | `bip122:000000000019d6689c085ae165831e93` |
| Solana | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| TON | `ton:-239` |
| Tron | `tron:0x2b6653dc` |
| NEAR | `near:mainnet` |
| Zcash | `zcash:mainnet` |

Every account reports its id as `account.chain`.

## Registering chain packages

`wallet.registerWallet(key, Manager, config)` accepts either form:

- **Exact id** (`'eip155:8453'`): serves only that chain.
- **Namespace** (`'solana'`, `'ton'`, `'bip122'`): serves every id that starts with it.

`wallet.getAccount(chain)` uses the exact registration first and falls back to the
namespace.

### One RPC per EVM network

An EVM chain manager talks to **one** network: the network of its RPC. Register each EVM
network you support under its exact id, with its own RPC:

```ts
wallet.registerWallet('eip155:1', WalletManagerEvm, { provider: ETHEREUM_RPC, chainId: 1 })
wallet.registerWallet('eip155:8453', WalletManagerEvm, { provider: BASE_RPC, chainId: 8453 })
```

Registering `'eip155'` once with an Ethereum RPC and then asking for `'eip155:8453'` gives
you an account whose transactions go to **Ethereum**. Avoid this pattern.

### Pass `chainId` with every EVM registration

`chainId` in the EVM config is optional, but pass it, matching the id you register under:

```ts
wallet.registerWallet('eip155:8453', WalletManagerEvm, { provider: 'https://base-rpc.publicnode.com', chainId: 8453 })
```

Without it the account learns its network from the RPC (`eth_chainId`) on first use. Until
then `account.chain` reads `eip155:unknown`, so code that keys on it (swap2's
`fromChain: account.chain`, policies per chain, history) has nothing to match, and offline
signing of a transaction without its own `chainId` is impossible. With it, the chain is known
at once and no extra RPC call is made. Non-EVM managers have one network and no `chainId`.

## Assets

Tokens use [CAIP-19](https://chainagnostic.org/CAIPs/caip-19) ids in the swap packages,
for example `eip155:1/erc20:0xdAC17F958D2ee523a2206206994597C13D831ec7` for USDT on
Ethereum. Account methods such as `getTokenBalance` and `transfer` take the chain's own
token identifier: a contract address, an SPL mint, a jetton master.
