# @anywalletkit/protocol-swap2-jupiter

## 0.2.7

### Patch Changes

- Updated dependencies [b1350b4]
- Updated dependencies [eb14cb5]
  - @anywalletkit/protocol-swap2-core@0.6.1
  - @anywalletkit/core@0.6.1
  - @anywalletkit/swap2-assets@0.2.2

## 0.2.6

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

## 0.2.5

### Patch Changes

- Updated dependencies [6dde4e4]
- Updated dependencies [b08c01a]
- Updated dependencies [e9cc028]
- Updated dependencies [a354990]
- Updated dependencies [0d0e46e]
  - @anywalletkit/swap2-assets@0.2.0
  - @anywalletkit/core@0.5.0
  - @anywalletkit/protocol-swap2-core@0.5.0

## 0.2.4

### Patch Changes

- Updated dependencies [8aa911d]
- Updated dependencies [8aa911d]
- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1
  - @anywalletkit/protocol-swap2-core@0.4.1
  - @anywalletkit/swap2-assets@0.1.5

## 0.2.3

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

## 0.2.2

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2
  - @anywalletkit/protocol-swap2-core@0.3.2
  - @anywalletkit/swap2-assets@0.1.4

## 0.2.1

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [6b164bd]
- Updated dependencies [65c3bca]
  - @anywalletkit/protocol-swap2-core@0.3.1
  - @anywalletkit/core@0.3.1
  - @anywalletkit/swap2-assets@0.1.3

## 0.2.0

### Minor Changes

- 6a78e14: New provider `@anywalletkit/protocol-swap2-jupiter`: same-chain Solana swaps through Jupiter's Swap API V2 Router path (`GET /swap/v2/build`, Metis routing, no Jupiter swap fee; keyless at 0.5 RPS or an `apiKey` sent as `x-api-key`). Nothing from the API is used unchecked: only Jupiter v6 and token / system / ATA / compute-budget instructions, the taker as the only signer, no tip, and the swap instruction's own arguments (`route_v2` / `shared_accounts_route_v2`) decoded — input amount, quoted output, slippage and a zero platform fee must equal the request. The v0 transaction is assembled locally with the response's lookup tables; the compute budget is ours (limit = 1.2× a simulation when `rpcUrls` is given, price capped by `maxComputeUnitPrice`). The account executes it through its serialized-transaction guard and its own RPC.
  
  `wallet-solana`: the serialized-transaction guard counts the wallet's own wrapped-SOL token accounts as its SOL. Aggregator routes close the wallet's wSOL account, which also unwraps wSOL the wallet already held; that used to be refused as a token drain (live 2026-10-23: every large mainnet wallet probed held some wSOL), and a SOL output could not tell the wallet's own unwrapped wSOL from swap proceeds — now both are exact.
  
  `conformance`: `createMockAccount({serialized: true})` exposes swap2's `sendSerializedTransaction` hook; the swap2 behaviour suite checks serialized legs (the fixture's `serialized` decoder must accept what would be signed, and the account must execute exactly the reviewed bytes with the engine's balance expectation).

### Patch Changes

- 21e92a6: A swap the wallet cannot fund is refused in plain words: "not enough of the input token in the wallet (no token account for it)". The raw simulation error is kept after the wording.
  
  It covers Jupiter custom errors 6024 and 6025 and System Program error 1.
  
  6025 is not in Jupiter's published error table. It was confirmed on 2026-10-24: the same USDS / LINK / WBTC → USDC swaps fail with 6025 from an empty wallet and build fine from real holders.
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
