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

- **What it quotes.** With `v4: "native-in"`, a native-coin input into an ERC-20 is quoted on v3 and on v4 — at one
  pinned block when `maxPriceImpactBps` is set, else each read at `latest` (separate requests, which on a fast chain can
  land on different blocks) — and the larger output wins (`v4MinEdgeBps`, default 0, makes v4 beat v3 by more than
  that many bps). With `v4: "all"`, a catalog-token input into a token or into the native coin is ranked the same
  way. `maxPriceImpactBps` gates the winner, v3 or v4, with the same two measures.
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
- **A v4 build that fails never costs a pair its v3 route.** (A v4 read that went unanswered does: it refuses the
  quote, below.) A v4 build refused for a reason of the build falls back instead of refusing the quote: when the best
  v4 route's own pools fail its simulated swap (`V4TooLittleReceived`, `CurrencyNotSettled`…), its encoding or the
  module's own check refuses it, the next v4 candidate is built (at most 3); when what every v4 build shares fails —
  the endpoint cannot simulate the approval and the swap (a method or a state override it does not take, an answer in
  another shape), the approval or the token's pull into the SwapProxy fails —
  the quote goes straight to v3, and with no v3 route the best route's reason refuses it. A read that went unanswered
  is no such fact: it refuses the quote (above). The trade's own verdicts still refuse the quote outright (no route could pass them): the impact gate, a
  minimum that rounds to 0, the caller's floor, a wallet holding less than the input, a recipient that cannot take
  the native coin, and a recipient the chain's v4 pins name as a sink — a router sentinel, the zero address, the
  Universal Router, SwapProxy, PoolManager, PositionManager, V4Quoter, StateView or Permit2 — refused before any read
  for every venue once v4 is on (v3 output paid there is stranded too; the 0.5.0 pins refuse a v3 quote paying one on
  a chain with v4 pins). A candidate whose gas need is above the chain's bound (per-transaction cap or block gas limit) is
  ranked out, like the LIVE-1 ones, and counted in `providerData.v4Unexecutable`; it never displaces a route that can
  be mined, v3's or v4's, and v4 competes with v3's best route the chain can carry, never one ranked out for gas — one
  block read for both venues (LIVE-VR-3, "Gas limit and RPC errors" below). Live on Monad
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
  SwapProxy is not). The research rates Celo, Linea and World Chain as adding nothing over v3 today, and finds no
  core-pair depth on MegaETH, where v4 is the only Uniswap venue this module quotes (no v3 is pinned there); their
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
- **Gas.** A v4 quote carries its bounded `gasLimit` (quoter gas + 150k for the router, + 140k for the SwapProxy and
  the token's pull), as information and for the gas bound below; the engine sends the account's own estimate instead
  (`ownGasEstimate`, which is on with v4 off too: "Gas limit and RPC errors" below — Monad charges the gas limit, not
  the gas used, and the v4 route there needs about 200k). The pins refuse a quoted limit above the
  chain's per-transaction cap (`KNOWN_TX_GAS_CAP`, the provider's own table: 2²⁴ on Ethereum, OP, BNB, Unichain, World
  Chain, Base, Ink, Linea and Arc, 2²⁵ on Polygon, 30M on Monad).
- **`providerData`** of a v4 quote: `venue: "v4"`, `route` (e.g. "v4 via USDC 0.05%/10 → 0.005%/1"), `poolFee`, `router`,
  `currencyIn` (`address(0)` for the native coin), `currencyOut`, `amountIn`, `minOut`, `poolKeys` (JSON), `path`,
  `priceImpactBps` (`valueLossBps` when gated), `sender`, for a token input `simulated`, and `v4Unexecutable` (the count
  of candidates ranked out for gas, when any — on a v3 quote too, with v4 on). It is counted against the quote's block
  read when the quote's own ranking went by that read — it took the read (at a gas step, or to tell whether a route
  stands) or ranked a route out by it — and else against the caps alone. A quote whose route has no gas figure and
  that ranked nothing out never goes by the read, so its count never turns on whether the read has landed by the time
  it is built, nor, with `venueRoutes: "both"`, on whether the v3 row's gas step took the read first. A v3 quote has no
  `venue`, as before.
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
  at block 125,409,523 via MON → USDC (0.05%/10) → AUSD (0.005%/1), G = 22 bps, and passes `maxPriceImpactBps: 500`.
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
  alone returns from the same chain state (v4 off for v3, no v3 deployment for v4; with `maxPriceImpactBps` the pass
  reads at one pinned block, else each read at `latest`) — checked live at one pinned block on Monad, Robinhood Chain,
  Base and Unichain. Where v3 has a route, the v4 candidate is the best route over ranked pools, so it can differ from
  a v4-alone quote through a grid, extra or newer-list pool, or be missing where that is v4's only route. The v3
  candidate is v3's best route the chain can carry, picked as in a `"best"` pass (LIVE-VR-3, "Gas limit and RPC
  errors" below): a v3 route whose need is above the chain's gas cap is ranked out, so the v3 row is the lower-output
  route that can be mined, and it is refused (`insufficient_liquidity`) only where no v3 route fits; a picked
  `routeId: "v3"` quotes the same route. v4 ranks such routes out too (`v4Unexecutable`).
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
  and it can refuse where a row was shown — for example where the winner's pools fail `maxPriceImpactBps`: that pass
  refuses on the winner's loss (a refused quote never falls back) while the other venue's row, gated on its own,
  stands. An app in `"both"` mode executes the row the user (or its own policy) picked with `using("uniswap", routeId)`.
