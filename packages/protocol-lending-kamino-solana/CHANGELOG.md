# @anywalletkit/protocol-lending-kamino-solana

## 0.3.0

### Minor Changes

- 3dbee3f: The serialized-transaction guard checks instructions, not only programs and net balances. `SerializedTxGuard.instructions` lists the shapes an operation takes — program, data prefix, optional exact length, and the accounts at given positions, compared after lookup tables are resolved — and any other top-level instruction is refused (`unexpected-instruction`). A Kamino "deposit" of 1 unit that also withdrew the wallet's whole collateral and transferred it away passed before, because the token account's net change stayed within the deposit. Every `SerializedExpectation` bound must now be a non-negative bigint (`invalid-expectation`, refused before any RPC call; a negative minimum read as permission to lose that much), `tokenIn.maxAmount` caps what the wallet may receive (`token-in-excess`), and `getAccountInfos(addresses)` reads raw accounts for modules that check a provider against the chain.
  
  Kamino transactions are checked against the instructions each operation takes, with the wallet, its vanilla obligation, the configured market or vault, the reserve and mint the call names, the wallet's own token accounts and this vault's farm pinned. The guard's bounds come from the chain, read through the account: a vault's share price from its state and the reserves it invests in (the API's `tokensPerShare` must be within 1 %), the wallet's shares from its shares account and farm stake, a Lend `'max'` withdraw or repay from the obligation (debt with the reserve's accrued interest), and the first-deposit allowance from whether the obligation's account exists. The reserve the API names must be this market's and lend the token. A borrow pays out at most what was asked. Figures the API reports are refused when signed (`fromDecimalString` takes no sign) or when they disagree with the chain. **Writes now need an account with `getAccountInfos` — `@anywalletkit/wallet-solana` 0.4 or later.** Vault `withdraw({ amount: 'max' })` passes the exact share count: the API refuses `WITHDRAW_ALL` (now deprecated) as above u64. The live API's obligation list (`obligationAddress`, raw `state`) is read for the obligation's address; its per-token legs are empty in that shape, so `getPosition()` totals come back empty from it. Chain decoders (`decodeVault`, `decodeReserve`, `decodeObligation`, `decodeFarmUser`), `vaultTokensPerShareWad`, `debtNow`, the rule builders (`marketRules`, `vaultRules`) and `associatedTokenAddress` / `farmUserState` are exported.
  
  **Breaking:** Kamino writes and their quotes need an account with `getAccountInfos` — upgrade `wallet-solana` together with the module; an API `tokensPerShare` more than 1 % from the chain's share price is refused; `WITHDRAW_ALL` is deprecated and Kamino's API now refuses it (use the vault's `withdraw({ amount: 'max' })`); `SerializedTxGuard` bounds must be non-negative bigints (`invalid-expectation`). Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

## 0.2.2

### Patch Changes

- b1350b4: Every type a public signature uses is exported, so the API reference documents it and apps can name it: the provider config types (`LifiSwap2Config`, `BalancerSwap2Config`, `NearIntentsSwap2Config`, `FyndSwap2Config`, …), the explorer client options in history-evm (`EtherscanClientOptions`, `AlchemyClientOptions`, `BlockscoutClientOptions`), `Swap2ExecutionPhase`, the Omniston client shapes, and the row / view types the chain packages already expose through their methods. Type-only additions, plus the account-meta role constants of native SOL staking (`READONLY`, `WRITABLE`, …). Renames on export: Aave and Morpho activity `Action` → `AaveActivityAction` / `MorphoActivityAction`; conformance `ProtocolCtor` / `WriteProtocolCtor`; history-evm `RawRow`.
- Updated dependencies [eb14cb5]
  - @anywalletkit/core@0.6.1

## 0.2.1

### Patch Changes

- 4b5922a: Kamino API calls time out (`timeoutMs`, default 15 s; also the third argument of `KaminoApi`). A silent API hung every read and every write's build step.
- 4b5922a: The first-deposit allowance (SOL the guard lets a Lend deposit spend on the obligation's rent, 0.045 SOL by default) is granted only when the wallet's vanilla obligation in the market does not exist. It used to be granted whenever the obligations API failed — a guess that widened what the transaction may take — and withheld whenever any obligation existed, a Multiply one included, although the deposit goes through the vanilla one. An API failure now refuses the deposit; `vanillaObligation(user, market)` (exported) derives the obligation the program uses.
- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- Updated dependencies [f743c06]
- Updated dependencies [f743c06]
- Updated dependencies [d82e140]
- Updated dependencies [f743c06]
- Updated dependencies [398129f]
  - @anywalletkit/core@0.6.0

## 0.2.0

### Minor Changes

- fa29c4e: Kamino vault deposits keep the shares in the wallet by default (`skipFarm` now defaults to `true`), so the guard proves the shares arrive. Staked in the vault farm the shares never reach the wallet and the guard could only bound what leaves it: an API transaction that simply transferred the deposit elsewhere passed. Pass `skipFarm: false` to stake in the farm as the Kamino app does, knowing that leg relies on the API.

### Patch Changes

- 431196e: The vault's description from the Kamino API is checked before it shapes the wallet guard: it must be the configured vault on the kVault program, its shares mint must be the PDA the program derives (`["shares", vault]`), its asset must be the configured `asset` (new option), and its mint decimals must match the chain when the account can read mints. `supply` needs the asset named (`token` or `asset`), so a changed API answer can no longer make the wallet deposit another token or let a withdraw move any token out.
- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
  - @anywalletkit/core@0.5.0

## 0.1.6

### Patch Changes

- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1

## 0.1.5

### Patch Changes

- 80d6451: Earn vault withdrawals pass the wallet's guard. `withdraw` / `quoteWithdraw` declared only the asset coming in, so the share burn out of the wallet's share account read as an undeclared drain and wallet-solana refused every withdrawal of unstaked shares (`token-drain`). The expectation now also allows exactly the shares being redeemed to leave (`maxTokenOut` on the share mint); every other outflow is still refused. Audit 2026-10-25, #1.3.
- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- Updated dependencies [07db4c1]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
  - @anywalletkit/core@0.4.0

## 0.1.4

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2

## 0.1.3

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/core@0.3.1

## 0.1.2

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
  - @anywalletkit/core@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
  - @anywalletkit/core@0.2.0
