# @anywalletkit/protocol-swap2-lifi

## 0.7.0

### Minor Changes

- 5a49598: Elysium by Kinetiq (`eip155:99901`) is routed, as a source, a destination and for same-chain swaps. On Elysium the only trusted entry point is its own Diamond `0x24E6dA91AA4A8FEe2447F542c92E006243bd6Dc5` (li.quest `diamondAddress` = lifinance/contracts `deployments/elysium.json`; the canonical `0x1231…` has no code there), and `watch.json` reads its DiamondLoupe `facets()` like every other chain's. Checked live through this provider on 2026-11-10: Arbitrum / Base USDC → Elysium USDC.e, Elysium USDC.e → Base USDC and Elysium HYPE → Arbitrum USDC quote through LI.FI Intents, and HYPE ↔ USDC.e / USDC.e → kHYPE on Elysium through GenericSwapFacetV3. Native HYPE into Elysium is offered by LI.FI only through Relay, which the module refuses (the receiver is not bound in the calldata), so it has no route here.

### Patch Changes

- Updated dependencies [6d6e801]
- Updated dependencies [ff6582a]
  - @anywalletkit/swap2-assets@0.3.0
  - @anywalletkit/protocol-swap2-core@0.10.3

## 0.6.1

### Patch Changes

- Updated dependencies [10e06dc]
  - @anywalletkit/swap2-assets@0.2.3
  - @anywalletkit/protocol-swap2-core@0.10.2

## 0.6.0

### Minor Changes

- a7cb98f: Cross-chain requests from an EVM chain now ask LI.FI not to offer routes with a destination call (`allowDestinationCall=false` on `/quote` and in the route-options request). The module already refused those routes, so a pair where LI.FI picked one showed no route; it now gets a route the module accepts. The refusal stays in place as the backstop. Requests from Solana are unchanged.
  
  New opt-in option `routeWideSlippage` (default off): sends `slippageScope=route` on EVM → EVM requests, so LI.FI applies one slippage budget to the whole route and returns a single minimum the transaction enforces, instead of applying the slippage to every step. When LI.FI can protect no route for a request (`ROUTE_SLIPPAGE_UNSUPPORTED`) or has route-wide slippage switched off (`ROUTE_SLIPPAGE_UNAVAILABLE`), it is asked again in its default scope while quoting, and that quote, the one the user reviews, is held to the same floor as before. Leaving it off keeps today's behaviour exactly.

### Patch Changes

- a7cb98f: LI.FI routes through Eco work again. Eco's facet was upgraded to v3 on 2026-11-01, which changed both entry-point selectors and moved the refund address in its data, so every Eco route was refused as an unknown Diamond call. The new entry points are listed, the refund address is read where v3 keeps it, and because v3 no longer checks on chain that the intent pays the recipient, the device reads the intent itself: it must run on the destination chain and end in a transfer of the destination token, of at least the reviewed minimum, to the recipient. Eco routes that run elsewhere (CCTP, HyperCore, chained intents), routes of more than 16 calls, and Eco routes to a native destination token (ETH, POL, …), which have no token transfer to read, are refused; for those pairs LI.FI picks another bridge or the pair shows no route. Nothing to change in apps.
- a7cb98f: An M0 order's destination token and amount are now checked against the quote: the order must ask the solver for the destination token and at least the minimum the user reviewed. An M0 order to a native destination token (ETH, POL, …) is always refused, as M0's facet itself refuses one. Before, only its recipient and refund addresses were checked. LI.FI's live M0 quotes already match. Nothing to change in apps.
- @anywalletkit/protocol-swap2-core@0.10.1
  - @anywalletkit/swap2-assets@0.2.2

## 0.5.0

### Minor Changes

