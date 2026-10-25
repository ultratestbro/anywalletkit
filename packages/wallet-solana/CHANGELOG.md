# @anywalletkit/wallet-solana

## 0.1.6

### Patch Changes

- 8aa911d: `policies.maxFee` reaches `approve` (EVM) and `sendSerialized` (Solana) too. It reached only `sendTransaction`, `signTransaction` and `transfer`; an approval or a provider-built Solana transaction paid whatever fee it carried. The kit now hands those two the tightest cap as `WriteOptions.maxFee` (second argument of `approve`, third of `sendSerialized`; a tighter caller cap stays), and the accounts hold it on what they sign: wallet-evm's `approve(options, writeOptions?)` passes it to each transaction it sends (the USDT reset too), wallet-solana's `sendSerialized(base64, guard, options?)` checks the proven fee against the tighter of `transactionMaxFee` and `options.maxFee`. The kit README now lists which writes the cap covers, and no longer calls raw `approve(spender, 0)` a revoke. Audit 2026-10-25 (post-release), L2.
- 8aa911d: A Solana send whose outcome is unknown throws `BroadcastUnknownError` (`maybeSent: true`, `hash` = the transaction signature, computed locally), like EVM, Tron and NEAR. A timeout, a dropped connection, an HTTP error, an internal RPC error, or a refusal after another provider went unanswered all surfaced as generic errors, so a caller that planned again signed a second transaction with a new blockhash that could also land. A refusal (a JSON-RPC answer: preflight failure, bad signature, unhealthy node; or an HTTP 4xx other than 408: rate limit, auth) stays a clean failure. A provider list now fails over a refused broadcast too, with the same signed bytes. New `timeoutMs` in `SolanaConfig` (default 15 000 ms) bounds every request to a url provider (`AbortSignal.timeout`, a timer fallback where the runtime lacks it); a read that times out is a `NetworkError`, and a hung RPC no longer hangs the wallet. The Rpc `createRpc` returns is not a thenable (`await createRpc(...)` and an async function returning it settle, for a list too) and keeps kit's pending-request surface (`reactiveStore`). swap2 reports such a send as `Swap2MaybeSentError`. Audit 2026-10-25 (post-release), M3.
- 8aa911d: `sendTransaction` / `signTransaction` / `quoteSendTransaction` refuse the drainer shapes `sendSerialized` already refused, for every input form (kit message, kit `Transaction`, base64 wire): System `Assign` / `Allocate` / `AssignWithSeed` / `AllocateWithSeed` touching this wallet's account, a `CreateAccount` / `CreateAccountAllowPrefund` whose new account is this wallet (paying for another account is fine), `AuthorizeNonceAccount` by this wallet, a Token / Token-2022 `SetAuthority` / `UpdateTokenMetadataUpdateAuthority` / `UpdateTokenGroupUpdateAuthority`, a token `Batch` (its inner instructions are not checked), lamports moved by an instruction the description does not show as a transfer (`CloseAccount`, `WithdrawExcessLamports`, `UnwrapLamports`, `WithdrawNonceAccount`, `TransferSolWithSeed`) to anyone but this wallet, and an undecodable System / Token instruction. They throw `UnsafeTransactionError` (`code`: `core-instruction`, `sets-authority`, `closes-account`, `moves-lamports`) before anything is signed. A program the wallet signs for can still do these by CPI; `sendSerialized` proves the outcome by simulation instead. An instruction whose accounts sit in a lookup table that was not resolved is judged by its name (`describeTransaction` now reports `instruction` on such `unknown` items), so a close whose destination hides in a table is refused too. Everyday shapes still sign: transfers, burns, closes to this wallet, durable nonces, `Allocate` + `Assign` of a fresh co-signer account. New `allowAuthorityChanges` in `SolanaConfig` opts the general path out (a token launch that renounces its mint authority); `sendSerialized` stays strict regardless. Audit 2026-10-25 (post-release), H1. `describeTransaction` now decodes `CreateAccountWithSeed` as a `create-account` item (payer, derived account, lamports, owner) instead of an opaque program call.
- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1

## 0.1.5

### Patch Changes

- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- 80d6451: No signing account outlives `WalletManager.dispose()`. Every chain manager awaited between its cache check and storing the account, so: an account whose build was in flight during `dispose()` was created afterwards with a live key (a child derived from an injected seed signer kept signing); concurrent `getAccount` calls for one path built two accounts and leaked the first; a signer-built manager handed out new accounts after `dispose()`. New protected `cachedAccount()` / `signerAccount()` in core build each account once, refuse after dispose, dispose an account finished late and a derived child that never became an account. All seven chain managers use them. `describeChainModule` checks the contract (one account under concurrent calls, none after dispose). Audit 2026-10-25, #3.
- 80d6451: `policies.maxFee` now holds for the transaction that is signed, not only for the quote. The kit compared the cap with `quoteSendTransaction` (an EVM estimate of 21 000 gas) while the account signed its own gas limit with headroom (25 200 gas), so a 22 000 000 wei cap let a 25 200 000 wei transaction through. New `WriteOptions { maxFee }` in core is an optional second argument of `sendTransaction`, `signTransaction` and `transfer`; every chain package checks the tighter of it and its configured `transactionMaxFee` / `transferMaxFee` on what it signs (`feeLimit()` helper), and the kit passes the tightest matching policy cap through it after the quote check. A write whose quote fits but whose signed worst case does not is now refused by the account after `confirm`, with the chain package's own error (EVM: `Error('Exceeded maximum fee cost…')`), not `PolicyViolationError`. Audit 2026-10-25, #4.
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

