# @anywalletkit/protocol-swap2-thorchain

## 0.4.0

### Minor Changes

- afe3c41: THORChain quotes are no longer refused because the inbound vault rotated or the confirming node is a few blocks behind. THORChain's inbound address moves among its active asgard vaults every few minutes, and public nodes reachable from a browser trailed the quoting node by ~25–28 blocks on 2026-11-12, so requiring the confirming node's current inbound to equal the quoted vault refused most quotes ("a second node reports another inbound vault — refused until they agree"). A confirming node now also confirms the source chain's address of a vault it lists as `ActiveVault` in `/thorchain/vaults/asgard` whose mimir does not flag it `CompromisedVault` or `SolvencyHaltVault` (THORNode leaves those out of inbound election and does not credit an inbound to a compromised vault); a `RetiringVault` or any other status never confirms. The router check, halts (now also the destination chain on the confirming node), memo, expiry, minimums and the quote node's own inbound binding are unchanged, and the calldata must still pay exactly the quoted vault.
  
  New options: `confirmMaxLagBlocks` (default 50) skips a confirming node that trails the quoting node's `/thorchain/lastblock` height by more, and `confirmTimeoutMs` (default 2500, 100–8000) bounds each confirming node (AbortController + setTimeout, no AbortSignal.timeout). The vault check has its own 8 s budget: it starts when the quote is in hand (before broadcast: when a node is asked to refresh the inbound snapshot), covers that node's `inbound_addresses` and `lastblock` reads and every confirming node, and no confirming node is asked with less than 100 ms left, so a slow first `nodeUrl` host no longer leaves the confirmation without time. `confirmTimeoutMs` bounds confirming nodes only; each read of the quoting node (the quote, `inbound_addresses`, `lastblock`) gets 8 s. Worst case without a caller signal: `nodeUrl` hosts × 16 s (× 24 s when a quote without a slippage is retried with a wider tolerance), `preflightDeposit` hosts × 8 s; a caller's AbortSignal replaces the 8 s bound of the quote request.
  
  Confirming reads are `GET` on four fixed paths with no query string and no cache option, exported as `THORNODE_CONFIRM_PATHS`: a proxy in front of a confirming node must pass `/thorchain/lastblock`, `/thorchain/vaults/asgard` and `/thorchain/mimir` besides `/thorchain/inbound_addresses`, or it is skipped for the next node. **Breaking:** the quoting node (`nodeUrl`) is now also asked `GET /thorchain/lastblock` without a query string, so a proxy in front of it must pass that path too, or every quote is refused once no `nodeUrl` host answers it (see the upgrade notes); update such a proxy before the app.
  
  `thorchainPins().verifyBuild` (the device's check of a remote build) applies the same rule, so a rotation between the backend's quote and the device's check no longer refuses: every `nodeUrl` node is asked in parallel on the same four paths, each within the new `confirmTimeoutMs` option (default 2500 ms, so the check takes at most that), a node more than the new `confirmMaxLagBlocks` option (default 50) behind the highest THORChain height the nodes report is skipped, a failing, redirecting, slow or other-shaped node is skipped, and in `nodeUrl` order a node's refusal refuses while two confirming nodes pass; the destination chain must be open too.
  
  A field of another type in a node's answer is another shape. Before, a node answering an `inbound_addresses` address or router as a number (or object) made the address comparison throw a TypeError out of `getQuote`, `preflightDeposit` and `verifyBuild`, a halt or pause flag that was not a boolean (`"true"`) was read as open, and a `null` entry made the quoting node's lookup throw. Now the type of every field read is checked against THORNode's own types: `inbound_addresses` (each entry an object with a string `chain`; `address`, `router`, `dust_threshold` strings and `halted`, `global_trading_paused`, `chain_trading_paused` booleans when present), `vaults/asgard` (`status`, `pub_key`, `addresses[].chain`, `addresses[].address`), `mimir` (every value a number or a string; a vault flag an int64) and `lastblock` (`thorchain` a non-negative int64). One such field anywhere in an answer skips a confirming node (the provider's and `verifyBuild`'s) and makes the quoting node unavailable, so the next `nodeUrl` host is asked; with none left the existing refusals apply ("inbound addresses unavailable from every node", before broadcast "cannot refresh inbound addresses before broadcast"). No new refusal texts.
  
  Existing refusal texts are unchanged. New ones: "no confirming node is within 50 blocks of the quoting node's THORChain height (behind or unreachable) — refused until one catches up", "a second node lists the inbound vault as RetiringVault, not ActiveVault — refused" (the status as the node names it), "a second node's mimir flags the inbound vault as compromised — refused" (or `insolvent`), "the 8 s confirmation budget ran out before a second node could be asked to confirm the inbound vault — retry", "THORChain height (/thorchain/lastblock) unavailable from every node that answered the inbound addresses", and before broadcast "cannot read THORChain height (/thorchain/lastblock) before broadcast from any node that answered the inbound addresses"; from `verifyBuild`: "a THORNode lists the inbound vault as RetiringVault, not ActiveVault", "a THORNode's mimir flags the inbound vault as compromised" (or `insolvent`) and "two THORNodes within 50 blocks of the highest THORChain height they report could not confirm the inbound vault (behind or unreachable)".

### Patch Changes

- Updated dependencies [b1ac0e3]
  - @anywalletkit/protocol-swap2-core@0.11.0

## 0.3.5

### Patch Changes

- Updated dependencies [6d6e801]
- Updated dependencies [ff6582a]
  - @anywalletkit/swap2-assets@0.3.0
  - @anywalletkit/protocol-swap2-core@0.10.3

## 0.3.4

### Patch Changes

- Updated dependencies [10e06dc]
  - @anywalletkit/swap2-assets@0.2.3
  - @anywalletkit/protocol-swap2-core@0.10.2

## 0.3.3

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

- f868ce2: `thorchainPins().verifyBuild` requires the build's memo to be the canonical memo byte for byte (scan 2026-10-30, F2). It rebuilt the canonical memo from the app's request but then dropped it, so a remote build whose memo named another output asset on the same chain (e.g. `ETH.USDC` instead of `ETH.ETH`) with the right recipient and limit was signed. The server's local provider already emits only canonical memos, so honest EVM router and Tron deposit corridors are unchanged.
- Updated dependencies [9e27fc6]
  - @anywalletkit/protocol-swap2-core@0.9.0

## 0.3.0

### Minor Changes

- 88a4582: A remote stub's deposit-address and plain-value routes need the app's opt-in (scan 2026-10-28, F9). The pins applied only to builds with calldata, so a pinned calldata stub (LI.FI, CCTP, Uniswap, Balancer, wrap, USDT0, Chainflip) could answer with `depositAddress` = the backend's address, or a plain value send, and the engine paid it.
  
  - **Core / router:** `remoteProvider({depositAddressRoutes: true})` (also a `RemotePins` field) opens a stub to routes that pay an address its backend names. Without it, the engine refuses such a build and `remotePinRefusal` drops such a quote in the router and the single-provider path, on every chain. The router keeps the flag in its snapshot.
  - **NEAR Intents:** new `nearIntentsPins` — no call targets, no spenders, `depositAddressRoutes: true` (1Click deposit addresses are minted per quote).
  - **THORChain:** `thorchainPins()` set `depositAddressRoutes`: the Tron vault is the one `verifyBuild` confirms with two THORNodes.
  - **Chainflip:** `chainflipPins` set `depositAddressRoutes` and carry `verifyQuote: chainflipVerifyQuote`, the provider's own decode on the device: an EVM vault call on the pinned Vault, or a Tron send to the pinned Tron Vault whose note names the app's destination, refund address and a minimum price that guarantees the quoted minimum, with no DCA, boost, broker fee or affiliates; and `verifyBuild` requires the Tron note to go as hex bytes.
  
  **Breaking:** a remote stub without `depositAddressRoutes` gets no deposit-address or plain-value route — spread `...nearIntentsPins` into your NEAR Intents stub (THORChain's and Chainflip's pins already carry it); a remote Chainflip quote that fails `chainflipVerifyQuote` is refused. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

### Patch Changes

- Updated dependencies [834c24d]
- Updated dependencies [88a4582]
- Updated dependencies [12fc609]
  - @anywalletkit/core@0.7.0
  - @anywalletkit/protocol-swap2-core@0.8.0
  - @anywalletkit/swap2-assets@0.2.2

## 0.2.0

### Minor Changes

- 6114029: The router an EVM-source swap calls and approves must be one of the pinned `THORCHAIN_ROUTERS` (Ethereum, BSC, Avalanche, Base — reported identically on 2026-10-28 by two node operators; `trustedRouters` adds more), and the inbound vault must be reported by a **second THORNode** at quote time and again right before broadcast: a disagreeing or silent second node refuses the swap. Before, the router, spender and vault came from one host and were "confirmed" against that host's own snapshot. **Default hosts are now Liquify's gateway and the IBS team's node** (the documented fallback `thornode.thorchain.network` no longer resolves; Nine Realms is retired). With one custom `nodeUrl`, the default nodes confirm it unless `confirmNodeUrl` names another node; a quote is refused when no second node answers or one disagrees. **Node URLs must be `https:`** (`allowInsecureNodeUrl` for local development). `thorchainPins()` is the app's side of a remote stub: the pinned routers as call targets and spenders, and a `verifyBuild` that confirms the vault in the router call with two nodes and checks the asset, input and memo (destination, refund, limit, affiliate) against the app's own request.
  
  **Breaking:** a quote is refused when no second node confirms the vault (with one configured `nodeUrl`, the default nodes or `confirmNodeUrl`; a local mock needs a second mock in `confirmNodeUrl`); nodes must be https (`allowInsecureNodeUrl`); the default nodes are now Liquify and IBS; a router outside `THORCHAIN_ROUTERS` (extend it with `trustedRouters`) is refused. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

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
- 6568e08: Renames: the base of every swap2 error is now `Swap2Error`; the pinned derivation vectors are exported as `derivationVectors` and shipped as `vectors/derivation.json` (values unchanged). The approvals module drops its policy-engine rule set and its `Policy` / `PolicyRule` / `PolicyContext` types — the kit's policies treat revokes as `kind: 'revoke'` on their own; `isRevokeCalldata` and `isUnlimitedAmount` stay. THORChain's default `clientId` is `anywalletkit`.
- 6c43761: THORChain no longer drops out of the route list when its own fees exceed the caller's slippage. `tolerance_bps` sets the memo limit from the pool's feeless spot output, so whenever the liquidity, outbound and affiliate fees came to more than the slippage (500 USDC Base → BTC at 1%: about 1.7%), THORNode refused the quote ("emit asset … less than price limit …"). The provider now makes one retry on the same node with `liquidity_tolerance_bps` set to the caller's slippage. THORNode measures that from the expected output after fees, so the memo limit becomes expected × (1 − slippage): the same floor every other provider quotes and `validQuote` enforces. For destinations with more than 8 decimals the retry asks 1 bp tighter, because the limit is rounded down in 1e8 units. Quotes where the fees fit inside the slippage still take a single request and are unchanged. The memo limit is still read from the node's memo and enforced on-chain, the caller's `minAmountOut` still has to be met, and if THORChain's fees alone (affiliate share included) exceed 5% there is no route, with the reason "THORChain fees X% — too expensive at this amount". A configured affiliate, which used to leave the memo limit above the expected output on accepted quotes, triggers the same retry. Two more cases used to return no quote without saying why and now give a named reason: a memo limit below the slippage floor, and a slippage outside 0–500 bps.
- bdc77c2: With a caller slippage the quote is asked with `liquidity_tolerance_bps` in a single request: LIM = expected output after THORChain's fees × (1 − slippage), the floor every other provider quotes. Previously the first request used `tolerance_bps` (measured from the feeless spot), which left only (slippage − fees) of room when fees fit and needed a retry when they did not. The 5% fee cap now reads the node's `fees.total_bps`. Quotes without a slippage keep `tolerance_bps` 300 and the adaptive widening.
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