- d1e517a: Bridges out of Solana are now bound to the recipient you reviewed, not only to a SOL-out ceiling.
  
  - `protocol-swap2-core`: for a cross-chain serialized leg the engine adds `bridgeOut: {destChain, recipient}` to the expectation it hands `account.sendSerializedTransaction`.
  - `wallet-solana`: `sendSerialized` / `checkSerialized` accept `expect.bridgeOut` (`BridgeOutExpectation`). When the transaction is a Mayan route (it runs one of Mayan's own programs, directly or through Mayan's CPI proxy), every top-level instruction must be one the guard can follow — transfers to this wallet's own accounts or to a fee wallet (LI.FI's `LIFI_FEE_WALLET_ADDRESS` by default, at most 3 % of what may leave), a Jupiter swap into the wallet or the bridge, Mayan's Swift / MCTP / Fast MCTP orders — and every Mayan order must pay `recipient` on `destChain`; otherwise the wire is refused with `bridge-recipient`, `bridge-payee`, `bridge-instruction`, `bridge-missing` or `bridge-fee`. A transaction of another bridge is checked as without `bridgeOut` (see the Solana-bridges note). Instructions sent through Mayan's CPI proxy (`MAYAN_CPI_PROXY_PROGRAM_ADDRESS`) are now described and guarded as the instruction they run, so a program allowlist and the core-instruction checks see through it; the legacy empty-data ATA Create is described as an ATA creation.
  - `protocol-swap2-lifi`: the provider and `lifiVerifyQuote` refuse a Solana bridge transaction that is not paid by the sender, or a Mayan route that transfers SOL directly to a wallet other than the sender or LI.FI's fee wallet.
  
  What to do: map the swap2 expectation onto `account.sendSerialized` with `serializedGuardFromExecution` from `wallet-solana` (see the note on it) instead of by hand. Without `bridgeOut` the account cannot prove where a Mayan bridge pays.
- d673f68: LI.FI EVM routes no longer use bridges whose Diamond call does not bind the recipient the wallet checked. Relay (`relaydepository`) deposits against an order id whose off-chain order names the recipient, and Garden, deBridge DLN and ThorSwap carry the destination in facet data or an off-chain order the facet never compares, so a matching `BridgeData.receiver` said nothing about where the funds go. These calls are now refused with a named reason (also by `lifiVerifyQuote` / `lifiPins` for remote quotes), Squid is accepted only on its CallBridge route, and every cross-chain request asks LI.FI to deny `relaydepository` and `garden` (also in the `chooseRoute` candidates), so the affected pairs come back through another bridge (live 2026-11-02: Gnosis xDAI → Arbitrum USDC via NEAR Intents, Base USDC → Arbitrum via Polymer, ETH routes via Across). Nothing to change in apps; a `chooseRoute` policy that allowed only `relaydepository` now gets LI.FI's default pick.

### Patch Changes