- **Rollout.** A server sets `venueRoutes: "both"` first (once v4 is on for its apps): `/quote` answers as before, the
  winner now naming its route, so apps without `multiQuotes` keep one Uniswap row. Then apps opt in with
  `uniswapRemoteProvider({ baseUrl, multiQuotes: true })`. A `multiQuotes` app against a server without `"both"` gets no
  Uniswap quote at all: its `/quotes` is refused (no row), and the `/quote` answer of a live request
  names no `routeId`, which the stub and the router refuse (`swap2(options)` and `using("uniswap")`
  lose Uniswap too). So the server goes first.

## Price impact: information, or a refusal you opt into

A quote carries `providerData.priceImpactBps` when the probe could be measured: the best route's
full-size rate against a 1/1000 probe on the same route (pool fees cancel). It is left out when the
input is under 1,000 raw units, or the probe reverted, failed, came back empty, paid 0 or did not
decode — not a 0, not a broken quote. By default it is information only — nothing is refused for
impact, so a wallet can warn and let the user decide.

`maxPriceImpactBps` (an integer 1..10000, unset by default) turns it into a refusal, for an app that
never wants to offer such a route (a web swap page might set 500):

```ts
uniswapProvider({ rpcUrls, maxPriceImpactBps: 500 })
```

- Every candidate is ranked as always (a route over the chain's gas cap never displaces one under
  it, see below); only the best route the chain can carry is gated, and a refused quote never falls
  back to a lower-output candidate. (A v4 route that cannot be built or simulated is not a refused
  quote: the next route is built and gated in turn — see "A v4 build that fails never costs a pair its v3 route".)
- All reads of the quote are pinned to one block, with transient RPC errors retried.
- The measure is the larger of the probe and the spot value loss against the pools' `slot0()` mid
  prices, fees included (`providerData.valueLossBps`), rounded down to a whole bp; the pools' floor
  rounding counts as loss (it is value the recipient does not get). A probe too small to run (under
  1,000 raw units), reverted, empty or unanswered after the retries falls back to spot.
- The pool fees count toward the limit: a limit at or under a route's fee (100 on a 1% pool, 60 on
  two 0.3% pools) refuses that route however deep its pools are. Set the limit well above the fee
  tiers you expect (500 refuses no route on fees alone). The same holds for a v4 route, its pools'
  swap fees (the LP fee, and a protocol fee where the PoolManager takes one) counted.
