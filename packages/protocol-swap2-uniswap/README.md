# @anywalletkit/protocol-swap2-uniswap

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-swap2-uniswap?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-uniswap)

Uniswap same-chain swaps as a swap2 module, straight from the contracts: v3 (QuoterV2 quotes, SwapRouter02
`multicall(deadline, …)` execution, on the deployments in `src/addresses.ts`) and, opt-in, v4 (V4Quoter quotes on
pinned hookless pools, Universal Router 2.1.2 execution — directly for a native input, through Uniswap's SwapProxy for
a token input — on the deployments in `src/v4/addresses.ts`), ranked together by output. Every deployment is verified on chain before use. Standalone through `UniswapSwap2Protocol`, or as one
provider of the router.

## Install

```sh
npm install @anywalletkit/protocol-swap2-uniswap @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-swap2-uniswap @anywalletkit/core  ·  yarn add @anywalletkit/protocol-swap2-uniswap @anywalletkit/core
```

On npm: [@anywalletkit/protocol-swap2-uniswap](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-uniswap), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

## Behind `remoteProvider`

When the provider runs on your server, spread its pins into the app's stub:
`remoteProvider({name: "uniswap", baseUrl, ...uniswapPins})`. The engine then lets the EVM route call only the
SwapRouter in `UNISWAP_V3`, the Universal Router 2.1.2 in `UNISWAP_V4` (on the chains where v4 quotes a native input)
and the chain's pinned SwapProxy (where v4 quotes a token input), and approve only the SwapRouter and the SwapProxy —
never the Universal Router, Permit2 or an address the backend names; without the pins the stub gets no EVM calldata
route (fail closed). The pins carry `verifyQuote: uniswapVerifyQuote`, which opens the call on the device:

- to the SwapRouter: one `multicall(deadline, legs)` whose legs are exactly one `exactInputSingle` / `exactInput` (at
  most two pools), then `unwrapWETH9` for a native output (or `refundETH` for a native input, built only with
  `refundNativeInput`), selling exactly the input of the source token for the destination token with the quote's
  minimum, paid to the recipient. `pull`, `sweepToken` and every other router call are refused
  (`uniswapV3VerifyQuote`).
- to the Universal Router (native input) or the SwapProxy (token input): `uniswapV4VerifyQuote` (below).

## Uniswap v4 (opt-in)

```ts
uniswapProvider({ rpcUrls, v4: "native-in" }) // native input on v4
uniswapProvider({ rpcUrls, v4: "all" })       // and token input (into a token or the native coin) through the SwapProxy
```

- **What it quotes.** With `v4: "native-in"`, a native-coin input into an ERC-20 is quoted on v3 and on v4, at the same
  block, and the larger output wins (`v4MinEdgeBps`, default 0, makes v4 beat v3 by more than that many bps). With
  `v4: "all"`, a catalog-token input into a token or into the native coin is ranked the same way. `maxPriceImpactBps`
  gates the winner, v3 or v4, with the same two measures.