- ac56c9b: A Mayan bridge order out of Solana is now always held to a reviewed token and minimum.
  
  - `protocol-swap2-core`: `Quote` gains an optional `destDecimals` (the destination token's decimals as the provider reports them). The swap2 server seals it (a whole number in 0..36; anything else is refused like any malformed quote field). The engine's `bridgeOut.destDecimals` uses the asset catalog's decimals, else the caller's verified `toTokenDecimals` (which the quote's value must agree with), never the quote's alone.
  - `protocol-swap2-lifi`: quotes carry `destDecimals` from LI.FI's `action.toToken.decimals`.
  - `wallet-solana`: with `expect.bridgeOut`, a Mayan order is refused when the guard names no `destToken` (`bridge-token`) or no `minAmountOut` with `destDecimals` (`bridge-min`), instead of passing with only its own non-zero minimum.
  
  What to do: nothing when you map the engine's expectation with `serializedGuardFromExecution`. A hand-built `bridgeOut` for a Mayan route must now carry `destToken`, `minAmountOut` and `destDecimals`. A swap to a destination token the catalog does not list through Mayan needs `toTokenDecimals`, or the leg is refused at signing.
- ccea432: A quote whose minimum sits exactly at the requested slippage is no longer refused for a rounding difference. Providers compute their minimum with their own rounding — LI.FI's Mayan answers land a few base units under floor(output × (1 − slippage)) on 18-decimal tokens — so the LI.FI provider's per-step check, `validQuote` (router, single-provider path, server) and the engine's caller-slippage check refused about half of the Mayan routes out of Solana at the default 0.5 % as "0.50 % under the quote". All three now accept a minimum up to the requested slippage plus 1 bp (`SLIPPAGE_ROUNDING_BPS`, and `slippageFloor(dest, bps)` in `@anywalletkit/protocol-swap2-core/validate`); a minimum further under the quote is still refused. Nothing to change in apps.
- dec67d8: The LI.FI Diamond check now also reads the refund, depositor and fallback addresses a bridge carries in its own data — Stargate's LayerZero fee refund, the depositor of an Across deposit (and the Across Swap API's sponsored flows), the user of a LI.FI intent, an Eco intent's creator, an M0 order's owner, a Mayan Swift order's trader, Chainflip's refund address, and the refund recipients of Centrifuge, Frax, Glacis, LayerSwap, NEAR Intents, Polymer CCTP, Superset and Symbiosis — and refuses the quote unless each one is the sender or the recipient. LI.FI's own quotes set them to the sender, so routes keep working; the check runs in the provider and in `lifiVerifyQuote` (the `lifiPins` of a `remoteProvider`). Nothing to change in apps. Superset quotes that name a third address as their refund and fallback are refused.
- 1726ef8: LI.FI routes through Squid and Symbiosis are no longer accepted, and cross-chain requests now ask LI.FI to route around them (`denyBridges=squid,symbiosis`, also in the route-options request), the way Relay and Garden already were. Neither ties where the funds go to the recipient the app reviews: Squid's route that bridges to it first runs arbitrary calls with the funds (LI.FI's Squid quotes were already refused, as they hand the funds to a destination call), and Symbiosis's main path names the final recipient and its revert address in calldata the Diamond forwards unchecked. Pairs they would have served get another bridge from LI.FI, or another provider. An app's route policy (`chooseRoute` → `allowBridges`) cannot re-enable them. Nothing to change in apps.
- 9088e60: LI.FI's Solana bridges other than Mayan — Relay, LayerSwap, NEAR Intents, LI.FI Intents and whatever else LI.FI offers from Solana — quote and execute again as before. From Solana the provider no longer restricts LI.FI to Mayan (no `allowBridges` / `denyBridges` of its own, a `chooseRoute` policy's pick passes through, Relay included), and neither the provider, `lifiVerifyQuote` nor the account's `bridgeOut` check refuses a transaction for calling no Mayan program.
  
  Be aware: these bridges deposit to an address, an order id or a program whose recipient lives in an off-chain order or in data the device does not read, so the account does NOT check their recipient. With or without `bridgeOut` they are held to what they were held to before: the program allowlist and the `maxLamportsOut` / `maxTokenOut` ceilings. Only Mayan routes (Swift, MCTP, Fast MCTP) are recipient-, token- and minimum-checked on the device. EVM sources are unchanged: Relay, Garden, deBridge DLN and ThorSwap Diamond calls stay refused and Relay / Garden stay denied in the request. LI.FI Intents calls a program outside `DEFAULT_PROGRAM_ALLOWLIST`, as before: it passes only for an app that allows that program.
  
  Nothing to change in apps.
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

## 0.4.0

### Minor Changes

- a9bc274: `lifiPins` carry `verifyQuote: lifiVerifyQuote` (scan 2026-10-30, F3), exported too. The pins named only the Diamond, so a compromised backend could answer with Diamond calldata paying its own receiver, bridging to another chain or accepting less, and the engine signed it. The app now runs the provider's own `diamondCallMismatch` on the device with the expectation the provider builds (input token and amount, requested output token, recipient, quoted minimum ≥ the caller's floor, destination chain), plus the input's value (native: input + declared bridge fee; token: only the declared fee, approving the Diamond) and the intent id. A Solana source's serialized transaction is left to the account's balance proof. Validated on live LI.FI answers across 32 corridors (Across, Stargate, Relay, Mayan, LayerSwap, Polymer, Glacis, LI.FI Intents, NEAR, same-chain swaps): every quote the provider accepts passes.

### Patch Changes

- Updated dependencies [9e27fc6]
  - @anywalletkit/protocol-swap2-core@0.9.0

## 0.3.1

### Patch Changes

- Updated dependencies [834c24d]
- Updated dependencies [88a4582]
- Updated dependencies [12fc609]
  - @anywalletkit/core@0.7.0
  - @anywalletkit/protocol-swap2-core@0.8.0
  - @anywalletkit/swap2-assets@0.2.2

## 0.3.0

### Minor Changes

