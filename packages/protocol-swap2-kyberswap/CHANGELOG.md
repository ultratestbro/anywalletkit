# @anywalletkit/protocol-swap2-kyberswap

## 0.1.0

### Minor Changes

- 3fd2ca4: New package: KyberSwap Aggregator as a same-chain swap2 provider on 18 EVM chains (Ethereum, Base, BNB Smart Chain, Arbitrum, Optimism, Polygon, Avalanche, Linea, Sonic, Berachain, Unichain, HyperEVM, Plasma, Monad, MegaETH, Robinhood Chain, Arc, Elysium), settled through MetaAggregationRouterV2. Built from KyberSwap's Aggregator API and router contracts, no KyberSwap SDK. No integrator fee. Keyless (public API) or with an API-gateway key (`apiKey`, `https://api.kyberswap.com/swap`, kept on a server; with a key only `X-Api-Key` is sent).
  
  - **Nothing in the build is trusted.** KyberSwap's `/route/build` encodes whatever route summary it receives, so `checkKyberTransaction` decodes the calldata strictly (re-encoded byte for byte) and refuses unless: the target is the pinned router and the call is `swap()` (`swapGeneric`, `swapSimpleMode` and router V3 refused by name); the executor is the pinned AggregationExecutorProxy; the input token and amount, output token and receiver are the request's; the minimum is at least the quote's and the caller's floor; there are no fee receivers, no permit and no flag but `0x200`. The same check runs on the device for a quote from a backend (`remoteProvider({name: 'kyberswap', baseUrl, ...kyberPins})`).
  - **Simulated before the user pays anything:** a native input with a balance override; a token input's approval and swap as one `eth_simulateV1` block before any approval (or the plain call when the allowance is already there), so a route that reverts never asks for an approval. Without an RPC answering, the swap is refused.
  - `providerData.priceImpactBps` from KyberSwap's own USD valuation of the route (routes losing 25–68% come back with code 0 and no impact field), so the router can warn even when the app prices neither token.
  - The API slippage is lowered just enough that KyberSwap's minimum (one unit under the usual formula) never falls below core's slippage floor.
  - Classified refusals: 429 `rate_limited`, 5xx `upstream_unavailable`, a revert in the simulation `simulation_failed` / `price_check_failed`.
  - `describeKyberActivity`, `KyberswapSwap2Protocol` standalone, `kyberPins`, `KYBER_CHAINS`.
  - Checked live, read-only (`scripts/verify-live.mjs`, keyless or with `KYBERSWAP_API_KEY`): router and executor code and build on all 18 chains, and an executable quote each way on 17 (Robinhood Chain has no corridor in the catalog). Funded on Base (2026-11-24): a native and a token sale, allowance back at 0.
  - Used with KyberSwap's written consent (2026-11-26).
