# @anywalletkit/protocol-swap2-uniswap

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-swap2-uniswap?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-uniswap)

Uniswap v3 same-chain swaps as a swap2 module: QuoterV2 quotes, SwapRouter02
`multicall(deadline, …)` execution, on the deployments in `src/addresses.ts`
(each verified on-chain before use). Standalone through `UniswapSwap2Protocol`,
or as one provider of the router.

## Install

```sh
npm install @anywalletkit/protocol-swap2-uniswap @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-swap2-uniswap @anywalletkit/core  ·  yarn add @anywalletkit/protocol-swap2-uniswap @anywalletkit/core
```

On npm: [@anywalletkit/protocol-swap2-uniswap](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-uniswap), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

## Behind `remoteProvider`

When the provider runs on your server, spread its pins into the app's stub:
`remoteProvider({name: "uniswap", baseUrl, ...uniswapPins})`. The engine then lets the EVM route call and
approve only the SwapRouter in `UNISWAP_V3`, never an address the backend names; without the pins the stub gets no
EVM calldata route (fail closed). The pins carry `verifyQuote: uniswapVerifyQuote`, which opens the router call on the
device: one `multicall(deadline, legs)` whose legs are exactly one `exactInputSingle` / `exactInput` (at most two
pools), then `unwrapWETH9` for a native output (or `refundETH` for a native input, built only with `refundNativeInput`), selling exactly the input of the
source token for the destination token with the quote's minimum, paid to the recipient. `pull`, `sweepToken` and every
other router call are refused.

## Price impact: information, or a refusal you opt into

Every quote carries `providerData.priceImpactBps`: the best route's full-size rate against a 1/1000
probe on the same route (pool fees cancel). By default it is information only — nothing is refused
for impact, so a wallet can warn and let the user decide.

`maxPriceImpactBps` (an integer 1..10000, unset by default) turns it into a refusal, for an app that
never wants to offer such a route (a web swap page might set 500):

```ts
uniswapProvider({ rpcUrls, maxPriceImpactBps: 500 })
```

- Every candidate is ranked as always; only the best route is gated, and a refused quote never
  falls back to a lower-output candidate.
- All reads of the quote are pinned to one block, with transient RPC errors retried.
- The measure is the larger of the probe and the spot value loss against the pools' `slot0()` mid
  prices, fees included (`providerData.valueLossBps`). A probe too small to run (under 1,000 raw
  units), reverted or empty falls back to spot.
- Spot must be measured: the probe alone is blind to a pool parked past an empty range. When the
  pool lookups or `slot0()` reads go unanswered after the retries, or come back reverted, zero or in
  another shape, the quote is refused as `rate_limited` / `upstream_unavailable` ("could not measure
  the price impact … try again"), or as `insufficient_liquidity` when the probe alone already reaches
  the limit. A quote never passes with part of the check skipped.
- At or above the limit: `insufficient_liquidity`, "loses 99.8% of the value to price impact — its
  pools are too thin for this amount (limit 5%; best route via USDC 0.3% → 0.01%)".
- `preflightDeposit` does not apply it: the signed minimum governs there.

Unset, impact is never a refusal, and a healthy RPC sees 0.4.11's requests plus one
`eth_getBlockByNumber` per chain every 10 minutes (`tests/unset-byte-identical.test.ts`). Two things
are always on and do change outcomes against 0.4.11: the gas bound and the RPC error handling below.

## Gas limit and RPC errors

- **Gas (always on).** The swap's need is its bare need (quoter gas + 120k router overhead +
  unwrap/refund) plus 5%: EIP-150 forwards 63/64 of the gas into each call, and the pool's swap runs
  two calls deep (live, swaps ran in 2.1% to 3.5% over the bare need). A need above
  `min(per-transaction cap, block gas limit)` can never complete and is refused as
  `insufficient_liquidity`; a padded limit above that cap is clamped to it, never below the need.
  The per-transaction caps are Ethereum's 16,777,216 (EIP-7825) and Monad's 30M. Monad charges the
  whole limit, so it is never lowered below the need.
  Arbitrum One and Robinhood Chain (Nitro) report a 2⁵⁰ block gas limit, but execute at most 32M gas
  per transaction (`ArbGasInfo.getMaxTxGasLimit()`): a need above 32M is refused, and the limit is
  never clamped to 32M (it also pays the L1 gas). zkSync Era also reports 2⁵⁰; its per-transaction
  limit is not known, so only that header applies there.
  The block gas limit is read on its own (`eth_getBlockByNumber`), once per chain, and kept for 10
  minutes (1 minute after a failed read). It is optional: a node that does not serve it, or answers
  with an error, leaves only the known caps and never fails a quote.
- **RPC errors.** A per-item JSON-RPC error that is a revert (code 3; "execution reverted" and other
  EVM errors, out of gas included; revert data whose message names no rate limit or node fault)
  means no candidate, as before. A rate limit (`-32005`, `-32007`, `429`, or its text), a node error
  or a call left out of the answer is retried, then refused as `rate_limited` /
  `upstream_unavailable`. It is never read as "no pool" (before 0.4.12, a rate-limited best pool
  silently lost to a worse route). The retries wait 300–600 ms, then 1–1.5 s, at random. Batches
  carry at most 10 calls, and at most 4 batches are in flight per chain, shared by every quote of
  the provider (one v3 quote fits in one wave); each batch gets 12 s per endpoint, also when the
  caller passes its own signal.

## Activity

`describeActivity(tx, ctx)` recognizes a call into the chain's SwapRouter02
(the deployment table, or the `deployments` override you passed) with one of
its swap entry points — `multicall(uint256,bytes[])` `0x5ae401dc`,
`multicall(bytes[])` `0xac9650d8`, `multicall(bytes32,bytes[])` `0x1f0464d1`,
`exactInputSingle` `0x04e45aaf`, `exactInput` `0xb858183f`,
`exactOutputSingle` `0x5023b4df`, `exactOutput` `0x09b81346` — as `swap`,
"Swapped A → B" from the owner's net transfers (native legs via
`unwrapWETH9` / `value` included). Subtitle `Uniswap v3 · <chain>`,
counterparty = the router. Symbols come from the transfers or the swap2-assets
catalog; unknown tokens show as a shortened address.

Fixtures (`fixtures/activity/`, public Ethereum transactions, 2026-10-14 — the
test wallet's Uniswap runs were quote-only on the matrix): `exactInputSingle`
USDC → SHFL, `multicall(deadline)` USDC → USDT (the shape this module builds),
`multicall(bytes[])` KEKIUS → ETH, `exactInput` USDC → AGRS; negatives: a
Balancer Vault swap, a WETH9 deposit.
