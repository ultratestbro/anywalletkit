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

When the provider runs on your server, give the app the Uniswap stub:

```ts
uniswapRemoteProvider({ baseUrl: "/api/v2/swap2" })
// = remoteProvider({name: "uniswap", baseUrl, ...uniswapPins}) + ownGasEstimate: true + describeActivity
```

`ownGasEstimate` makes the engine send every Uniswap call with the account's own estimate of that exact call, dry-run
right before the broadcast — never the backend's quoted gas limit (Monad charges the whole limit: a v3 quote there
carries 16.3M for 62,000 MON). A bare `remoteProvider({name: "uniswap", baseUrl, ...uniswapPins})` still works, but core
stubs carry no `ownGasEstimate`, so it broadcasts the backend's limit. The engine lets the EVM route call only the
SwapRouter in `UNISWAP_V3`, the Universal Router 2.1.2 in `UNISWAP_V4` (on the chains where v4 quotes a native input)
and the chain's pinned SwapProxy (where v4 quotes a token input), and approve only the SwapRouter and the SwapProxy —
never the Universal Router, Permit2 or an address the backend names; without the pins the stub gets no EVM calldata
route (fail closed). `uniswapPinsWith({v4ExtraPools, clockSkewSeconds})` (also options of `uniswapRemoteProvider`)
builds the same pins with the integrator's own v4 pools — the ones its server's provider has as `v4ExtraPools` — and
more clock skew on a v4 deadline (default 60 s); `uniswapPins` is `uniswapPinsWith()`. The pins carry `verifyQuote`
(`uniswapVerifyQuote` for the shipped ones), which opens the call on the device:

- to the SwapRouter: one `multicall(deadline, legs)` whose legs are exactly one `exactInputSingle` / `exactInput` (at
  most two pools), then `unwrapWETH9` for a native output (or `refundETH` for a native input, built only with
  `refundNativeInput`), selling exactly the input of the source token for the destination token with the quote's
  minimum, paid to the recipient. `pull`, `sweepToken` and every other router call are refused
  (`uniswapV3VerifyQuote`).
- to the Universal Router (native input) or the SwapProxy (token input): `uniswapV4VerifyQuote` (below).

A quote that names its route (`routeId: "v3"` / `"v4"`, from a server whose provider runs with `venueRoutes: "both"`) gets
only that venue's check: the routeId the app shows is the venue the calldata runs on. `uniswapRemoteProvider({baseUrl,
multiQuotes: true})` asks such a server for both venues as two candidates ([below](#uniswap-v3-and-v4-as-two-routes-venueroutes)).

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
  preflight; a balance under the input, an unanswered read or nothing simulable refuses that v4 quote — the check is
  never skipped, so nobody approves a swap that would revert. A read of the check that no endpoint answered after the
  retries (the balance, the allowance, the access list, the slot read-back, the swap's or the executor's `eth_call`)
  refuses the whole quote with the node's reason, `rate_limited` / `upstream_unavailable` — never v3 in its place
  (decision 5: on Monad one `-32007` on the allowance read used to return v3's 1.13 AUSD for 700 USDC, v4 paying 700.08). `providerData.simulated` says how (`"approve+swap"`,
  `"swap"` when the allowance already stood, `"approve+swap (allowance override)"`, `"approve+swap (executor
  override)"`, or `"none"` on a quote without a sender — a price quote nothing is approved on).