- 5d7976e: Security audit 2026-10-13 fixes that had stayed on a side branch: Solana provider-tx guard refuses System Assign/Allocate, Token Batch and undecodable core instructions and checks ownership/authority in the post-state (F1, F2); tx-preview flags native value to unlabeled contracts and unverified token symbols (F5); approvals gets a strict `isRevokeCalldata` and a new `isRevokeTransaction` (F8); kit `applyPolicies` resolves or refuses an unknown EVM chain (F4); NEAR caps token storage deposits (F12); TON checks the jetton wallet's owner and master (F13); EVM signing detects the chain before the mismatch check and strips EIP-712 array types linearly (F16, F17); near-intents strips control characters from logs (F18).
- 4b6d97f: No secret is an object property anywhere. `Wallet` no longer keeps the seed phrase string: it turns the phrase into the 64-byte seed in the constructor, hands each chain manager a copy, and `dispose()` zeroizes it and refuses later calls; `new Wallet(seedBytes)` and managers built from seed bytes are accepted (copied). `LocalSigner` keys and seeds and `WalletManager` seeds live in module WeakMaps, so `console.log`, `JSON.stringify`, `util.inspect` and crash reporters see only public fields; `LocalSigner.toJSON()` is the public view. Accounts get leaf signers (`LocalSigner.leafFromSeed`, `deriveLeaf`) that hold only their own key, never a copy of the master seed. Before: `JSON.stringify(account)` contained the private key and the master seed, and `console.log(wallet)` printed the phrase. The conformance chain suite now walks every property reachable from a manager and an account and fails if a key, the seed or the phrase is found. Manager constructors take `string | Uint8Array | Signer`.
- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- f54f2cd: `WalletAccountSolana.sign` refuses, with `MessageIsTransactionError`, any "message" whose bytes decode exactly (every byte consumed) as a legacy / v0 / v1 compiled transaction message, or as a wire transaction, that lists this account among its required signers — such a signature would be a valid on-chain transaction approved without transaction review. Everything else is signed raw exactly as before (text, nonces, `\xffsolana offchain`-prefixed messages, transactions where this key is not a required signer). New exports: `isSolanaTransactionPayload(bytes, signer)`, `classifySolanaMessage(bytes, signer)` (`'transaction' | 'offchain' | 'text' | 'binary'`, for approval UIs), `hasSolanaOffchainHeader`, `isReadableText`, `SOLANA_OFFCHAIN_MESSAGE_PREFIX`.
- 6a78e14: New provider `@anywalletkit/protocol-swap2-jupiter`: same-chain Solana swaps through Jupiter's Swap API V2 Router path (`GET /swap/v2/build`, Metis routing, no Jupiter swap fee; keyless at 0.5 RPS or an `apiKey` sent as `x-api-key`). Nothing from the API is used unchecked: only Jupiter v6 and token / system / ATA / compute-budget instructions, the taker as the only signer, no tip, and the swap instruction's own arguments (`route_v2` / `shared_accounts_route_v2`) decoded — input amount, quoted output, slippage and a zero platform fee must equal the request. The v0 transaction is assembled locally with the response's lookup tables; the compute budget is ours (limit = 1.2× a simulation when `rpcUrls` is given, price capped by `maxComputeUnitPrice`). The account executes it through its serialized-transaction guard and its own RPC.
  
  `wallet-solana`: the serialized-transaction guard counts the wallet's own wrapped-SOL token accounts as its SOL. Aggregator routes close the wallet's wSOL account, which also unwraps wSOL the wallet already held; that used to be refused as a token drain (live 2026-10-23: every large mainnet wallet probed held some wSOL), and a SOL output could not tell the wallet's own unwrapped wSOL from swap proceeds — now both are exact.
  
  `conformance`: `createMockAccount({serialized: true})` exposes swap2's `sendSerializedTransaction` hook; the swap2 behaviour suite checks serialized legs (the fixture's `serialized` decoder must accept what would be signed, and the account must execute exactly the reviewed bytes with the engine's balance expectation).
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
  - @anywalletkit/core@0.3.0

## 0.1.1

### Patch Changes

- 82464d8: `WalletManager` keeps the 64-byte seed, never the mnemonic string: a phrase passed to a constructor is stretched there and dropped (strings cannot be zeroized, `Uint8Array`s can). Chain managers read it through `seedBytes()`; the base `dispose()` zeroizes it.
- 5993b62: A structured simulation error is named instead of crashing the error formatter. `@solana/kit` parses every JSON integer in an RPC response as a bigint, so `{InstructionError: [2n, {Custom: 6001n}]}` made the plain `JSON.stringify` throw "Do not know how to serialize a BigInt" — and that message replaced the real on-chain failure (Solana USDe → SOL via LI.FI in the Oct 16 funded run). Both `simulateWire` and the serialized-transaction check now format the error with a bigint-safe replacer (SDK-134).
- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
  - @anywalletkit/core@0.2.0

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`anywalletkit` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @anywalletkit/core@0.1.0