- 418fea1: A remote provider's addresses come from the app, never from its backend. `remoteProvider` takes `callTargets(chain)` / `spenders(chain)` — the provider package's pins, spread in: `lifiPins`, `fyndPins`, `uniswapPins`, `chainflipPins`, `cctpPins` (with its `claimTargets`), `usdt0Pins`, `balancerPins`, `wrapPins` — and an optional `verifyQuote(params, quote)` that runs the provider's own check on the client (`fyndPins` carries `fyndVerifyQuote`: `checkFyndTransaction` against the app's request). The stub is marked `remote: true`; the engine then lets its EVM routes call only pinned targets and approve only pinned spenders. **Fail closed: a remote stub without pins gets no EVM calldata route or approval** — the router and the single-provider path drop such a quote with the reason (`remotePinRefusal`), deposit-address routes need no pins. Wire the pins in every app that proxies providers through `createSwap2Handler`.
  
  For every provider, a token call in a swap's calldata must move the source token, at most the swap amount, to this account, the deposit address of a deposit-address route, or the declared spender (for a remote stub: the pins); `setApprovalForAll` and Permit2 `approve` are never a swap's main call, and `transferFrom` is refused. Before, `{to: USDC, data: approve(attacker, MAX), approvalAddress: attacker}` from a backend, or `cbBTC.transfer(attacker, all)` with `depositAddress = attacker`, passed because the allowlist was the response's own addresses. The router's provider snapshot now keeps the remote marker and the pins (dropped there, execution through the router took a remote stub for a local provider).
  
  **Breaking:** a `remoteProvider` without `callTargets` / `spenders` gets no calldata route on EVM — spread the provider's pins (`lifiPins`, `fyndPins`, …); swap calldata may only move the source token, by at most the input; an operator or Permit2 approval or a `transferFrom` as the swap call is refused. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.
- f3ec101: The Diamond calldata check reads every swap step, not only the first and last: each step must spend what the one before delivered, only steps spending the input token may pull from the wallet (`requiresDeposit`), together at most the input — a middle step depositing DAI under a leftover allowance was accepted. The GenericSwapFacet V3 entry points are bound to the asset kinds they move: `*ToNative` only for a native output, `*ToERC20` only for a token output, `NativeTo*` / `ERC20To*` only for the matching input — a `*ToNative` call counted a USDC minimum in wei. A bridge without source swaps must bridge the input, less at most a 1 % bridge fee (a `minAmount` of 1 passed and left the rest of the allowance standing). **`apiUrl` must be `https:`**; `allowInsecureApiUrl: true` allows plain http for local development.
  
  **Breaking:** `apiUrl` must be https (`allowInsecureApiUrl`); routes whose steps do not chain, that deposit another token, or that bridge less than the input − 1 % are refused. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

### Patch Changes

- Updated dependencies [c59c8cc]
- Updated dependencies [f1a46e4]
- Updated dependencies [418fea1]
- Updated dependencies [28c7d3a]
- Updated dependencies [a4ceb50]
- Updated dependencies [0e43992]
  - @anywalletkit/protocol-swap2-core@0.7.0
  - @anywalletkit/swap2-assets@0.2.2

## 0.2.8

### Patch Changes

- b1350b4: Every type a public signature uses is exported, so the API reference documents it and apps can name it: the provider config types (`LifiSwap2Config`, `BalancerSwap2Config`, `NearIntentsSwap2Config`, `FyndSwap2Config`, …), the explorer client options in history-evm (`EtherscanClientOptions`, `AlchemyClientOptions`, `BlockscoutClientOptions`), `Swap2ExecutionPhase`, the Omniston client shapes, and the row / view types the chain packages already expose through their methods. Type-only additions, plus the account-meta role constants of native SOL staking (`READONLY`, `WRITABLE`, …). Renames on export: Aave and Morpho activity `Action` → `AaveActivityAction` / `MorphoActivityAction`; conformance `ProtocolCtor` / `WriteProtocolCtor`; history-evm `RawRow`.
- eb14cb5: npm metadata: every package has a description and the `anywalletkit` keyword. The LI.FI, NEAR Intents, Omniston and THORChain packages had an empty description, so npm showed the README badge markdown in its place, and 24 packages were missing from a `keywords:anywalletkit` search. `pnpm pack:check` now refuses a package without either.
- Updated dependencies [b1350b4]
- Updated dependencies [eb14cb5]
  - @anywalletkit/protocol-swap2-core@0.6.1
  - @anywalletkit/core@0.6.1
  - @anywalletkit/swap2-assets@0.2.2