- **v4 on never costs a pair its v3 route.** A v4 build refused for a reason of the build falls back instead of
  refusing the quote: when the best v4 route's own pools fail its simulated swap (`V4TooLittleReceived`,
  `CurrencyNotSettled`…), its encoding or the module's own check refuses it, the next v4 candidate is built (at most 3);
  when what every v4 build shares fails — the endpoint cannot simulate the approval and the swap (a method or a state
  override it does not take, an answer in another shape), the approval or the token's pull into the SwapProxy fails —
  the quote goes straight to v3, and with no v3 route the best route's reason refuses it. A read that went unanswered
  is no such fact: it refuses the quote (above). The trade's own verdicts still refuse the quote outright (no route could pass them): the impact gate, a
  minimum that rounds to 0, the caller's floor, a wallet holding less than the input, a recipient that cannot take
  the native coin, and a recipient the chain's v4 pins name as a sink — a router sentinel, the zero address, the
  Universal Router, SwapProxy, PoolManager, PositionManager, V4Quoter, StateView or Permit2 — refused before any read
  for every venue once v4 is on (v3 output paid there is stranded too; the 0.5.0 pins refuse a v3 quote paying one on
  a chain with v4 pins). A candidate whose gas need is above the chain's bound (per-transaction cap or block gas limit) is
  ranked out before ranking, like the LIVE-1 ones, and counted in `providerData.v4Unexecutable`. Live on Monad
  (2026-11-26, fault injection): 700 USDC → AUSD from a funded holder on an RPC with no access list and no
  `eth_call` state overrides now quotes v3 (before: refused), and on v4 alone is still refused with the node's reason.
- **Pools: hookless only.** The hook allowlist is empty (hooks can take a swap's whole slippage, price the quoter and the
  router differently, or revert); dynamic fees are therefore out too; the LP fee is at most `v4MaxFeePips` (default
  100,000 = 10%; a setting can lower it, never raise it — the verifier's `maxFeePips` too). The candidates are the
  chain's pinned list (`@anywalletkit/protocol-swap2-uniswap/v4pools`, generated by `scripts/build-v4-pools.mjs` from
  the PoolManager's `Initialize` logs, gated on chain at one block; 1,052 live pools on the 18 quotable catalog v4
  chains: Ethereum, OP, BNB, Unichain, Polygon, Monad, X Layer, World Chain, MegaETH, Robinhood Chain, Arc, Base,
  Arbitrum, Celo, Avalanche, Ink, Linea and Elysium — on Arc and Celo token ↔ token pools only), read in one
  Multicall3 `aggregate3` on the pinned StateView, plus your `v4ExtraPools` (hookless; PoolId recomputed; a bad key
  throws when the provider is made), plus a grid of 33 fee/tick-spacing keys over the pairs that touch a token the list
  does not know. Routes are direct or through one hop currency (the native coin, the wrapped native, USDC, USDT, USDT0).
- **Fail closed.** A discovery or quote read that fails — an RPC error after the retries, a sub-call with
  `success = false`, a listed pool reading as uninitialized, a quoter call without revert data — refuses the quote as
  `rate_limited` / `upstream_unavailable`. It never quotes from fewer pools (a research lane that lost the decisive
  Monad pool to HTTP 429 reported a route 14% worse).
- **A route no transaction can carry is not a route.** A quoter call that comes back without revert data even alone in
  its aggregate is read once more, straight to the V4Quoter, with exactly the chain's per-transaction gas cap named
  (where the module knows it: `KNOWN_TX_GAS_CAP` — 2²⁴, 2²⁵, Monad's 30M — else the execution cap
  `KNOWN_EXECUTION_GAS_CAP`, 32M on Arbitrum and Robinhood Chain, whose Nitro never runs more in one transaction). Still empty there, the route needs more gas than any
  transaction on the chain may have — it can never be mined (§6.5 row 17) — so it is ranked out and counted
  (`providerData.v4Unexecutable`); the other candidates quote as usual. A re-read the node does not answer, or answers
  under a gas cap of its own, still refuses; so does an empty call on a chain whose cap is not known. Live on Monad
  (2026-11-26) a 0.05%/1 MON/AUSD candidate needed 61.3M quoter gas: before, it refused every Uniswap quote whose
  candidate set held it (2,000 AUSD → MON, 20,000 USDC → AUSD, v3 included); now 2,000 AUSD → MON pays 182,815.6 MON on
  v4 with 4 such candidates ranked out (v3 alone: 78.65 MON). The preflight re-quote names the same read gas as the
  quote (Monad 30M).