- Spot must be measured: the probe alone is blind to a pool parked past an empty range. When the
  pool lookups or `slot0()` reads go unanswered after the retries, or come back reverted, zero or in
  another shape, the quote is refused as `rate_limited` / `upstream_unavailable` ("could not measure
  the price impact … try again"), or as `insufficient_liquidity` when the probe alone already reaches
  the limit. A quote never passes with part of the check skipped.
- At or above the limit: `insufficient_liquidity`, "loses 99.8% of the value to price impact — its
  pools are too thin for this amount (limit 5%; best route via USDC 0.3% → 0.01%)" when the price
  impact alone (the probe, or the spot loss net of the pools' fees) reaches the limit; when only the
  fees bring it there, "loses 1.0% of the value to price impact and pool fees — the route's fees (1%)
  bring it to the limit; its price impact alone is under it (limit 1%; best route direct 1%)". Both
  start "loses X% of the value to price impact".
- `preflightDeposit` does not apply it: the signed minimum governs there.
- On the app's side, for a v4 quote only, `uniswapV4VerifyQuote(params, quote, {maxPriceImpactBps,
  pools: UNISWAP_V4_POOL_KEYS, extraPools})` gates the same G: the larger of the quote's
  `priceImpactBps` and `valueLossBps` (a gated quote whose probe could not run carries spot alone);
  neither, or one that does not read as bps, refuses as `upstream_unavailable`. The pool list is
  required (without `pools` every v4 quote is refused: "no pinned Uniswap v4 pool list"; `extraPools`
  are the `v4ExtraPools` the app pins). The shipped pins (`uniswapPins`, `uniswapPinsWith`,
  `uniswapRemoteProvider`) apply no impact gate, and there is no app-side gate for a v3 quote.

Unset, impact is never a refusal, and a healthy RPC sees 0.4.11's requests, sent as 0.4.11 sent them
(every batch at once, no queue shared by concurrent quotes), plus one `eth_getBlockByNumber` per chain
every 10 minutes (`tests/unset-byte-identical.test.ts`). Three things are always on, with `v4` off
too, and do change outcomes against 0.4.11: the gas bound and the RPC error handling below, and
`ownGasEstimate` (below), with which the engine sends each Uniswap call with the account's own
estimate instead of the quoted gasLimit. Activity also recognizes v4 swaps whatever `v4` says
("Activity").

## Gas limit and RPC errors

- **Gas (always on).** The swap's need is its bare need (quoter gas + 120k router overhead +
  unwrap/refund) plus 5%: EIP-150 forwards 63/64 of the gas into each call, and the pool's swap runs
  two calls deep (live, swaps ran in 2.1% to 3.5% over the bare need). A route whose need is above
  the chain's cap can never complete: it is ranked out before the best route is picked, so a
  lower-output route the chain can carry is quoted instead, and only when no candidate fits is the
  best by output refused as `insufficient_liquidity`; a padded limit above the cap is clamped to it,
  never below the need. Monad charges the whole limit, so it is never lowered below
  the need. The cap is `min(per-transaction cap, block gas limit − the block's own reserve)`:

  | Chains | Per-transaction cap |
  |---|---|
  | Ethereum, OP Mainnet, BNB Chain, Unichain, World Chain, Base, Ink, Linea, Arc | 16,777,216 (2²⁴, EIP-7825) |
  | Polygon | 33,554,432 (2²⁵) |
  | Monad | 30,000,000 |
  | the others | none known: the block gas limit |

  The 2²⁴ and 2²⁵ caps were read live on 2026-11-26: `eth_estimateGas` of an endless loop names the
  most gas a transaction may have, well below those chains' blocks (30M–2B). Monad's node does not
  name its allowance: its 30M is the documented limit, not one read live. `pnpm verify:live`
  (`scripts/verify-live.mjs`, read-only) checks every chain against the tables again — the
  per-transaction caps, the block reserves, the known block limits and Nitro's execution cap below —
  and fails on a chain it cannot reach, and on a check that could not run: the v4 build probe is
  tried on each RPC until one returns revert data (none: a FAIL), and a quotable v4 chain without a
  V4Quoter canary pinned is a FAIL. On OP-stack chains every block opens with the L1-info deposit (gasLimit
  1,000,000), so a transaction whose limit is the whole block is never included: there the block's
  limit counts less 1,000,000 (it binds on Celo, a 30M block, and X Layer, 210M); MegaETH's deposit is
  100,000,000. Until their own block has been read, Celo and X Layer are taken to have those blocks.
  Arbitrum One and Robinhood Chain (Nitro) report a 2⁵⁰ block gas limit, but execute at most 32M gas
  per transaction (`ArbGasInfo.getMaxTxGasLimit()`): a need above 32M is refused, and the limit is
  never clamped to 32M (it also pays the L1 gas). zkSync Era also reports 2⁵⁰; its per-transaction
  limit is not known, so only that header applies there.
  The block gas limit is read on its own (`eth_getBlockByNumber`), once per chain, and kept for 10
  minutes (1 minute after a failed read). It is optional: a node that does not serve it, or answers
  with an error, leaves only the known caps and never fails a quote. A quote waits for the first read
  at most 1.5 s after it began, and never past the caller's abort; then it goes by the known caps
  alone, and the read fills the cache when it lands. Once a read is in, a quote never waits for the
  next: while a re-read is pending or has failed, the last answer stands, for up to an hour after it
  was read.
  One block read goes for the whole quote: the route picked and the route bounded are judged by the
  same one. A best route by output that the caps above refuse whatever the node answers (or the
  block read already in) is ranked out before it is measured, and the first route under it that
  fits goes on. Any other best route goes on as before — the same requests at the same moments, its
  block read taken at its gas step with the wait above — and when that step refuses it, the next
  route the same read lets through is measured and quoted instead (more requests only where the
  quote was refused before). A refusal before the gas step (the impact gate, the minimum, the
  floor) stands at once when the best route fits the block gas limit in hand; when it does not, the
  quote takes its block read first (waiting only while a chain's first read is out). A quote that
  ranks out its best route while a chain's first read is out waits for it, at most 1.5 s, before it
  measures the next.
  With v4 on, the same one read goes for both venues. v3's and v4's candidates are taken in the
  order the quote ranks them — a v4 route ahead of a v3 route only when it pays more by more than
  `v4MinEdgeBps` — and each by the rules above: a route the read refuses is ranked out (a v4 one is
  counted in `v4Unexecutable`, never "set aside"), so v4 is compared with v3's best route the chain
  can carry, and a v4 route that cannot be mined never displaces one that can. Nothing waits for the
  read before a v4 route is measured unless what is already known (the caps, or the read once in)
  rules it out and another route could stand in: its probe goes out with the quote, its gas step
  takes the read, and a v4 refusal that needs no gas figure (the impact gate, the minimum, the
  floor) comes at once when the route fits the read in hand. A `venueRoutes: "both"` pass bounds
  its v3 row and its v4 row by the same read, and each row is the route its venue alone would
  return.
- **`ownGasEstimate` (always on, `v4` off too).** The provider — and `uniswapRemoteProvider`, an app's
  stub for it — declares `ownGasEstimate`: the engine sends every Uniswap call, v3's and v4's, with the
  account's own estimate of that exact call, dry-run from the account right before broadcast — never
  the quoted gasLimit, which stays on the quote as information and for the gas bound. A dry run that
  reverts refuses the swap (`simulation_failed`), and one the RPC does not answer is asked once more,
  then refused (`upstream_unavailable`), where 0.4.11 broadcast with the quoted limit. Monad charges
  the whole limit, not the gas used: a v3 quote there carries 16.3M for 62,000 MON. (A bare
  `remoteProvider({...uniswapPins})` stub has no `ownGasEstimate`: it sends the backend's limit.)
- **RPC errors.** A per-item JSON-RPC error that is a revert (code 3; "execution reverted" and other
  EVM errors, out of gas included; revert data whose message names no rate limit or node fault)
  means no candidate, as before. A rate limit (`-32005`, `-32007`, `429`, or its text), a node error
  or a call without an answer (left out, sent with no `result`, an `eth_call` or `eth_blockNumber`
  answering `null`, an error the node sent without an id, a candidate quote in a shape QuoterV2
  never answers — a number, bytes that do not decode, and with `maxPriceImpactBps` an empty `0x`) is
  retried, then refused as `rate_limited` / `upstream_unavailable`. It is never read as "no pool"
  (before 0.5.0, a rate-limited best pool silently lost to a worse route). The retries wait
  300–600 ms, then 1–1.5 s, at random. Batches carry at most 10 calls and go out at once, as in
  0.4.11; each gets 12 s per endpoint, also when the caller passes its own signal. URLs are taken out
  of node and transport error text, and so is every spelling of the configured endpoints — one given
  without a scheme too, which fetch echoes as given.
- **`rpcCallsPerSecond` (opt-in, an integer ≥ 13).** A server whose keyed endpoint serves a known
  good-item rate (QuickNode answered 50 calls a second on Monad and `-32007` the rest) sets it: at
  most that many calls go to one endpoint in any second, across every quote of the provider, counted
  at the moment each batch went (a batch whose timer fired late keeps the next one waiting), in
  batches of at most 10. A batch waits for its turn: the quote that began first goes first (its later
  reads before newer quotes' first ones, so a burst serves the quotes it can), then first come first
  served. One that would wait more than 4 s, or go later than 5 s after its quote began, goes to the
  next endpoint instead, or with none left is refused as `rate_limited`: nothing of a quote is sent
  later than 5 s after it began. A batch sent still has up to 12 s per endpoint to answer, so a quote
  settles within the router's 8 s only when the endpoint answers its last pass within about 3 s; and
  the v3 and v4 deployment checks, which quotes share, wait at most 4 s a batch rather than by the
  quote's 5 s. 13 is the least that carries the largest quote (51 calls in five passes
  one after another) on an idle endpoint answering within 0.5 s; a lower value is refused when the
  provider is built. With `v4` on, a quote's v4 reads (discovery, quoter aggregates, probe, the
  token-input check) go by the same turns and bound, and the floor is 34: the largest v4 quote (a
  gated token input with the sender known on an RPC without `eth_simulateV1`, `venueRoutes:
  "both"`, with up to four candidates past the chain's per-transaction cap, each aggregate holding
  one halved down to the call and the candidate read again at the cap) is up to 127 calls in sixteen
  passes, carried by 34 (three above the least, 31) on an idle endpoint answering within 250 ms. Candidates past the cap in more
  aggregates, or a quote that builds the next v4 candidate after its best one is refused, need more.
  Sixteen passes alone take the 5 s on an endpoint slower than ~310 ms, so a slow endpoint needs a
  higher rate (47 at 300 ms), and past that no rate carries such a quote under the limit. Unset (the
  default), nothing is limited.

## Quoting at one block (`blockNumber`)

`QuoteParams.blockNumber` (0.6.0; a decimal block of the source chain, read by the app once per comparison
round): every price read of the quote goes to that block, and the quote names it (`Quote.blockNumber`). The
provider declares `honorsBlockNumber: true`.

- v3: QuoterV2 for every candidate route and the 1/1000 probe (`priceImpactBps`); with `maxPriceImpactBps`, the
  probe, `getPool` and each pool's `slot0()` too. The gate reads this block instead of the one it pinned itself
  (no `eth_blockNumber`).
- v4: the pool discovery (Multicall3 over the StateView), the V4Quoter aggregates and their halving, a candidate
  read again at the chain's gas cap, and the probe.
- The block gas limit the routes are bounded by: `eth_getBlockByNumber` of that block, kept per block.
- With `venueRoutes: "both"`, both candidates come from that one block.

At "latest" whatever `blockNumber` says: the deployment checks (`factory()`, `WETH9()`, `poolManager()`, the
router's and the SwapProxy's code hashes), the token-input simulation (`eth_simulateV1` of approve + swap, and its
fallbacks), `preflightDeposit` (the re-quote and the dry run right before signing) and the engine's own gas estimate
(`ownGasEstimate`). The impact gate, the gas bound, the module's own v4 check and the pins apply unchanged.

A node that does not have the block ("header not found", "block not found", Monad's "Block requested not found", a
null result, X Layer's and Celo's HTTP 400 "block is out of range"), or no longer keeps its state ("missing trie
node", "historical state … is not available", publicnode's HTTP 403 for archive state), is retried as any unanswered
call (each retry starts at the next endpoint) and then refused as `stale_node`, the block named: "uniswap: no RPC on
chain 8453 served block 63110963 (-32001 block not found: 0x3c2ff33) — its node does not have that block yet, or no
longer keeps its state; nothing is read at "latest" instead". Linea's public RPC never answers a call at a block it
does not have: that ends as `upstream_unavailable` when the endpoint times out.

Every chain of the module takes a block number on its public and keyed RPCs, except HyperEVM: its RPCs answer an
`eth_call` at any block number from their head (one 100,000 blocks ahead too, 2026-11-28). It is in
`UNISWAP_LATEST_ONLY_CHAINS` (`[999]`): there a request's `blockNumber` is not honoured, the quote is read as without it
and names no block. Uniswap does not quote HyperEVM today (v4 `quotable: false`, no v3). `verify:live` checks every
endpoint of every chain: a call at head − 2 must answer that block's own number (NUMBER, or `ArbSys.arbBlockNumber()` on
Nitro chains, whose NUMBER is the parent chain's) and one at head + 100,000 must be refused.

Pass it in the comparison round only (latest, or latest − 1 on fast chains whose nodes trail), not on the execution
re-quote. A block past a non-archive node's pruning is refused the same way. Without `blockNumber` every request is
0.5.0's, byte for byte (`tests/block-number.test.ts` against `fixtures/unpinned-0.5.0.json`). Behind a backend, give
`uniswapRemoteProvider({…, honorsBlockNumber: true})` once the backend runs 0.6.0; the request's block reaches it either
way, and its quote names the block only when it priced there.

## Activity

`describeActivity(tx, ctx)` recognizes a call into the chain's pinned Universal Router 2.1.2 —
`execute(bytes,bytes[],uint256)` `0x3593564c` whose commands are exactly `V4_SWAP` (`0x10`), the command shape this
module builds — as a `swap` with subtitle `Uniswap v4 · <chain>`, and a call into the chain's pinned SwapProxy —
`execute(address,address,uint256,bytes,bytes[],uint256)` `0x2894adf9` whose `router` is the pinned Universal Router and
whose commands are exactly `V4_SWAP` — the same; every other router or SwapProxy call (a plan with more commands, the
no-deadline entry point, an Across deposit, a SwapProxy forwarding elsewhere) stays unclaimed. The `V4_SWAP` actions are
not opened: any such call is claimed whatever its actions do, and its title comes from the owner's net transfers, as
for a SwapRouter02 call on v3. It is history, never a check before signing (that is `uniswapVerifyQuote`). Fixtures: public Unichain
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
