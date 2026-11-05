# Curve pool allowlist

`src/pools/<chainId>.ts` is the only set of pools the Curve provider routes through. The router approves
every pool in a route forever and runs each hop with `min = 0`, so a route is exactly as safe as this list.
It is generated, reviewed in the diff, and shipped with the package. Nothing is discovered at runtime.

## Rebuild

```sh
node scripts/build-allowlist.mjs                 # every chain, rewrites src/pools/*.ts and index.ts
node scripts/build-allowlist.mjs --chain 1,8453  # some chains (index.ts lists every file present)
node scripts/build-allowlist.mjs --dry           # summary only, writes nothing
node --test scripts/build-allowlist.test.mjs     # the filter rules on fixtures, no network
```

It needs Node 22.18+, which loads the catalog's TypeScript source. Keccak-256 comes from Node's OpenSSL
(3.2+, as in Node 24) or from viem otherwise. The script self-tests keccak on start. The script is read-only:
it makes `eth_call`, `eth_getCode`, `eth_getTransactionCount` and `eth_getBlockByNumber` requests to public
RPCs in batches with backoff. `CURVE_RPC_<chainId>` replaces one RPC, and its URL is never printed or written.
A full run takes a few minutes. It prints why each notable pool was dropped and ends with a per-chain table.
A chain whose RPC fails keeps its previous file, and the exit code is 1.

## What a pool must pass

1. **Discovery** comes from `api.curve.finance/v1/getPools/all/<chain>`, or from `api2.curve.finance/get_pools/<chainId>`
   on Unichain, Monad, Plasma, Ink, Robinhood and Plume. Only `*.curve.finance` hosts are accepted. API data
   is used only to find pools and to read USD prices.
2. **Static rules**, applied in this order:
   - the hard excludes: the fake USDT pool `0xA6d9…1f53` and the pools drained on 2023-07-30 (alETH, pETH, msETH, CRV/ETH);
   - pools listed by `getHiddenPools` or flagged `isBroken`;
   - LLAMMA and families the router does not swap;
   - pools with fewer than 2 coins;
   - API TVL below the threshold: $1M on Ethereum, $250k on other chains;
   - pools holding a fee-on-transfer or rebasing token (`BAD_TOKENS`; stETH stays in);
   - pre-NG native-ETH pools compiled with Vyper 0.2.15–0.3.0.
3. **On-chain checks**, all at one pinned block:
   - `coins(i)` equals the API's coins, in the same order;
   - the pool has code, and its code hash is recorded;
   - MetaRegistry `is_registered`, or one of the chain's NG factories lists the pool;
   - `decimals()` reads for every coin;
   - `balances(i) > 0` for every coin;
   - `get_dy(0, 1, ~$100)` works with the index type the router uses (int128 for stable pools, uint256 for crypto pools).
4. **Stable-ng asset types.** Types 2 (rebasing) and 3 (ERC-4626) are refused. Type 1 (rate oracle) passes only
   when the oracle is the coin itself, as with weETH's `getRate`, or when the oracle is listed in `ORACLE_ALLOW`.
   Oracles are read from the pool's immutables and cross-checked against `stored_rates()`. If they cannot be read,
   the pool is refused. The log prints each refused oracle address so it can be reviewed.
5. **Underlying coins** (swap_type 2). A metapool's underlying is its coin plus the coins of its base pool. A
   lending pool's underlying comes from `underlying_coins(i)`. Both are checked with
   `get_dy_underlying(0, last, ~$100)`. A lending pool is listed for swap_type 2 only, because its wrapped
   coins rebase.
6. **TVL** counts only anchor coins: tokens in the SDK catalog (`@anywalletkit/swap2-assets`) on that chain,
   the native coin, and Curve's crvUSD and CRV. The pool's value is the anchored value × n / (number of anchor
   coins), capped by the full on-chain value and by the API's figure. A pool of tokens that the API misprices
   is therefore worth $0 here.
7. **Age** must be at least 30 days. The creation time comes from the API, or from a binary search on the pool's
   nonce using an archive RPC. A pool of unknown age stays only if its TVL is at least twice the threshold.
8. **Cap.** The list is ranked by TVL (descending, then by address). Ethereum keeps the top 80 and other chains
   the top 40.

## Reviewing a rebuild

- Read the diff of `src/pools/*.ts`. New pools, changed `codeHash` or changed `coins` deserve a look. Code is
  immutable, so a changed hash at the same address should never happen.
- Expect `tvlUsd`, `block` and `builtAt` to move on every run.
- A pool refused only for a foreign rate oracle can be admitted. Read the oracle contract first, then add
  `<chainId>:<oracle>` to `ORACLE_ALLOW` and say why in a comment.
- A chain without a file has no pool that passed. The provider then has no Curve routes on that chain.