- **Chains.** v4 is pinned on 19 chains (`UNISWAP_V4`) and quoted where there is a pool list: shipped (18 chains:
  every pinned one but HyperEVM), or your `v4ExtraPools`. HyperEVM is pinned `quotable: false` (no live pool); on Arc
  and Celo the native coin is an ERC-20, so native input and output are refused there (token → token through the
  SwapProxy is not). The research rates MegaETH, Celo, Linea and World Chain as adding nothing over v3 today; their
  lists ship anyway (decision 6: pins for every catalog v4 chain, v4 default off), so a server can turn v4 on there
  without a release. Before the first v4 quote on
  a chain the provider reads `poolManager()` of the router, the V4Quoter and the StateView, the router's codehash and,
  with `"all"`, the SwapProxy's: a router mismatch turns v4 off on that chain, a SwapProxy mismatch token input only,
  never v3 — and alerts (§6.5 row 15, "refuse + alert"): `onV4Warning(text, {chainId, reason: "vault_mismatch"})`
  names what does not match, on every quote while it lasts. The same hook hears a v4 build set aside for a fallback
  (above). It is the operator's channel, not the caller's `onRefusal` (first-wins, and dropped by the handlers when a
  quote stands); a throw or a rejected promise in it is ignored. On Monad the v4 reads name 30M gas (its RPCs give an `eth_call` 8.1M by default, which starved a two-hop
  quote inside a Multicall3 aggregate).
- **Preflight.** Right before signing (for a token input, after the approval), the route is re-quoted on the V4Quoter
  (a partial fill or less than the signed minimum refuses it) and the exact transaction is `eth_call`ed from the quote's
  sender (`QuoteParams.sender`, kept as `providerData.sender`): a revert is decoded and mapped (`V4TooLittleReceived` →
  `price_check_failed`, `CurrencyNotSettled` / `NotEnoughLiquidity` → `insufficient_liquidity`, `NativeTransferFailed`
  → `recipient_mismatch`, an expired deadline → `quote_expired`, a token's own `TRANSFER_FROM_FAILED` →
  `simulation_failed`), and no answer refuses. A node refusing the dry-run because the sender holds less than it sends
  ("insufficient funds for transfer", Monad's `-32003`, reth's `OutOfFunds`) is read as that answer — `simulation_failed`
  naming the balance, at once — never as "no RPC answered" after the retries.
- **Gas.** The provider — and `uniswapRemoteProvider`, an app's stub for it — declares `ownGasEstimate`: the engine
  sends every Uniswap call (v3 too) with the account's own estimate of that exact call, dry-run right before broadcast —
  never the quoted limit. Monad charges the gas limit, not the gas used: a v3 quote there carried 16.3M for 62,000 MON,
  the v4 route needs about 200k. (A bare `remoteProvider({...uniswapPins})` stub has no `ownGasEstimate`: it sends the
  backend's limit.) The quote still carries its bounded `gasLimit` (quoter gas + 150k for the router, + 140k for the
  SwapProxy and the token's pull), as information and for the gas bound below; the pins refuse a quoted limit above the
  chain's per-transaction cap (`KNOWN_TX_GAS_CAP`, the provider's own table: 2²⁴ on Ethereum, OP, BNB, Unichain, World
  Chain, Base, Ink, Linea and Arc, 2²⁵ on Polygon, 30M on Monad).
- **`providerData`** of a v4 quote: `venue: "v4"`, `route` (e.g. "v4 via USDC 0.05%/10 → 0.005%/1"), `poolFee`, `router`,
  `currencyIn` (`address(0)` for the native coin), `currencyOut`, `amountIn`, `minOut`, `poolKeys` (JSON), `path`,
  `priceImpactBps` (`valueLossBps` when gated), `sender`, for a token input `simulated`, and `v4Unexecutable` (the count
  of candidates ranked out for gas, when any — on a v3 quote too, with v4 on). A v3 quote has no `venue`, as before.
- **Rollout.** A 0.4.x app's `uniswapPins` names SwapRouter02 only: it drops a Universal Router or SwapProxy quote, and
  since a stub gets one quote per pair, that app loses Uniswap on the pair. So: release; apps bump to ≥ 0.5.0 pins
  (`uniswapRemoteProvider`); only then does the server set `v4: "native-in"`, later `"all"`. With `v4: "off"` the server
  keeps serving v3 to every app, and with `"native-in"` token input stays on v3.