- **The call.** The same `V4_SWAP` input every time — actions `[SWAP_EXACT_IN_SINGLE | SWAP_EXACT_IN, SETTLE, TAKE]` in
  the 2.1.x layout, `SETTLE(input, amountIn, false)`, `TAKE(output, recipient, 0)` (`address(0)` for a native output,
  paid by the PoolManager straight to the recipient). A native input calls `UniversalRouter.execute(0x10, [V4_SWAP],
  deadline)` on the chain's pinned router 2.1.2 with `value = amountIn` and no approval. A token input calls the chain's
  pinned SwapProxy — `SwapProxy.execute(pinned router, token, amountIn, 0x10, [V4_SWAP], deadline)`, `value = 0`,
  `approvalAddress = SwapProxy` (the engine approves exactly the input, and revokes it if the swap does not go out; the
  swap spends it to 0). The SwapProxy pulls exactly `amount` from its caller into the router and calls it; it is 34
  lines, no owner, no storage, one codehash on every chain (address per chain: Tempo's differs). The exact SETTLE turns
  a partial fill into a revert instead of input left in the router for anyone to sweep. The provider checks its own
  build with `uniswapV4VerifyQuote` before returning it.
- **Token input is simulated before the approval.** With the sender known (an execution quote: the engine passes its
  account), the provider reads the sender's balance and allowance to the SwapProxy and simulates the approval and the
  exact swap together before it returns the quote: `eth_simulateV1` of `[approve(SwapProxy, amountIn), swap]`; where
  the RPC does not serve it (Monad, every RPC), an `eth_call` of the exact swap from the bare account with the token's
  `allowance[sender][SwapProxy]` slot set by `stateDiff` (the slot from `eth_createAccessList`, verified by reading the
  allowance back; the account's own code kept); with no slot that verifies, a 61-byte executor installed as the
  account's code by an override runs approve → swap through Multicall3. A revert is decoded and mapped as in the
  preflight; a balance under the input, an unanswered read or nothing simulable refuses — the check is never skipped,
  so nobody approves a swap that would revert. `providerData.simulated` says how (`"approve+swap"`, `"swap"` when the
  allowance already stood, `"approve+swap (allowance override)"`, `"approve+swap (executor override)"`, or `"none"` on a
  quote without a sender — a price quote nothing is approved on).
- **Pools: hookless only.** The hook allowlist is empty (hooks can take a swap's whole slippage, price the quoter and the
  router differently, or revert); dynamic fees are therefore out too; the LP fee is at most `v4MaxFeePips` (default
  100,000 = 10%). The candidates are the chain's pinned list (`@anywalletkit/protocol-swap2-uniswap/v4pools`, generated
  by `scripts/build-v4-pools.mjs` from the PoolManager's `Initialize` logs, gated on chain at one block; 856 live pools
  on Ethereum, OP, BNB, Unichain, Polygon, Monad, MegaETH, Base, Arbitrum, Avalanche, Linea and Elysium), read in one
  Multicall3 `aggregate3` on the pinned StateView, plus your `v4ExtraPools` (hookless; PoolId recomputed; a bad key
  throws when the provider is made), plus a grid of 33 fee/tick-spacing keys over the pairs that touch a token the list
  does not know. Routes are direct or through one hop currency (the native coin, the wrapped native, USDC, USDT, USDT0).
- **Fail closed.** A discovery or quote read that fails — an RPC error after the retries, a sub-call with
  `success = false`, a listed pool reading as uninitialized, a quoter call without revert data — refuses the quote as
  `rate_limited` / `upstream_unavailable`. It never quotes from fewer pools (a research lane that lost the decisive
  Monad pool to HTTP 429 reported a route 14% worse).
- **Chains.** v4 is pinned on 19 chains (`UNISWAP_V4`) and quoted where there is a pool list: shipped, or your
  `v4ExtraPools`. HyperEVM is pinned `quotable: false` (no live pool); on Arc and Celo the native coin is an ERC-20, so
  native input and output are refused there (token → token through the SwapProxy is not). Before the first v4 quote on
  a chain the provider reads `poolManager()` of the router, the V4Quoter and the StateView, the router's codehash and,
  with `"all"`, the SwapProxy's: a router mismatch turns v4 off on that chain, a SwapProxy mismatch token input only,
  never v3. On Monad the v4 reads name 30M gas (its RPCs give an `eth_call` 8.1M by default, which starved a two-hop
  quote inside a Multicall3 aggregate).
- **Preflight.** Right before signing (for a token input, after the approval), the route is re-quoted on the V4Quoter
  (a partial fill or less than the signed minimum refuses it) and the exact transaction is `eth_call`ed from the quote's
  sender (`QuoteParams.sender`, kept as `providerData.sender`): a revert is decoded and mapped (`V4TooLittleReceived` →
  `price_check_failed`, `CurrencyNotSettled` / `NotEnoughLiquidity` → `insufficient_liquidity`, `NativeTransferFailed`
  → `recipient_mismatch`, an expired deadline → `quote_expired`, a token's own `TRANSFER_FROM_FAILED` →
  `simulation_failed`), and no answer refuses.
- **Gas.** The provider declares `ownGasEstimate`: the engine sends every Uniswap call (v3 too) with the account's own
  estimate of that exact call, dry-run right before broadcast — never the quoted limit. Monad charges the gas limit, not
  the gas used: a v3 quote there carried 16.3M for 62,000 MON, the v4 route needs about 200k. The quote still carries
  its bounded `gasLimit` (quoter gas + 150k for the router, + 140k for the SwapProxy and the token's pull), as
  information and for the gas bound below.
- **`providerData`** of a v4 quote: `venue: "v4"`, `route` (e.g. "v4 via USDC 0.05%/10 → 0.005%/1"), `poolFee`, `router`,
  `currencyIn` (`address(0)` for the native coin), `currencyOut`, `amountIn`, `minOut`, `poolKeys` (JSON), `path`,
  `priceImpactBps` (`valueLossBps` when gated), `sender`, and for a token input `simulated`. A v3 quote has no `venue`,
  as before.
- **Rollout.** A 0.4.x app's `uniswapPins` names SwapRouter02 only: it drops a Universal Router or SwapProxy quote, and
  since a stub gets one quote per pair, that app loses Uniswap on the pair. So: release; apps bump to ≥ 0.5.0 pins;
  only then does the server set `v4: "native-in"`, later `"all"`. With `v4: "off"` the server keeps serving v3 to every
  app, and with `"native-in"` token input stays on v3. A route through a pool
  that only the unlisted-token grid found is not in the shipped list, so an app's pins refuse it: give both sides the
  same `v4ExtraPools` for such a pool.
- **Monad, the case behind this (cp0x):** 62,000 MON → AUSD. v3 alone pays 1.13 AUSD (impact 99.8%); v4 pays 676.61 AUSD
  at block 125,409,523 via MON → USDC (0.05%/10) → AUSD (0.005%/1), G = 23 bps, and passes `maxPriceImpactBps: 500`.
- **Token input, recorded:** Monad 700 USDC → AUSD at block 125,499,326: v4 through the SwapProxy pays 700.075685 AUSD
  on the hookless AUSD/USDC 0.005%/1 pool, simulated with the allowance set by `stateDiff`. Live on 2026-11-26 the
  approve + swap from a funded holder paid exactly the quote (≥ the minimum) on Monad (→ AUSD and → MON) and Base
  (1,000 USDC → ETH), the SwapProxy allowance back to 0 and the router's and the SwapProxy's balances unchanged.

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
  prices, fees included (`providerData.valueLossBps`), rounded down to a whole bp; the pools' floor
  rounding counts as loss (it is value the recipient does not get). A probe too small to run (under
  1,000 raw units), reverted or empty falls back to spot.
- Spot must be measured: the probe alone is blind to a pool parked past an empty range. When the
  pool lookups or `slot0()` reads go unanswered after the retries, or come back reverted, zero or in
  another shape, the quote is refused as `rate_limited` / `upstream_unavailable` ("could not measure
  the price impact … try again"), or as `insufficient_liquidity` when the probe alone already reaches
  the limit. A quote never passes with part of the check skipped.
- At or above the limit: `insufficient_liquidity`, "loses 99.8% of the value to price impact — its
  pools are too thin for this amount (limit 5%; best route via USDC 0.3% → 0.01%)".
- `preflightDeposit` does not apply it: the signed minimum governs there.

Unset, impact is never a refusal, and a healthy RPC sees 0.4.11's requests, sent as 0.4.11 sent them
(every batch at once, no queue shared by concurrent quotes), plus one `eth_getBlockByNumber` per chain
every 10 minutes (`tests/unset-byte-identical.test.ts`). Two things are always on and do change
outcomes against 0.4.11: the gas bound and the RPC error handling below.

## Gas limit and RPC errors

- **Gas (always on).** The swap's need is its bare need (quoter gas + 120k router overhead +
  unwrap/refund) plus 5%: EIP-150 forwards 63/64 of the gas into each call, and the pool's swap runs
  two calls deep (live, swaps ran in 2.1% to 3.5% over the bare need). A need above the chain's cap
  can never complete and is refused as `insufficient_liquidity`; a padded limit above the cap is
  clamped to it, never below the need. Monad charges the whole limit, so it is never lowered below
  the need. The cap is `min(per-transaction cap, block gas limit − the block's own reserve)`:

  | Chains | Per-transaction cap |
  |---|---|
  | Ethereum, OP Mainnet, BNB Chain, Unichain, World Chain, Base, Ink, Linea, Arc | 16,777,216 (2²⁴, EIP-7825) |
  | Polygon | 33,554,432 (2²⁵) |
  | Monad | 30,000,000 |
  | the others | none known: the block gas limit |

  The 2²⁴ and 2²⁵ caps were read live on 2026-11-26: `eth_estimateGas` of an endless loop names the
  most gas a transaction may have, well below those chains' blocks (40M–2B). `pnpm verify:live`
  (`scripts/verify-live.mjs`, read-only) checks every chain against the tables again, and fails on a
  chain it cannot reach. On OP-stack chains every block opens with the L1-info deposit (gasLimit
  1,000,000), so a transaction whose limit is the whole block is never included: there the block's
  limit counts less 1,000,000 (it binds on Celo, a 30M block, and X Layer); MegaETH's deposit is 100,000,000.
  Arbitrum One and Robinhood Chain (Nitro) report a 2⁵⁰ block gas limit, but execute at most 32M gas
  per transaction (`ArbGasInfo.getMaxTxGasLimit()`): a need above 32M is refused, and the limit is
  never clamped to 32M (it also pays the L1 gas). zkSync Era also reports 2⁵⁰; its per-transaction
  limit is not known, so only that header applies there.
  The block gas limit is read on its own (`eth_getBlockByNumber`), once per chain, and kept for 10
  minutes (1 minute after a failed read). It is optional: a node that does not serve it, or answers
  with an error, leaves only the known caps and never fails a quote. A quote waits for it at most
  1.5 s after the read began, and never past the caller's abort; then it goes by the known caps
  alone, and the read fills the cache when it lands.
- **RPC errors.** A per-item JSON-RPC error that is a revert (code 3; "execution reverted" and other
  EVM errors, out of gas included; revert data whose message names no rate limit or node fault)
  means no candidate, as before. A rate limit (`-32005`, `-32007`, `429`, or its text), a node error
  or a call without an answer (left out, sent with no `result`, an `eth_call` answering `null`, an
  error the node sent without an id) is retried, then refused as `rate_limited` /
  `upstream_unavailable`. It is never read as "no pool" (before 0.4.12, a rate-limited best pool
  silently lost to a worse route). The retries wait 300–600 ms, then 1–1.5 s, at random. Batches
  carry at most 10 calls and go out at once, as in 0.4.11; each gets 12 s per endpoint, also when
  the caller passes its own signal. URLs are taken out of node and transport error text.
- **`rpcCallsPerSecond` (opt-in).** A server whose keyed endpoint serves a known good-item rate
  (QuickNode answered 50 calls a second on Monad and `-32007` the rest) sets it: at most that many
  calls go to one endpoint in any second, across every quote of the provider, in batches of at most
  that many. A batch waits for its turn, first come first served; one that would wait more than 4 s
  goes to the next endpoint instead, or with none left is refused as `rate_limited` — the queue never
  outlives its callers, signal or not. Unset (the default), nothing is limited.

## Activity

`describeActivity(tx, ctx)` recognizes a call into the chain's pinned Universal Router 2.1.2 —
`execute(bytes,bytes[],uint256)` `0x3593564c` whose commands are exactly `V4_SWAP` (`0x10`), the shape this module
builds — as a `swap` with subtitle `Uniswap v4 · <chain>`, and a call into the chain's pinned SwapProxy —
`execute(address,address,uint256,bytes,bytes[],uint256)` `0x2894adf9` whose `router` is the pinned Universal Router and
whose commands are exactly `V4_SWAP` — the same; every other router or SwapProxy call (a plan with more commands, the
no-deadline entry point, an Across deposit, a SwapProxy forwarding elsewhere) stays unclaimed. Fixtures: public Unichain
transactions (ETH → token, and token → ETH paid by the PoolManager) and Ethereum SwapProxy swaps (UNI ⇄ AAVE),
negatives `0x0010` (v3 + v4) on Unichain, `0x0a10` (Permit2 + v4) on Monad, and SwapProxy plans `0x00070c` and
`0x0c100b04` on Ethereum.

It also recognizes a call into the chain's SwapRouter02
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
