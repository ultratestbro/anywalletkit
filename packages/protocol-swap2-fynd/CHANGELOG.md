# @anywalletkit/protocol-swap2-fynd

## 0.2.3

### Patch Changes

- cbd7caa: `fyndVerifyQuote` refuses a cross-chain request (re-audit 2026-10-30, #3). It took the router from the source chain and never compared the destination chain, so a valid source-chain swap to native ETH passed for, say, a Base → Unichain request and paid out on Base. Fynd is same-chain only, as the local provider already enforced.

## 0.2.2

### Patch Changes

- Updated dependencies [9e27fc6]
  - @anywalletkit/protocol-swap2-core@0.9.0

## 0.2.1

### Patch Changes

- Updated dependencies [834c24d]
- Updated dependencies [88a4582]
- Updated dependencies [12fc609]
  - @anywalletkit/core@0.7.0
  - @anywalletkit/protocol-swap2-core@0.8.0
  - @anywalletkit/swap2-assets@0.2.2

## 0.2.0

### Minor Changes

- f1a46e4: Text and calldata from a page, a client or an API are bounded before anything parses them. extension-kit: an error message is cut to its first line within 1 KB before its URLs are taken out (the URL regex has a bounded scheme), and a request's `method` must be a method name — letters, digits and `_`, at most 128 (`isRelayMethod`, `RELAY_METHOD_MAX`) — or the relay drops it and the router answers -32600 without echoing it. swap2-core: `redactUrls` is linear whatever the text (it also catches a URL right after `_` or glued to a long word now), and the server cuts a provider's refusal or error before redacting it. Balancer: `preflightDeposit` decodes and prices only the quote's own batch — a client's different `tx.data` is refused before it is decoded — with at most `BALANCER_MAX_SWAPS` (16) hops and no pool `userData`, and a longer SOR route is refused at the quote. Fynd: `preflightDeposit` simulates only the quote's own transaction (target, calldata, value), a refusal names the transaction target only when it is an address, and protocol names from the API are cut to 40 characters.
  
  **Breaking:** extension-kit drops a relay request whose `method` is not a method name (answer it with -32600 in your injected provider); Balancer `preflightDeposit` refuses calldata that is not the quote's own batch, and Fynd's a transaction whose target, calldata or value differs from the quote's. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.
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

## 0.1.7

### Patch Changes

- b1350b4: Every type a public signature uses is exported, so the API reference documents it and apps can name it: the provider config types (`LifiSwap2Config`, `BalancerSwap2Config`, `NearIntentsSwap2Config`, `FyndSwap2Config`, …), the explorer client options in history-evm (`EtherscanClientOptions`, `AlchemyClientOptions`, `BlockscoutClientOptions`), `Swap2ExecutionPhase`, the Omniston client shapes, and the row / view types the chain packages already expose through their methods. Type-only additions, plus the account-meta role constants of native SOL staking (`READONLY`, `WRITABLE`, …). Renames on export: Aave and Morpho activity `Action` → `AaveActivityAction` / `MorphoActivityAction`; conformance `ProtocolCtor` / `WriteProtocolCtor`; history-evm `RawRow`.
- Updated dependencies [b1350b4]
- Updated dependencies [eb14cb5]
  - @anywalletkit/protocol-swap2-core@0.6.1
  - @anywalletkit/core@0.6.1
  - @anywalletkit/swap2-assets@0.2.2

## 0.1.6

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

## 0.1.5

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

## 0.1.4

### Patch Changes

- Updated dependencies [8aa911d]
- Updated dependencies [8aa911d]
- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1
  - @anywalletkit/protocol-swap2-core@0.4.1
  - @anywalletkit/swap2-assets@0.1.5

## 0.1.3

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

## 0.1.2

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2
  - @anywalletkit/protocol-swap2-core@0.3.2
  - @anywalletkit/swap2-assets@0.1.4

## 0.1.1

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [6b164bd]
- Updated dependencies [65c3bca]
  - @anywalletkit/protocol-swap2-core@0.3.1
  - @anywalletkit/core@0.3.1
  - @anywalletkit/swap2-assets@0.1.3

## 0.1.0

### Minor Changes

- a8f1e72: New package: Fynd (Propeller Heads) as a same-chain swap2 provider on Ethereum, Base, Arbitrum, BNB Chain, Polygon, Unichain and Robinhood Chain — the hosted API (key kept server-side) or self-hosted `fynd serve` per chain. Every encoded transaction is decoded and checked before approval or signing: pinned TychoRouterV3, a plain singleSwap / sequentialSwap / splitSwap, the exact input and tokens, the user as receiver, the quoted output and minimum, Fynd's fee breakdown adding up, no client fee. Optional pre-broadcast simulation and receipts over `rpcUrls`. Fynd outputs are licensed under the Fynd License (settlement through the Tycho router, platform fee and positive-slippage capture, revenue share on revenue earned from such swaps) — see the package README.

### Patch Changes

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