- **List rebuilds (`v4RankedListBlock`).** The lists are rebuilt and released when the watch reports a new live hookless
  pool, so a server can run a newer list than some of the apps it serves — and an app refuses a route over a pool its
  own list lacks. So the lists only grow (a rebuild keeps every pool it listed before, so an older server's routes stay
  acceptable to newer apps), and a rebuild marks each pool it adds with its build block (`since`; a chain's first list
  in a later release marks all of them). By default a server ranks against v3 only the pools of the chain's first
  shipped list; a pool with `since` is ranked like a grid pool — returned only when v3 has no route. Once every app it
  serves runs a release whose list for the chain was built at block B or later (`UNISWAP_V4_POOLS[chain].block`), the
  server sets `v4RankedListBlock: {[chain]: B}` and those pools compete. With `v4RankedPools: "extra"` the same order
  holds for `v4ExtraPools`: add a pool to every app's `uniswapPinsWith({v4ExtraPools})` first, then to the server's.
- **Pool provenance across the corridor (`v4RankedPools`).** An app's pins accept a v4 pool only from the shipped list or
  from the `v4ExtraPools` it pins itself (`uniswapPinsWith`). A pool the server's unlisted-token grid found is neither,
  and is found per request, so it cannot be shared. By default (`"listed"`) the server ranks only shipped-list routes
  against v3 (the first list's pools, see `v4RankedListBlock` above): a route through a grid or an extra pool is
  returned only when v3 has no route for the pair, so an app never loses the v3 quote it had. `"extra"` ranks the server's `v4ExtraPools` too — set it when every app pins the same
  pools with `uniswapPinsWith({v4ExtraPools})`; `"all"` ranks everything, for a provider running in the app itself.
- **Deadline.** A v4 swap's deadline is at most 600 s ahead, whatever `deadlineSeconds` says (v3 keeps the full value):
  that is the bound the pins hold a v4 quote to, plus 60 s of clock skew. A server at `deadlineSeconds: 1200` would
  otherwise have every app refuse the v4 quote — Uniswap lost wherever v4 wins. A device whose clock may run further
  behind sets `uniswapPinsWith({clockSkewSeconds})` (at most 3600).
- **Monad, the case behind this (cp0x):** 62,000 MON → AUSD. v3 alone pays 1.13 AUSD (impact 99.8%); v4 pays 676.61 AUSD
  at block 125,409,523 via MON → USDC (0.05%/10) → AUSD (0.005%/1), G = 23 bps, and passes `maxPriceImpactBps: 500`.
- **Token input, recorded:** Monad 700 USDC → AUSD at block 125,499,326: v4 through the SwapProxy pays 700.075685 AUSD
  on the hookless AUSD/USDC 0.005%/1 pool, simulated with the allowance set by `stateDiff`. Live on 2026-11-26 the
  approve + swap from a funded holder paid exactly the quote (≥ the minimum) on Monad (→ AUSD and → MON) and Base
  (1,000 USDC → ETH), the SwapProxy allowance back to 0 and the router's and the SwapProxy's balances unchanged.

## Uniswap v3 and v4 as two routes (`venueRoutes`)

By default (`venueRoutes: "best"`) the provider returns one quote per request: v3 and v4 ranked together, the larger
output returned. An app that shows the two venues as separate rows — "Uniswap v3" and "Uniswap v4" — sets
`venueRoutes: "both"` (v4 must be on: with `v4: "off"` the provider throws when it is made). The route-picking policy
stays in the app; the provider only offers both.

```ts
// The provider in the app:
const uniswap = uniswapProvider({ rpcUrls, v4: "all", venueRoutes: "both" })
const swap2 = new RouterSwap2Protocol(account, { fromChain: "eip155:143", providers: [uniswap /* , … */] })
const routes = await swap2.quoteSwap2Routes(options)
// [{provider: "uniswap", routeId: "v4", …}, {provider: "uniswap", routeId: "v3", …}, …the other venues]
const label = (r: Swap2Route) => (r.provider === "uniswap" ? `Uniswap ${r.routeId}` : r.provider)
await swap2.using(picked.provider, picked.routeId).swap2(options)

// Behind a backend — the server's provider runs with venueRoutes "both", the app's stub asks for /quotes:
createSwap2Handler({ providers: [uniswapProvider({ rpcUrls, v4: "all", venueRoutes: "both" })], sealSecret, guard })
uniswapRemoteProvider({ baseUrl: "/api/v2/swap2", multiQuotes: true })
```

- **Two candidates, one pass.** `getQuotes(params)` returns up to two quotes: `routeId: "v3"`, the best v3 route, and
  `routeId: "v4"`, the best v4 route. Both come from the reads one `"best"` quote makes — the deployment checks, v3 and
  v4 at the same block (pinned with `maxPriceImpactBps`, else `latest`), one batch set — plus the 1/1000 probe of the
  venue that would have lost (and, for a token input, its approve + swap simulation). So `"both"` never costs less
  than one `"best"` quote: it makes every read that quote makes, plus that venue's probe and checks. Live on 2026-11-26
  (read-only, each comparison at one pinned block, no `maxPriceImpactBps`): 18–38 JSON-RPC calls for both candidates
  against 17–37 for one `"best"` quote, 1–4 calls more, a ratio of 1.03–1.14. With `maxPriceImpactBps` the losing
  venue's own spot reads for the gate come on top: on the recorded Monad 62,000 MON → AUSD pass, 41 calls against 36
  (5 more, a ratio of 1.14).
- **Each one as if it had won.** A candidate is built and checked exactly as a winning quote is: the impact gate of
  `maxPriceImpactBps` on each venue's own best route, the minimum and the caller's floor, the gas bound, the module's
  own strict v4 check, the token-input simulation before any approval, the fallback to the next v4 route when the best
  one's build is refused (at most 3). Within the `v4RankedPools` provenance rule (below), each equals what that venue
  alone returns at the same block (v4 off for v3, no v3 deployment for v4) — checked live on Monad, Robinhood Chain,
  Base and Unichain. Where v3 has a route, the v4 candidate is the best route over ranked pools, so it can differ from
  a v4-alone quote through a grid, extra or newer-list pool, or be missing where that is v4's only route. The v3
  candidate is v3's highest-output route, picked before the gas bound as in a `"best"` pass: where that route needs
  more gas than the chain takes in one transaction, the v3 row is refused (`insufficient_liquidity`), even if a
  lower-output v3 route could be mined. v4 ranks such routes out first (`v4Unexecutable`); v3 does not yet, in either
  mode.
- **One venue refusing never drops the other.** A v4 read rate-limited, a v4 deployment that does not match its pins,
  every v4 simulation reverting, a wallet short of the input for the v4 simulation, the gate refusing v3's thin pool:
  the other candidate still stands. With both refused, `getQuotes` returns `[]` and `onRefusal` hears one refusal that
  names both reasons (`"v3: …; v4: …"`), classified by the first one that says more than "no route here"; on a chain
  with Uniswap v4 but no v3 (MegaETH, Arc, Elysium) there is no v3 venue, and v4's reason is the one heard. A venue
  left out because its reads failed (`rate_limited`, `upstream_unavailable`, …) while the other venue's candidate goes
  out is named to the operator through `onV4Warning`, with the node's reason: `onRefusal` is not called while a
  candidate stands, and a `"best"` quote would have refused the whole request for that read. A retry may bring the row
  back; an app that wants to say so wires `onV4Warning` (on the provider in the app, or on its server). A request the
  caller aborted (the router's auction timeout) alerts nobody. A v3 router or quoter that no longer matches its pins
  (`factory()` / `WETH9()`) is alerted like a v4 mismatch: `onV4Warning(text, {chainId, reason: "vault_mismatch"})` on
  every pass while it lasts, v3 off on that chain, the v4 row untouched. A `"best"` quote refuses the request with
  `vault_mismatch` through `onRefusal` instead.
- **Pool provenance as before.** The v4 candidate keeps the `v4RankedPools` rule: where v3 has a route (or may: v3's
  reads unanswered), only the ranked pools compete — so there an app on the shipped pins never receives a v4 candidate
  it would refuse. A route through a grid, extra or newer-list pool is the v4 candidate only where v3 has no route; the
  shipped pins drop that candidate (its pool is not pinned), exactly as they drop the same route as a `"best"` quote,
  and nothing is executed. Where v3's reads failed and the only v4 routes go through such pools, the v4 candidate (a
  picked `"v4"` too) is refused with that read's reason, never as "no route".
- **`getQuote` and `routeId`.** Without a `routeId`, `getQuote` returns the `"best"` winner, now naming its route
  (`"v3"` or `"v4"`), as the swap2 contract asks of a provider with `getQuotes`. With `routeId: "v3"` it quotes v3 alone
  (no v4 read at all); with `"v4"` v4 alone (v3 is read only for the provenance rule) — a picked venue is quoted or
  refused with its own reason, never the other venue in its place. Any other `routeId` is refused (`policy_refused`)
  before any read. `buildDeposit` and `preflightDeposit` hold a routed quote to its venue (a `"v3"` quote calling the
  Universal Router or the SwapProxy, or a `"v4"` one calling SwapRouter02, is refused `vault_mismatch`); the v4
  preflight re-quote, tracking and activity work for both.
- **The pins bind `routeId` to the calldata.** `uniswapPins` / `uniswapPinsWith(…)` check a `"v3"` quote with the v3
  check alone (a call to the Universal Router or the SwapProxy refused) and a `"v4"` quote with the v4 check alone (a
  call to anything but the chain's pinned Universal Router 2.1.2 or SwapProxy refused); an unknown `routeId`, or one
  other than the request's, is refused; without a `routeId` the dispatch on `tx.to` is unchanged. A backend that
  swapped the labels gets neither candidate past the app.
- **Labels.** Label rows from `routeId` ("Uniswap v3" / "Uniswap v4"). `providerData.venue` is unchanged (`"v4"` on a
  v4 quote, absent on a v3 one). The router ranks each candidate as its own row with the other venues (`best` /
  `fastest` tags included) and executes the one picked with `using("uniswap", routeId)`; a quote refreshed after a long
  approval keeps its route.
- **Execute the row that was picked.** A live request without a `routeId` (`swap2(options)` with no `using`) is the
  `"best"` pass: one quote, ranked by output as without the option. It need not be the row the router tagged `best`,
  and it can refuse where a row was shown — for example where v3's highest-output route needs more gas than the chain
  allows: that pass refuses on v3's gas bound while the v4 row stands. An app in `"both"` mode executes the row the
  user (or its own policy) picked with `using("uniswap", routeId)`.
- **Rollout.** A server sets `venueRoutes: "both"` first (once v4 is on for its apps): `/quote` answers as before, the
  winner now naming its route, so apps without `multiQuotes` keep one Uniswap row. Then apps opt in with
  `uniswapRemoteProvider({ baseUrl, multiQuotes: true })`. A `multiQuotes` app against a server without `"both"` has its
  `/quotes` refused and shows no Uniswap row.

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
  falls back to a lower-output candidate. (A v4 route that cannot be built or simulated is not a
  refused quote: the next route is built and gated in turn — see "v4 on never costs a pair its v3
  route".)
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
- On the app's side `uniswapV4VerifyQuote(params, quote, {maxPriceImpactBps})` gates the same G: the
  larger of the quote's `priceImpactBps` and `valueLossBps` (a gated quote whose probe could not run
  carries spot alone); neither, or one that does not read as bps, refuses as `upstream_unavailable`.

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
  chain it cannot reach — and on a check that could not run: the v4 build probe is tried on each RPC
  until one returns revert data (none: a FAIL), and a quotable v4 chain without a V4Quoter canary
  pinned is a FAIL. On OP-stack chains every block opens with the L1-info deposit (gasLimit
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
