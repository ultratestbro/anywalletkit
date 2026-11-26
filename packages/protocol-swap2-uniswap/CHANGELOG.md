# @anywalletkit/protocol-swap2-uniswap

## 0.5.0

### Minor Changes

- 67c8685: Uniswap v4, opt-in: the input is also quoted on the chain's pinned hookless v4 pools and executed through the pinned Universal Router 2.1.2 — directly for a native-coin input, through Uniswap's SwapProxy for a token input; v3 and v4 are ranked together by output. Off by default (`v4: "off"`): every quote is then the v3 quote this module returned before.
  
  - **`v4: "off" | "native-in" | "all"`** (default `"off"`). With `"native-in"`, a native input into an ERC-20 is quoted on v3 and on v4 (at one pinned block when `maxPriceImpactBps` is set, else each read at `latest`, as separate requests), and the best output wins (`v4MinEdgeBps`, default 0: v4 must beat v3 by more than that many bps). With `"all"`, a catalog-token input into a token or into the native coin is ranked the same way. The impact gate of `maxPriceImpactBps` applies to the winner. Every v4 swap carries the same `V4_SWAP([SWAP_EXACT_IN(_SINGLE), SETTLE, TAKE])` input: the exact input is settled (a partial fill reverts `CurrencyNotSettled` instead of leaving input in the router) and the whole output taken to the recipient (`TAKE(address(0), …)` for a native output, paid by the PoolManager). A native input is `UR.execute(0x10, [V4_SWAP], deadline)` with `value = amountIn` and no approval; a token input is `SwapProxy.execute(pinned UR, token, amountIn, 0x10, [V4_SWAP], deadline)` with `value = 0` and `approvalAddress` = the chain's pinned SwapProxy (the engine's exact approve → call → revoke; no core change). Every build is checked by the module's own strict verifier before it is returned.
  - **Token input is simulated before any approval.** With the sender known (an execution quote), the provider reads the sender's balance and allowance to the SwapProxy and simulates the approval and the exact swap together before returning the quote: `eth_simulateV1` of `[approve(SwapProxy, amountIn), swap]`; where the RPC does not serve it (Monad), an `eth_call` of the exact swap from the bare account with the token's allowance slot set by `stateDiff` (found with `eth_createAccessList`, verified by reading the allowance back); with no slot that verifies, a 61-byte executor installed as the account's code runs approve → swap through Multicall3. A revert is decoded and mapped; a balance under the input, an unanswered read or nothing simulable refuses — never a silent skip. A read of the check that no endpoint answered after the retries (balance, allowance, access list, slot read-back, the swap's or the executor's `eth_call`) refuses the whole quote with the node's reason (`rate_limited` / `upstream_unavailable`), never the v3 quote in its place: decision 5 (on Monad one `-32007` on the allowance read had returned v3's 1.13 AUSD for 700 USDC, v4 paying 700.08). `providerData.simulated` says how. Live on 2026-11-26, the approve + swap from a funded holder paid exactly the quote on Monad 700 USDC → AUSD / → MON and Base 1,000 USDC → ETH, with the SwapProxy allowance back to 0 and the router's and the SwapProxy's balances unchanged.
  - **Pins and checks.** `UNISWAP_V4` pins 19 chains (PoolManager, V4Quoter, StateView, PositionManager, Universal Router `2.1.2` with its per-chain codehash, SwapProxy and its codehash, Permit2, wrapped native), each verified on chain on 2026-11-25; Soneium, Tempo and Zora are left out (not in the catalog). HyperEVM is pinned `quotable: false` (no live pool); on Arc and Celo the native coin is an ERC-20, so native input and output are refused there. Before the first v4 quote on a chain the provider reads `poolManager()` of the router, the quoter and the StateView, the router's codehash and, with `"all"`, the SwapProxy's: a router mismatch turns v4 off on that chain, a SwapProxy mismatch token input only, never v3. On Monad the v4 reads name 30M gas: its RPCs give an `eth_call` 8.1M by default, which starved a two-hop quote inside a Multicall3 aggregate and refused the whole quote.
  - **Pools.** Hookless only, with an empty hook allowlist; LP fee ≤ `v4MaxFeePips` (default 100,000 = 10%; it can be lowered, not raised). The candidates come from a generated, pinned per-chain list (`./v4pools`, 1,052 live pools on the 18 quotable catalog v4 chains — every pinned chain but HyperEVM; on Arc and Celo token ↔ token pools only — built by `scripts/build-v4-pools.mjs` from the PoolManagers' `Initialize` logs and gated on chain at one block), read in one Multicall3 `aggregate3` on the pinned StateView, plus the integrator's `v4ExtraPools` (hookless, PoolId recomputed; a bad key throws when the provider is made), plus a union grid of 33 fee/tick-spacing keys for a token the list does not know. A chain is quoted on v4 only with a pool list (shipped, or `v4ExtraPools`). A failed discovery or quote read — an RPC error, a sub-call that fails, a listed pool reading as uninitialized, a quoter call without revert data — refuses the quote (`rate_limited` / `upstream_unavailable`); it never quotes from fewer pools. One exception, a fact rather than a failed read: a quoter call that comes back without revert data even alone in its aggregate is read once more, straight to the V4Quoter with exactly the chain's per-transaction gas bound named (where the module knows it: `KNOWN_TX_GAS_CAP`, else the 32M execution cap of Arbitrum and Robinhood Chain, `KNOWN_EXECUTION_GAS_CAP`), and one that is still empty there needs more gas than any transaction on the chain may have — it is ranked out and counted (`providerData.v4Unexecutable`), never the whole quote refused. On a chain whose cap the module does not know (Avalanche, Celo, X Layer, MegaETH, Elysium) such a call still refuses the quote. On Monad (live, 2026-11-26) a MON/AUSD candidate needing 61.3M quoter gas had made 2,000 AUSD → MON and 20,000 USDC → AUSD unquotable with v4 on (v3 included); now they pay 182,815.6 MON and 20,002.93 AUSD on v4 (v3 alone: 78.65 MON and 1.13 AUSD). A re-read the node does not answer, or answers under a gas cap of its own, still refuses.
  - **`uniswapPins`** now lists the Universal Router 2.1.2 as a call target (next to SwapRouter02) on every chain where v4 quotes a native input, and the chain's SwapProxy as a call target and a spender where it quotes a token input; the Universal Router, Permit2 and the PoolManager are never spenders. `uniswapVerifyQuote` dispatches on `tx.to`: a router or SwapProxy call is checked by `uniswapV4VerifyQuote` (UNISWAP-V4-RESEARCH §6.5: selector, strict decode and canonical re-encode in the pinned 2.1.x layout, commands exactly `0x10`, actions exactly swap / SETTLE / TAKE, ≤ 2 hookless pools from the shipped list, exact SETTLE, TAKE to the recipient, `value == amountIn` or 0, deadline, gas cap; for the SwapProxy S1–S14: its pinned address, `router` = the pinned UR, `token` = the request's catalog token, `amount` = the input = the approval, `value` 0); every other call by the v3 check, now also exported as `uniswapV3VerifyQuote`. `reasonOf` classifies the v4 texts too. With `maxPriceImpactBps`, `uniswapV4VerifyQuote` gates on G = max(`priceImpactBps`, `valueLossBps`) over the measures the quote carries (§7.2) and refuses one that carries neither. The pool-provenance check caches PoolIds only for a frozen list of frozen keys (the shipped lists, the pins' own copies); a list the caller can change is read anew on every call. The row-17 gas check uses the provider's own `KNOWN_TX_GAS_CAP` (2²⁴ on Ethereum, OP, BNB, Unichain, World Chain, Base, Ink, Linea and Arc, 2²⁵ on Polygon, 30M on Monad); the verifier's `maxFeePips` is held to 1..100,000 like `v4MaxFeePips` (the 10% cap can be lowered, never raised). **`uniswapPinsWith({v4ExtraPools, clockSkewSeconds})`** builds the same pins with the integrator's own v4 pools (the server's `v4ExtraPools`; their chains get the router / SwapProxy as call targets) and more clock skew on a v4 deadline; `uniswapPins` is `uniswapPinsWith()`. On a chain with v4 pins these pins also refuse a v3 quote paying one of the v4 sinks above (`recipient_mismatch`); `uniswapV3VerifyQuote` is unchanged. `UNISWAP_V3`, `UNISWAP_V4` and `UNISWAP_V4_POOLS` are frozen through their rows (each pool list all the way down): no code in the process can repoint a pinned router or SwapProxy the pins read at call time.
  - **Pool provenance across the corridor: `v4RankedPools: "listed" | "extra" | "all"`** (default `"listed"`). An app's pins accept a v4 pool only from the shipped list or the `v4ExtraPools` it pins itself; a pool the server's unlisted-token grid found is neither (and is found per request). So by default the server ranks only shipped-list routes against v3, and returns a route through a grid or an extra pool only when v3 has no route for the pair — an app never loses the v3 quote it had. `"extra"` ranks the server's `v4ExtraPools` too (apps pin the same pools with `uniswapPinsWith` — add a pool to the apps first, then to the server); `"all"` ranks everything (a provider running in the app).
  - **List rebuilds never cost an older app its v3 quote: `v4RankedListBlock`.** The lists are rebuilt and released when the watch reports a new live pool, so a server can run a newer list than its apps. `scripts/build-v4-pools.mjs` now reads the previous list back: lists only grow (a pool once listed stays listed, so an older server's routes stay acceptable to newer apps), and every pool a rebuild adds carries `since`, its build block (a chain's first list in a later release: all of them). By default a server ranks against v3 only the pools of the chain's first shipped list (the 0.5.0 lists carry no `since`); a pool with `since` ranks like a grid pool — returned only when v3 has no route. Once every app it serves runs a release whose list for the chain was built at block B or later (`UNISWAP_V4_POOLS[chain].block`), the server sets `v4RankedListBlock: {[chain]: B}`. Tested through `createSwap2Handler` + `remoteProvider` with a server list ⊃ the app's list: v3 stays served.
  - **A v4 build that fails never costs a pair its v3 route** (a v4 read that went unanswered does: it refuses the quote). A v4 build refused for a reason of the build falls back instead of refusing the quote: the best route's own pools failing its simulated swap, its encoding or the module's own check → the next v4 candidate (at most 3); what every v4 build shares failing (the endpoint cannot simulate the approval and the swap — a method or a state override it does not take, an answer in another shape —, the approval or the token's pull fails) → v3; with no v3 route, the best route's reason refuses. A read that went unanswered is no such fact: it refuses the quote (above). The trade's verdicts still refuse outright: the impact gate, a minimum rounding to 0, the caller's floor, a wallet short of the input, a recipient that cannot take the native coin, and — once v4 is on for the chain, before any read and for every venue — a recipient the chain's v4 pins name as a sink (a router sentinel, the zero address, the Universal Router, SwapProxy, PoolManager, PositionManager, V4Quoter, StateView, Permit2): output paid there is stranded, v3's too. A v4 candidate whose gas need is above the chain's bound is ranked out before ranking (counted in `v4Unexecutable`), so it never displaces a route that can be mined. Live on Monad (fault injection, 2026-11-26): 700 USDC → AUSD on an RPC without access lists or state overrides now quotes v3 (before: refused).
  - **`onV4Warning(text, {chainId, reason})`**, the operator's alert (§6.5 row 15, "refuse + alert"): called when the chain's v4 deployment does not match its pins (`vault_mismatch`, naming what — v4 or its token input is off on that chain, v3 untouched) and when a v4 build is set aside for a fallback; with `venueRoutes: "both"`, also when one venue's candidate is left out because its reads failed (the node's reason) while the other venue's goes out (never for a request the caller aborted), and when the chain's v3 router or quoter does not match its pins (`vault_mismatch`: v3 off on that chain for the pass, the v4 row untouched; a `"best"` quote refuses the request through `onRefusal` instead). Not the caller's `onRefusal`, which is first-wins and dropped when a quote stands. A throw or a rejected promise in it is ignored. Live on Monad: a flipped router code byte or a reverting `poolManager()` now alerts.
  - **`v4ExtraPools` is read by one parser** in the provider and in `uniswapPinsWith` (`checkedV4ExtraPools`, in `./v4`): a decimal chain id per key, each once; the provider no longer reads `"0x8f"` as chain 143 or drops `"abc"` silently while the app's pins throw.
  - **v4 deadline ≤ 600 s.** A v4 swap's deadline is `min(deadlineSeconds, 600)` ahead (v3 keeps the full `deadlineSeconds`): the bound the pins hold a v4 quote to, with 60 s of clock skew. A server at `deadlineSeconds: 1200` would otherwise have every app refuse its v4 quotes.
  - **Preflight** of a v4 quote re-quotes the route on the V4Quoter (a partial fill or an output under the signed minimum refuses it) and `eth_call`s the exact transaction from the quote's sender (`providerData.sender`, set from `QuoteParams.sender`; for a token input after the approval); a revert is decoded through `ExecutionFailed` / `WrappedError` / `UnexpectedRevertBytes` and mapped (`V4TooLittleReceived` → `price_check_failed`, `CurrencyNotSettled` / `NotEnoughLiquidity` → `insufficient_liquidity`, `NativeTransferFailed` → `recipient_mismatch`, an expired deadline → `quote_expired`, a token's `Error(string)` such as `TRANSFER_FROM_FAILED` named in a `simulation_failed`); no answer refuses. A node refusing the dry-run because the sender holds less than it sends (Monad's `-32003 Insufficient funds…`, reth's `OutOfFunds`, geth's `insufficient funds for transfer`) is that answer: `simulation_failed` naming the balance, at once, never "no RPC answered" after the retries.
  - **`ownGasEstimate: true`** (for v3 too, and with v4 off) on the provider and on the new **`uniswapRemoteProvider({baseUrl, …})`** — the app's stub for a backend: `remoteProvider` with the shipped pins (or `uniswapPinsWith` options), `ownGasEstimate` and `describeActivity`. The engine dry-runs each Uniswap call from the account right before broadcast and sends the account's own estimate, never the quoted limit. A bare `remoteProvider({...uniswapPins})` stub carries no `ownGasEstimate` (core stubs have none) and still sends the backend's limit — use the helper. Monad charges the gas limit, not the gas used, and a v3 quote there carried a 16.3M limit for a swap the account estimates far lower. The quote still carries its bounded `gasLimit` (information, and the gas bound that refuses a swap no block could mine). Two gas facts read live by `verify:live` on 2026-11-26 join the tables: Arc's 2²⁴ per-transaction cap and MegaETH's 100M-gas L1-info deposit.
  - **Activity:** a call to the pinned Universal Router's `execute(bytes,bytes[],uint256)` whose commands are exactly `V4_SWAP`, and a call to the pinned SwapProxy's `execute` (`0x2894adf9`) forwarding to that router with exactly `V4_SWAP`, are "Uniswap v4 · <chain>" (recorded public Ethereum SwapProxy swaps); other router and SwapProxy calls stay unclaimed. This holds whatever `v4` says, and the `V4_SWAP` actions are not opened (the title comes from the owner's net transfers, as for a SwapRouter02 call).
  - **`providerData`** of a v4 quote: `venue: "v4"`, `route`, `poolFee`, `router`, `currencyIn`, `currencyOut`, `amountIn`, `minOut`, `poolKeys` (JSON), `path`, `priceImpactBps` (and `valueLossBps` when gated), `sender`, for a token input `simulated`, and `v4Unexecutable` when candidates were ranked out for gas. A v3 quote has no `venue`, as before; with v4 on it may carry `v4Unexecutable` too.
  - **Exports:** `UNISWAP_V4`, `UniswapV4Deployment`, `V4PoolKey`, `UR_COMMANDS`, `V4_ACTIONS`, `UNISWAP_UR_SELECTORS`, `UNISWAP_SWAP_PROXY_SELECTORS`, `poolIdOf`, `encodeV4Swap`, `uniswapV4VerifyQuote`, `uniswapV4ReasonOf`, `UniswapV4Mode`, `UniswapV4VerifyOptions`, `uniswapV3VerifyQuote`, `UNISWAP_V4_POOL_KEYS`, `uniswapPinsWith`, `UniswapPinsOptions`, `uniswapRemoteProvider`, `UniswapRemoteOptions`, `UniswapRemoteProvider`, `UniswapRouteId`; every building block in the new `./v4` subpath; the lists in `./v4pools`.
  - **`verify:live`** checks every chain of both tables: v3 linkage; v4 code, linkage and codehashes (the router's, the SwapProxy's and Permit2's — pinned per chain as `permit2Codehash`); a build probe (an unreachable `minHopPriceX36` in the 2.1.x layout must revert `V4TooLittleReceivedPerHopSingle`); a V4Quoter canary; the gas bounds; Monad, Unichain and Base corridors through the provider and the pins (native input, and token input through the SwapProxy: Monad 700 / 20,000 USDC → AUSD and 100 / 2,000 AUSD → MON — the large ones cross candidates past the 30M cap, which must be ranked out —, Base 1,000 USDC → ETH, and Base 1,000 USDC → USDT on v4 alone so the SwapProxy flow runs whichever venue pays more), and the Monad ones in remote mode through `uniswapRemoteProvider`. An unreachable chain fails the run, and a final `Reason:` line names every chain that is not ok (a FAIL line says "linkage drift", never "ok", when its own section found a problem); so does a check that could not run (the build probe is tried on each RPC until one returns revert data; a quotable chain without a canary pinned). **watch.json** watches the five v4 contracts' code on 19 chains, every PoolManager's `owner()` and `protocolFeeController()`, `UNISWAP_V4` against Uniswap's deployments.json, the universal-router / v4-periphery / v4-core releases and (`evm-initialize`, one source per shipped list) new hookless pools — a source's first run (or a re-pointed one) scans from the block its list was built at and reports what it finds against an empty reading, so a pool initialized between the build and the first watch run is not missed. Each source carries a positive control (`canary`: the known `Initialize` log of a listed pool): every run that scans asks the same logs endpoint for that block with the scan's own filter and fails when the log is missing, so an endpoint that answers `[]` for a range it does not index never moves the index past it (BNB Chain's public node did, 2026-11-26). The watch reads the JSON-RPC error a node sends with HTTP 400 / 413 (World Chain's, X Layer's and Ink's public RPCs refuse a wide `eth_getLogs` that way) and cuts the window to the limit the error names; X Layer, World Chain and Ink get the `maxCalls` their public endpoints need for a day, Arc's source paces its calls (`intervalMs: 1500`, a 429 waited out twice: its public endpoint, the one CI uses, answers HTTP 429 to the 4th `eth_getLogs` sent back to back), and the CI maps the QuickNode endpoints in a step before the watch runs (they had reached only the later steps).
  - **Uniswap v3 and v4 as two routes: `venueRoutes: "best" | "both"`** (default `"best"`: one quote per request, the winner, no `getQuotes`, no `routeId` — every request and answer as without the option). `"both"` (needs `v4` on; the provider throws with v4 off) adds `getQuotes`: up to two candidates from one ranking pass — `routeId: "v3"`, the best v3 route, and `routeId: "v4"`, the best v4 route — from the same reads as a `"best"` quote (at one pinned block with `maxPriceImpactBps`, else each at `latest`) plus the losing venue's own probe and checks, so never cheaper than one `"best"` quote (live, read-only, 2026-11-26, without `maxPriceImpactBps`: 1–4 JSON-RPC calls more, a ratio of 1.03–1.14, on Monad, Robinhood Chain, Base and Unichain; with it the losing venue's spot reads come on top, 5 more on the recorded Monad 62,000 MON pass). Each is built and checked as it would be had it won (the impact gate per venue, the minimum and floor, the gas bound, the strict v4 check, the token-input simulation, the v4 build fallback) and, within the `v4RankedPools` provenance rule, equals what that venue alone returns from the same chain state; one venue refusing or failing never drops the other, and with both refused the list is empty and `onRefusal` names both reasons (on a chain with v4 but no v3, v4's alone). A venue left out because its reads failed while the other's candidate goes out, or because its deployment does not match its pins (v3's too), is named through `onV4Warning`. The v3 candidate is v3's best route the chain can carry, picked as in a `"best"` pass: a v3 route whose gas need is above the chain's bound is ranked out (LIVE-VR-3, the impact-gate changes in this release), so the v3 row is the lower-output route that can be mined, refused only where no v3 route fits, and a picked `routeId: "v3"` quotes the same route. The v4 candidate keeps the `v4RankedPools` provenance rule: where v3 has a route, only ranked pools compete, so an app on the shipped pins never receives a v4 candidate it would refuse; a grid / extra / newer-list route is the v4 candidate only where v3 has none, and the shipped pins drop it, as they drop such a quote in `"best"` mode; where v3's reads failed, such a route is refused with that read's reason, never as "no route". `getQuote` without a `routeId` returns the `"best"` winner naming its route (a live request without a `routeId` is that pass: apps execute the row picked with `using("uniswap", routeId)`); with `"v3"` or `"v4"` that venue alone (with `"v3"` no v4 read at all), never the other in its place; any other `routeId` is refused (`policy_refused`). `buildDeposit` / `preflightDeposit` refuse a routed quote whose call is the other venue's. **`uniswapPins` / `uniswapPinsWith`** bind `routeId` to the calldata: `"v3"` gets the v3 check alone (a Universal Router or SwapProxy call refused), `"v4"` the v4 check alone (a call to anything but the pinned Universal Router or SwapProxy refused), an unknown `routeId` or one other than the request's is refused, no `routeId` dispatches on `tx.to` as before. **`uniswapRemoteProvider({multiQuotes: true})`** asks the backend's `/quotes` for both (a server running `venueRoutes: "both"`; off by default, for older backends). Rollout: the server first (`/quote` keeps one row for apps without `multiQuotes`), then the apps. Label rows from `routeId`; `providerData.venue` is unchanged. Tested through `createSwap2Handler` + `uniswapRemoteProvider` (two sealed candidates verified, execution quotes per `routeId`, a label-swapping backend refused) and `CrossChainRouter` / `RouterSwap2Protocol` (two Uniswap rows; `using("uniswap", "v4")` sends the Universal Router call).
  - **Rollout:** release; then apps bump their pins (a 0.4.x app's `uniswapPins` names SwapRouter02 only and drops a Universal Router or SwapProxy quote — and since a stub gets one quote per pair, that app would lose Uniswap on the pair); only then does a server set `v4: "native-in"`, later `"all"`. With `v4: "off"` the server keeps serving v3 to apps on old pins, and with `"native-in"` token input stays on v3 (tested through `createSwap2Handler` + `remoteProvider`).
  - **LIVE-VR-3 holds with v4 on.** v3's and v4's candidates are taken in the order a `"best"` quote ranks them (a v4 route ahead of a v3 one only when it pays more by more than `v4MinEdgeBps`) and judged by one set of gas bounds per quote — one block read for both venues, taken once with the wait the gas step always had: a route the bounds refuse is ranked out, so v4 is compared with v3's best route the chain can carry (it was compared with v3's best by output, ranked out or not: a v4 route paying more than v3's best minable route lost to one no transaction could carry, and v3's lower route was quoted). v4 no longer reads the block gas limit twice: it was waited for before any v4 route was built (up to 1.5 s for a first read, holding refusals that need no gas figure and the probe) and read again at the gas step, so a read landing in between set a route aside "for gas" that the ranking had let through (an `onV4Warning` alert, `setAside`), or ranked one out that the gas step would have let through. Now a v4 route goes on at once unless the caps rule it out and another route could stand in; its gas step takes the quote's bounds, and a route they refuse there is ranked out (counted in `v4Unexecutable`, not set aside) and the next route they let through goes on — a quote's `v4Unexecutable` counts by the block read when the quote's own ranking went by it (it took the read, or ranked a route out by it), else by the caps alone (a route with no gas figure never takes the read, so whether the read had landed no longer changes the count, nor, with `venueRoutes: "both"`, whether the v3 row's gas step took it first); a v4 refusal before the gas step (the impact gate, the minimum, the floor) stands at once when the route fits the read in hand. With `venueRoutes: "both"` the v3 and v4 rows go by the same bounds. Live (Arbitrum One, 2,000 ETH → ARB at block 527,809,703, read-only): with `v4: "native-in"` the `"best"` quote was refused for the direct 0.05% route's 50.6M-gas need and `"both"` showed the v4 row alone (855,378.69 ARB via USDC 0.3%/60 → 0.3%/60); now `"best"` quotes v3's 1,188,565.67 ARB via USDC 0.05% → 0.3% (as v4 off does), `"both"` shows that v3 row next to the v4 one, and a picked `routeId: "v3"` quotes the same route. With v4 off every quote, and every request, is this release's v3 path's — the impact-gate changes above, unchanged (checked against their source on the unset scenarios, random route tables with random block-read and probe delays, and concurrent quotes). Outside quoting, `ownGasEstimate` and the v4 activity recognition are on whatever `v4` says (above).
  - **The impact-gate changes' release-review fixes hold on the v4 paths too.** With `rpcCallsPerSecond` set, a quote's v4 reads (discovery, the V4Quoter aggregates and the gas bound's re-reads, the probe, the token-input check) go by its turns and its 5 s bound like its v3 reads — under load they had waited 4 s a batch past it (20 quotes at 45 calls a second: v4 reads still sent after 5 s); with `v4` on the floor is 34 (`MIN_CALLS_PER_SECOND_V4`: it carries the largest v4 quote on an idle endpoint answering within 250 ms, three above the least, 31: up to 127 calls in sixteen passes, with up to four V4Quoter candidates past the chain's per-transaction cap — each aggregate holding one halved down to the call, then read again at the cap; 22, counted without those, refused it from 150 ms, and 13 at once). `eth_simulateV1` answering `null` is no answer either (retried; it had set the v4 route aside for v3's at once). The impact gate's refusal names a v4 route's own fees when only they bring the loss to the limit, as on v3 (the recorded Monad 62,000 MON route at a limit of 22: its probe is 17 and its loss net of the 0.05% + 0.005% fees 16), a pool's protocol fee named too where one is taken ("0.05% + 0.1% protocol"); the v4 spot loss is the v3 measure over the route's pools, exact and rounded down (it had rounded the loss up by as much as 1 bp, and refused a deep pool under its limit). Every spelling of the configured endpoints is taken out of the node texts a v4 refusal carries (a reverted read, a node's gas cap, a wallet short of funds). `eth_getCode` answering `null` is no answer (retried, then `upstream_unavailable`; it had read as a v4 deployment mismatch), and a V4Quoter candidate answer in a shape the quoter never gives is retried before the quote is refused.
  - Monad 62,000 MON → AUSD (the cp0x case), recorded at block 125,409,523: v3 alone 1.130999 AUSD (impact 9981, refused at `maxPriceImpactBps: 500`); with `v4: "native-in"` 676.608109 AUSD via MON → USDC (0.05%/10) → AUSD (0.005%/1), G = max(probe 17, spot 22), which passes at 500. Live on 2026-11-26 the same route paid 667.45 AUSD (KyberSwap 669.19 at the time), and the built transaction's `eth_call` paid exactly the quote.

### Patch Changes

- 8466d0f: `maxPriceImpactBps` (opt-in): refuse a quote whose own price-impact measure (the larger of the 1/1000 probe and the spot value loss with the pool fees in it, at one block) is at or above the limit, as `insufficient_liquidity`; when the option is set and the spot measure cannot be read, refuse as `upstream_unavailable` (or `rate_limited`). Unset keeps today's behaviour (impact is information). A route whose gas need exceeds the chain's per-transaction cap, block gas limit or (Arbitrum Nitro) execution cap is never quoted (it could never complete): it is ranked out and the next route the chain can carry is quoted, refused only when none fits; a padded limit above the cap is clamped to it. Per-item RPC errors are no longer read as 'no pool'.
  
  - With `maxPriceImpactBps` set, only the best-ranked route is gated (a refused quote never falls back to a lower-output candidate), every read is pinned to one block with transient RPC errors retried, and a probe too small to run, reverted, empty or unanswered after the retries falls back to the spot measure. The spot measure itself must be read: pool lookups or `slot0()` reads unanswered after the retries, reverted, zero or in another shape refuse the quote (`rate_limited` / `upstream_unavailable`; `insufficient_liquidity` when the probe alone already reaches the limit) — the probe alone never passes a quote. The refusal text reads "loses 99.8% of the value to price impact — its pools are too thin for this amount (limit 5%; best route via USDC 0.3% → 0.01%)" when the price impact alone (the probe, or the spot loss net of the pool fees) reaches the limit; when only the fees bring it there — a limit at or under the route's fee refuses it however deep its pools are — "loses 1.0% of the value to price impact and pool fees — the route's fees (1%) bring it to the limit; its price impact alone is under it (limit 1%; best route direct 1%)". A passing quote adds `providerData.valueLossBps` (spot, fees included) next to the unchanged `priceImpactBps`. `preflightDeposit` does not apply it.
  - With it unset, impact is never a refusal, and a healthy RPC sees 0.4.11's requests, sent as 0.4.11 sent them (every batch at once; concurrent quotes share no queue), checked scenario by scenario against the 0.4.11 dist, plus one `eth_getBlockByNumber` request per chain every 10 minutes. The gas bound and the RPC error handling below are always on and can refuse or clamp where 0.4.11 quoted.
  - Gas: the need is the bare need (quoter gas + 120k + unwrap/refund) plus 5% for EIP-150's 63/64 call forwarding (live, swaps ran in 2.1–3.5% over the bare need). The per-transaction caps, read live on 2026-11-26 (`scripts/verify-live.mjs`: the `eth_estimateGas` allowance of an endless loop), are 16,777,216 (EIP-7825) on Ethereum, OP Mainnet, BNB Chain, Unichain, World Chain, Base, Ink and Linea and 33,554,432 on Polygon; Monad's 30M is its documented limit (its node does not name the allowance). On a chain without one, the block gas limit is the cap, less 1,000,000 on OP-stack chains (Celo, X Layer), whose every block opens with a 1M-gas L1-info deposit: a limit of the whole block is never included; until their own block has been read, Celo and X Layer are taken to have their 30M and 210M blocks. The block gas limit is read on its own, optional (a node that does not serve it never fails a quote), re-read every 10 minutes, and the first read is waited for at most 1.5 s after it began and never past the caller's abort (then the known caps alone); once one is in, a quote never waits for a re-read — the last answer stands while one is pending or failed, for up to an hour. Arbitrum One and Robinhood Chain execute at most 32M gas per transaction (`ArbGasInfo.getMaxTxGasLimit()`, read 2026-11-26, and checked by `scripts/verify-live.mjs`): a need above it is refused, the limit is never clamped to it.
  - A route whose gas need is above that bound is ranked out before the best route is picked, so it never hides a lower-output route the chain can mine (LIVE-VR-3: on Arbitrum, 2000 ETH → ARB direct 0.05% needs ~48M quoter gas, over Nitro's 32M, and the pair got no quote; now "via USDC 0.05% → 0.3%" is quoted at 21.5M). Each candidate's need counts its own pool count and the request's unwrap/refund legs; a candidate without a gas figure stays one. Price impact and `maxPriceImpactBps` are measured on the route returned. One block read goes for the whole quote, so the route picked and the route bounded are judged alike: a best by output that the known caps (or a block read already in) refuse whatever the node answers is ranked out before it is measured; any other best goes on as before, its block read taken at its gas step with the wait it always had, and when that step refuses it the next route the same read lets through is measured and quoted (more requests only where the quote was refused before). A refusal before the gas step (impact gate, minimum, floor) stands at once when the best fits the block gas limit in hand, else after the quote's block read. When no candidate fits, the best by output is refused exactly as before; when the best by output fits the bounds its gas step goes by, the quote, the refusals, the requests and their timing are unchanged. While a chain's first block read is out (at most 1.5 s), a quote whose best was ranked out waits for it before measuring the next route, and a refusal returned at once on the limit in hand may come for a best that read would rule out — as before.
  - RPC: a revert (code 3, "execution reverted", out of gas and other EVM errors, revert data whose message names no rate limit or node fault) is still "no candidate"; a per-item rate limit (`-32005`, `-32007`, `429`, or its text), node error or missing answer (an item left out, one with no `result`, an `eth_call` or `eth_blockNumber` answering `null`, an error sent without an id, a candidate quote in a shape QuoterV2 never answers — a number, bytes that do not decode, and with `maxPriceImpactBps` an empty `0x`), and a batch refused with a JSON-RPC error, are retried (after 300–600 ms, then 1–1.5 s) and then refused as `rate_limited` / `upstream_unavailable`. `error.data` is kept; URLs are taken out of node and transport error text, and so is every spelling of the configured endpoints (one given without a scheme too). Batches stay at 10 calls, each bounded at 12 s per endpoint (also under the caller's signal).
  - `rpcCallsPerSecond` (opt-in, unset by default; an integer ≥ 13, the least that carries the largest quote on an idle endpoint): at most that many calls to one endpoint in any second, across every quote of the provider, counted at the moment each batch went; batches carry at most 10 calls and wait for their turn — the quote that began first goes first, then first come first served — and one that would wait more than 4 s, or go later than 5 s after its quote began, goes to the next endpoint, or is refused as `rate_limited` — nothing of a quote is sent later than 5 s after it began, so it settles within the router's 8 s when the endpoint answers its last pass within about 3 s (live, 20 gated Monad quotes at once at 45 calls a second: 9–10 quoted, the rest refused within 5 s; before, 9 quoted and 11 ran to the 8 s abort). Unset, nothing is limited, as in 0.4.11.
  - Monad 62,000 MON → AUSD (the cp0x trigger case), recorded at block 125,409,523: unset, 1.130999 AUSD at impact 9981 as before; at `maxPriceImpactBps: 500`, refused "loses 99.8% …".

## 0.4.11

### Patch Changes

- Updated dependencies [6020956]
- Updated dependencies [ffe1564]
  - @anywalletkit/protocol-swap2-core@0.17.0

## 0.4.10

### Patch Changes

- Updated dependencies [ef9b9d7]
  - @anywalletkit/protocol-swap2-core@0.16.0

## 0.4.9

### Patch Changes

- Updated dependencies [90eebd0]
  - @anywalletkit/protocol-swap2-core@0.15.1

## 0.4.8

### Patch Changes

- Updated dependencies [a096145]
- Updated dependencies [eba96eb]
- Updated dependencies [0d51c25]
- Updated dependencies [fb01615]
  - @anywalletkit/protocol-swap2-core@0.15.0
  - @anywalletkit/core@0.9.0
  - @anywalletkit/swap2-assets@0.3.0

## 0.4.7

### Patch Changes

- Updated dependencies [3bf525f]
- Updated dependencies [b7cf66d]
  - @anywalletkit/protocol-swap2-core@0.14.0

## 0.4.6

### Patch Changes

- Updated dependencies [e495f43]
  - @anywalletkit/protocol-swap2-core@0.13.0
  - @anywalletkit/swap2-assets@0.3.0

## 0.4.5

### Patch Changes

- 28c1130: Refusal reasons. Every refusal keeps its text; `getQuote` passes the classification to `onRefusal` as its second
  argument, and the errors thrown by `preflightDeposit` and `buildDeposit` carry it (`refusalOf`). Flexible amounts,
  cross-chain requests, a chain without a deployment or RPC, an uncatalogued or non-address token, native in or out where
  the router wraps nothing, a wrap and the same token in and out `unsupported_pair`; a recipient that is not an EVM
  address `recipient_mismatch`; a router or quoter that no longer match the pinned deployment `vault_mismatch`; no pool
  route `no_route` (also a route that no longer quotes at preflight); every route running a pool dry (a partial fill, at
  quote or preflight) `insufficient_liquidity`; a minimum that rounds to 0 `amount_too_small`; the caller's floor and a
  preflight price under the minimum `price_check_failed`; a quote without a transaction `policy_refused`. When no RPC
  answers, the refusal takes the last endpoint's status (429 `rate_limited` with Retry-After, 401 / 403 `key_rejected`,
  5xx `upstream_unavailable` with `httpStatus`), else `upstream_unavailable` for a network failure, a timeout or an answer
  that is not JSON; a quoter answer that does not decode at preflight is `upstream_unavailable` too (its error kept).
  `uniswapPins` gains `reasonOf` for the texts `uniswapVerifyQuote` returns: an unpinned or cross-chain deployment, an
  uncatalogued token and native on Celo `unsupported_pair`; another call target `vault_mismatch`; a swap or unwrap paying
  another address `recipient_mismatch`; an input, minimum or price limit off the quote and an unwrap to the recipient of
  another amount than the minimum `price_check_failed`; value or
  approval off the input, another router call, extra legs, other tokens and paths `policy_refused`. A request that does
  not parse, the `defaultSlippageBps` option check, an invalid amount and the caller's own abort stay unclassified.
- Updated dependencies [fb6ca70]
  - @anywalletkit/protocol-swap2-core@0.12.0

## 0.4.4

### Patch Changes

- Updated dependencies [b1ac0e3]
  - @anywalletkit/protocol-swap2-core@0.11.0

## 0.4.3

### Patch Changes

- Updated dependencies [6d6e801]
- Updated dependencies [ff6582a]
  - @anywalletkit/swap2-assets@0.3.0
  - @anywalletkit/protocol-swap2-core@0.10.3

## 0.4.2

### Patch Changes

- 33974f3: A pool too shallow for the input no longer counts as a quote. QuoterV2 answers such an input with the partial fill the pool would make, stopping at the price bound, and that was taken as the best route: on Ink, where the WETH/USDC pools are dust, 0.01 ETH → USDC quoted 1 raw unit with a minimum of 0, and 10 USDC → ETH drained the pool's WETH for a fraction of the input. A route that leaves any of its pools at the price bound is now dropped. When every route does, the quote is refused with `pool liquidity runs out before the full amount (partial fill)`. Preflight re-checks this before broadcast. A quote whose minimum rounds to 0 at the chosen slippage is refused by name. USDT0 is now a two-hop token where the catalog lists it, so Ink quotes WETH → USDT0 → USDC at the market price. `uniswapVerifyQuote` now accepts a native-input swap that ends with `refundETH()`, which pays any ETH the pool did not take back to the sender in the same transaction, and still accepts quotes without it. The provider builds that leg only with the new `refundNativeInput: true` option (off by default), because apps verifying with an earlier `uniswapVerifyQuote` refuse it and would lose every native-input Uniswap route. Roll out in this order: ship the apps with pins from this release first, then turn `refundNativeInput` on in the server's provider.

## 0.4.1

### Patch Changes

- Updated dependencies [10e06dc]
  - @anywalletkit/swap2-assets@0.2.3
  - @anywalletkit/protocol-swap2-core@0.10.2

## 0.4.0

### Minor Changes

- 85b9daa: Unichain, Monad, Linea and X Layer now quote through Uniswap's active QuoterV2 (130 `0x385A5cf5F83e99f7BB2852b6A19C3538b9FA7658`, 143 `0x661E93cca42AfacB172121EF892830cA3b70F08d`, 59144 `0x42bE4D6527829FeFA1493e1fb9F3676d2425C3C1`, 196 `0xD1b797D92d87B688193A2B976eFc8D577D204343`) instead of the deprecated `Quoter`, which quoted the right amounts but always reported gas 0. The swap's gas limit was derived from that figure, so on these four chains it was 120,000 (160,000 with a native output) while a real swap uses about 170,000–275,000: the transaction passed simulation and then ran out of gas on chain. A quoter figure no real pool swap can cost now sets no gas limit at all, and the wallet estimates the exact call with headroom before broadcast. `UniswapDeployment.quoterWeth` is removed: every pinned quoter reports WETH9, and a `deployments` override whose quoter does not is refused like any other mismatched deployment.

### Patch Changes

- @anywalletkit/protocol-swap2-core@0.10.1
  - @anywalletkit/swap2-assets@0.2.2

## 0.3.2

### Patch Changes

- Updated dependencies [3b81a37]
- Updated dependencies [b16f9b1]
- Updated dependencies [0919427]
- Updated dependencies [ac56c9b]
- Updated dependencies [21f2b25]
- Updated dependencies [ccea432]
- Updated dependencies [d1e517a]
- Updated dependencies [57a68aa]
- Updated dependencies [5b3e194]
  - @anywalletkit/protocol-swap2-core@0.10.0
  - @anywalletkit/core@0.8.0
  - @anywalletkit/swap2-assets@0.2.2

## 0.3.1

### Patch Changes

- Updated dependencies [9e27fc6]
  - @anywalletkit/protocol-swap2-core@0.9.0

## 0.3.0

### Minor Changes

- 63c216e: `uniswapPins` now carry `verifyQuote: uniswapVerifyQuote`, so a remote Uniswap route is opened on the device (scan 2026-10-28, F1). The pins used to pin only SwapRouter02: a compromised backend could write the swap's recipient, a zero minimum, or `pull` + `sweepToken`, and the engine sent it. The verifier decodes the router call and requires one `multicall(deadline, legs)` on the chain's pinned SwapRouter02 whose legs are exactly one `exactInputSingle` or `exactInput` (one or two pools), then `unwrapWETH9` for a native output; the source token (WETH for a native input, paid as exactly the input in `value`) sold for the destination token; `amountIn` the input and `amountOutMinimum` the quote's minimum; the recipient paid, or the output kept in the router and unwrapped to the recipient for that same minimum. Apps that spread `...uniswapPins` get it without other changes. The addresses module now also exports `ROUTER_ABI`.
  
  **Breaking:** a remote Uniswap quote whose router call is anything else — `pull`, `sweepToken`, extra legs, another recipient, token, amount or minimum, a price limit, a deposit address — is refused. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

### Patch Changes

- Updated dependencies [834c24d]
- Updated dependencies [88a4582]
- Updated dependencies [12fc609]
  - @anywalletkit/core@0.7.0
  - @anywalletkit/protocol-swap2-core@0.8.0
  - @anywalletkit/swap2-assets@0.2.2

## 0.2.0

### Minor Changes

- 418fea1: A remote provider's addresses come from the app, never from its backend. `remoteProvider` takes `callTargets(chain)` / `spenders(chain)` — the provider package's pins, spread in: `lifiPins`, `fyndPins`, `uniswapPins`, `chainflipPins`, `cctpPins` (with its `claimTargets`), `usdt0Pins`, `balancerPins`, `wrapPins` — and an optional `verifyQuote(params, quote)` that runs the provider's own check on the client (`fyndPins` carries `fyndVerifyQuote`: `checkFyndTransaction` against the app's request). The stub is marked `remote: true`; the engine then lets its EVM routes call only pinned targets and approve only pinned spenders. **Fail closed: a remote stub without pins gets no EVM calldata route or approval** — the router and the single-provider path drop such a quote with the reason (`remotePinRefusal`), deposit-address routes need no pins. Wire the pins in every app that proxies providers through `createSwap2Handler`.
  
  For every provider, a token call in a swap's calldata must move the source token, at most the swap amount, to this account, the deposit address of a deposit-address route, or the declared spender (for a remote stub: the pins); `setApprovalForAll` and Permit2 `approve` are never a swap's main call, and `transferFrom` is refused. Before, `{to: USDC, data: approve(attacker, MAX), approvalAddress: attacker}` from a backend, or `cbBTC.transfer(attacker, all)` with `depositAddress = attacker`, passed because the allowlist was the response's own addresses. The router's provider snapshot now keeps the remote marker and the pins (dropped there, execution through the router took a remote stub for a local provider).
  
  **Breaking:** a `remoteProvider` without `callTargets` / `spenders` gets no calldata route on EVM — spread the provider's pins (`lifiPins`, `fyndPins`, …); swap calldata may only move the source token, by at most the input; an operator or Permit2 approval or a `transferFrom` as the swap call is refused. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

### Patch Changes

- Updated dependencies [c59c8cc]
- Updated dependencies [f1a46e4]
- Updated dependencies [418fea1]
- Updated dependencies [28c7d3a]
- Updated dependencies [a4ceb50]
- Updated dependencies [0e43992]
  - @anywalletkit/protocol-swap2-core@0.7.0
  - @anywalletkit/swap2-assets@0.2.2

## 0.1.9

### Patch Changes

- b1350b4: Every type a public signature uses is exported, so the API reference documents it and apps can name it: the provider config types (`LifiSwap2Config`, `BalancerSwap2Config`, `NearIntentsSwap2Config`, `FyndSwap2Config`, …), the explorer client options in history-evm (`EtherscanClientOptions`, `AlchemyClientOptions`, `BlockscoutClientOptions`), `Swap2ExecutionPhase`, the Omniston client shapes, and the row / view types the chain packages already expose through their methods. Type-only additions, plus the account-meta role constants of native SOL staking (`READONLY`, `WRITABLE`, …). Renames on export: Aave and Morpho activity `Action` → `AaveActivityAction` / `MorphoActivityAction`; conformance `ProtocolCtor` / `WriteProtocolCtor`; history-evm `RawRow`.
- eb14cb5: npm metadata: every package has a description and the `anywalletkit` keyword. The LI.FI, NEAR Intents, Omniston and THORChain packages had an empty description, so npm showed the README badge markdown in its place, and 24 packages were missing from a `keywords:anywalletkit` search. `pnpm pack:check` now refuses a package without either.
- Updated dependencies [b1350b4]
- Updated dependencies [eb14cb5]
  - @anywalletkit/protocol-swap2-core@0.6.1
  - @anywalletkit/core@0.6.1
  - @anywalletkit/swap2-assets@0.2.2

## 0.1.8

### Patch Changes

- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- Updated dependencies [f743c06]
- Updated dependencies [f743c06]
- Updated dependencies [d82e140]
- Updated dependencies [d82e140]
- Updated dependencies [f743c06]
- Updated dependencies [398129f]
- Updated dependencies [b55aa5d]
- Updated dependencies [b55aa5d]
- Updated dependencies [b55aa5d]
- Updated dependencies [b55aa5d]
- Updated dependencies [b55aa5d]
  - @anywalletkit/core@0.6.0
  - @anywalletkit/protocol-swap2-core@0.6.0
  - @anywalletkit/swap2-assets@0.2.1

## 0.1.7

### Patch Changes

- 0d0e46e: Swaps of tokens the catalog does not list (a user's own tokens, named by EVM contract or Solana mint), opt-in with `allowUnlistedTokens: true` on the engine and on `createSwap2Handler`; off by default, nothing changes without it. The engine reads the source token's decimals with the account's `getTokenInfo` (cached; a disagreeing `fromTokenDecimals` is refused) and sends them as `QuoteParams.sourceDecimals`; approvals go to the named token for the exact amount and the quoted spender, with the same value binding as catalog tokens. LI.FI, Uniswap, Balancer and Fynd resolve the source with the new `sourceAssetOf(params)`; providers with their own asset lists keep refusing. `swap2-assets` adds `isTokenAddress`, `unlistedAsset`, `isUnlisted`, `resolveAsset` (catalog first, always) and `catalogChainId`.
- Updated dependencies [6dde4e4]
- Updated dependencies [b08c01a]
- Updated dependencies [e9cc028]
- Updated dependencies [a354990]
- Updated dependencies [0d0e46e]
  - @anywalletkit/swap2-assets@0.2.0
  - @anywalletkit/core@0.5.0
  - @anywalletkit/protocol-swap2-core@0.5.0

## 0.1.6

### Patch Changes

- Updated dependencies [8aa911d]
- Updated dependencies [8aa911d]
- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1
  - @anywalletkit/protocol-swap2-core@0.4.1
  - @anywalletkit/swap2-assets@0.1.5

## 0.1.5

### Patch Changes

- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- Updated dependencies [07db4c1]
- Updated dependencies [80d6451]
- Updated dependencies [a9a5e0a]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
- Updated dependencies [c4dc4d6]
- Updated dependencies [ed99146]
  - @anywalletkit/core@0.4.0
  - @anywalletkit/protocol-swap2-core@0.4.0
  - @anywalletkit/swap2-assets@0.1.5

## 0.1.4

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2
  - @anywalletkit/protocol-swap2-core@0.3.2
  - @anywalletkit/swap2-assets@0.1.4

## 0.1.3

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [6b164bd]
- Updated dependencies [65c3bca]
  - @anywalletkit/protocol-swap2-core@0.3.1
  - @anywalletkit/core@0.3.1
  - @anywalletkit/swap2-assets@0.1.3

## 0.1.2

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
- Updated dependencies [0d68fda]
- Updated dependencies [6568e08]
- Updated dependencies [06cecff]
- Updated dependencies [24b888a]
- Updated dependencies [bdc77c2]
- Updated dependencies [4fcb9b6]
- Updated dependencies [d08e37e]
  - @anywalletkit/core@0.3.0
  - @anywalletkit/protocol-swap2-core@0.3.0
  - @anywalletkit/swap2-assets@0.1.2

## 0.1.1

### Patch Changes

- 7f5d0fe: Value information on quotes (owner decision 2026-10-16: inform, never block). `quoteValues(prices, params, quotes)` in swap2-router gives every quote its USD in / out, loss %, the venue's price impact and the better alternative inside the set; the Uniswap provider measures its pool's price impact with a 1/1000 probe on the chosen route and reports it as `providerData.priceImpactBps`. The Oct 16 funded run lost ~$33 on two Uniswap legs that nothing compared against the other venues.
- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
- Updated dependencies [412164a]
- Updated dependencies [f427dec]
- Updated dependencies [7004ecf]
- Updated dependencies [e0edbf6]
- Updated dependencies [29af9d6]
  - @anywalletkit/core@0.2.0
  - @anywalletkit/protocol-swap2-core@0.2.0
  - @anywalletkit/swap2-assets@0.1.1

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / its earlier 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`anywalletkit` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @anywalletkit/core@0.1.0
  - @anywalletkit/protocol-swap2-core@0.1.0
  - @anywalletkit/swap2-assets@0.1.0