## 0.2.7

### Patch Changes

- b55aa5d: LI.FI status `INVALID` is reported `failed` instead of staying `pending` forever.
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

## 0.2.6

### Patch Changes

- 3f3c4fd: Bridge calldata must use one of LI.FI's ABI-encoded bridge entry points (`startBridgeTokensVia*` / `swapAndStartBridgeTokensVia*`, computed from the facet sources): a packed call whose bytes merely look like a `BridgeData` is refused. Routes with source swaps are no longer refused for comparing the bridged amount (the swapped token) with the input. The README states what is not checked: a bridge's output minimum lives in bridge-specific data.
- 6857b7f: LI.FI quotes are checked against their Diamond calldata, not only the `action` / `estimate` beside it: a same-chain swap must pay the reviewed recipient at least the reviewed minimum in the requested tokens, a bridge's `BridgeData` must pay the reviewed recipient on the requested chain, bridging the input token. Routes with a destination call, EVM-source routes to a non-EVM chain (their receiver cannot be read here) and calldata that decodes as nothing known are refused.
- e9cc028: A blank `recipient` / `refundAddress` (`""` from an empty input) is treated as omitted: the swap goes to, and refunds to, the account itself, and the review shows that address. CCTP, USDT0 and LI.FI use their placeholder address only for dry quotes; a live quote without a recipient or refund address is refused instead of being built to the placeholder.
- 0d0e46e: Swaps of tokens the catalog does not list (a user's own tokens, named by EVM contract or Solana mint), opt-in with `allowUnlistedTokens: true` on the engine and on `createSwap2Handler`; off by default, nothing changes without it. The engine reads the source token's decimals with the account's `getTokenInfo` (cached; a disagreeing `fromTokenDecimals` is refused) and sends them as `QuoteParams.sourceDecimals`; approvals go to the named token for the exact amount and the quoted spender, with the same value binding as catalog tokens. LI.FI, Uniswap, Balancer and Fynd resolve the source with the new `sourceAssetOf(params)`; providers with their own asset lists keep refusing. `swap2-assets` adds `isTokenAddress`, `unlistedAsset`, `isUnlisted`, `resolveAsset` (catalog first, always) and `catalogChainId`.
- Updated dependencies [6dde4e4]
- Updated dependencies [b08c01a]
- Updated dependencies [e9cc028]
- Updated dependencies [a354990]
- Updated dependencies [0d0e46e]
  - @anywalletkit/swap2-assets@0.2.0
  - @anywalletkit/core@0.5.0
  - @anywalletkit/protocol-swap2-core@0.5.0

## 0.2.5

### Patch Changes

- Updated dependencies [8aa911d]
- Updated dependencies [8aa911d]
- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1
  - @anywalletkit/protocol-swap2-core@0.4.1
  - @anywalletkit/swap2-assets@0.1.5

## 0.2.4

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

## 0.2.3

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2
  - @anywalletkit/protocol-swap2-core@0.3.2
  - @anywalletkit/swap2-assets@0.1.4

## 0.2.2

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [6b164bd]
- Updated dependencies [65c3bca]
  - @anywalletkit/protocol-swap2-core@0.3.1
  - @anywalletkit/core@0.3.1
  - @anywalletkit/swap2-assets@0.1.3

## 0.2.1

### Patch Changes

- 21e92a6: Every refusal after LI.FI answers now names the check that failed. Matrix v7 found 4 silent nulls.
  
  A bridge that takes its fee from the input (glacis: `estimate.fromAmount` about 0.25 % under the spent amount) is now quoted instead of refused:
  
  - **Limits:** the transaction must spend exactly the input, and the input-side fee may be at most 3 %.
  - **Amounts:** `sourceAmount` is the spent input, and `destAmount` already reflects the fee.
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

## 0.2.0

### Minor Changes

- 40df5d2: `chooseRoute` hook: a cross-chain quote first reads `/advanced/routes`, hands the single-transaction candidates to the app and restricts `/quote` to its choice (allowBridges / denyBridges / order). Any failure, or a chosen bridge that disappears before `/quote`, falls back to LI.FI's default pick.

### Patch Changes

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
