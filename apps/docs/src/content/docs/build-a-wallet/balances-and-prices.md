---
title: Balances and prices
description: Reading balances, finding which tokens the user holds, and putting a fiat value next to them.
sidebar:
  order: 5
---

## Balances

**The job:** show what the user holds on every chain.

**In the kit:** every account reads its native balance (`getBalance()`) and the token
balances you ask for (`getTokenBalance(token)`, `getTokenBalances(tokens)`). The code is in the
[Balances guide](/guides/balances/).

### Finding which tokens to show

The chain has no "tokens held by this address" call. Three ways to build the list:

| Way | How | Trade-off |
|---|---|---|
| A token list | The asset registry in `swap2-assets` (about 400 tokens across the catalog chains), or your own list; read those balances | Cheap and predictable, but misses anything outside the list |
| A holdings indexer | One call returns every token with a balance | Finds everything, spam included; one more provider |
| The history | Tokens the user ever received ([History](/build-a-wallet/history/)) | Free with history; needs a balance read per token |

Most wallets combine the first two: show the list, and add anything else found with a
balance behind a "hidden / spam" filter.

**Holdings indexers:**

| Chain | Examples |
|---|---|
| EVM | [Alchemy Token API](https://docs.alchemy.com/reference/alchemy-gettokenbalances), [Moralis](https://www.moralis.com), [GoldRush (Covalent)](https://www.goldrush.dev), [QuickNode](https://www.quicknode.com) add-ons |
| Solana | [Helius](https://docs.helius.dev), or RPC `getTokenAccountsByOwner` |
| TON | [tonapi](https://docs.tonconsole.com/tonapi) jettons by owner |
| Tron | [TronGrid](https://developers.tron.network/docs/trongrid) account endpoint |

### Gotchas

- **Amounts are `bigint` in base units.** Format with the token's decimals. Never convert a
  large value through `Number(…)`: on some Hermes builds it returns garbage above 2⁶³. For
  display, use `bigintToUnits(value, decimals)` from `core`.
- **The gas coin differs per network.** POL on Polygon, MNT on Mantle, USDC on Arc. Take the
  symbol and decimals from the network, not from a hardcoded "ETH".
- **Pending sends.** A balance read right after a broadcast may not include it yet. Show the
  pending amount from your own record until the transaction lands.
- **Spam tokens.** Airdropped tokens with names like "Claim reward at …" are phishing. Hide
  unknown tokens by default and never show their names as links.

## Prices

**The job:** a fiat value next to every amount, and a portfolio total.

**In the kit:** nothing yet.

**You bring:** a price API.

| Provider | Notes |
|---|---|
| [CoinGecko API](https://docs.coingecko.com) | Look up by contract address per platform; free demo tier |
| [CoinMarketCap API](https://coinmarketcap.com/api/) | Free basic tier |
| [DefiLlama API](https://api-docs.defillama.com) | Prices by `chain:address`, keyless coins endpoint |

**Rules:**

- **Look tokens up by contract address**, never by symbol: symbols collide, and fake tokens
  copy real ones.
- **Cache** prices for a minute or more, and show when a price is stale.
- **Proxy the key** through your server if the plan needs one.
- **Show "no price" rather than $0** for a token the API doesn't know.

:::caution[Check before you rely on a provider]
Plans, limits and coverage change. We checked these links on 2026-10-23. Read each
provider's current terms and test with your real token list. A listing here is not an
endorsement.
:::
