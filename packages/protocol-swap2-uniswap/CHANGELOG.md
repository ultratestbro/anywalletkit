# @anywalletkit/protocol-swap2-uniswap

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
