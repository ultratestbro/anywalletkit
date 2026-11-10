# @anywalletkit/wallet-near

## 0.4.2

### Patch Changes

- 9677422: The fee-cap refusal (the account's configured maximum or the call's `maxFee`) is now a typed `FeeLimitExceededError` with `code: 'fee-limit-exceeded'`, the `fee` the transaction would pay and the `limit` it is above. The message is unchanged and the error is still thrown before anything is broadcast or returned, so a wallet can show the new fee and ask the user again instead of matching the message text.
- 5c928b2: `describeTransaction` describes every action of a multi-action transaction instead of letting each `ft_transfer` overwrite the last. New fields: `actions` (method, receiver, token amount, deposit and gas of each action), `nativeOutflow` (every Transfer plus every function-call deposit) and `tokenOutflows` (token units per token and recipient). `to` / `amount` / `token` / `memo` are still set when the transaction has one destination of value (a NEAR transfer, one `ft_transfer` with or without `storage_deposit`); a batch that pays several recipients, or mixes a Transfer with a token transfer, leaves `amount` / `token` unset and `to` at the receiver, so read the new fields. New warnings: `batch` (lists every action) and `deposit` (a function call attaching more than 1 yoctoNEAR to a method other than `storage_deposit`). Warnings stay informational; nothing new is refused.

## 0.4.1

### Patch Changes

- dd93115: Native NEAR staking review fixes.
  
  This is a minor release because three things change for apps: `NearUnstakeQuote.unlock` can be `null`, there is a new error code `claim-first` and a new warning code `leaves-dust`, and `stake` leaves a bigger reserve (about 0.11 NEAR instead of 0.055 NEAR), so `getMaxStakeable()` is lower and a very small account may no longer be able to stake.
  
  - `@anywalletkit/protocol-staking-native-near`: a partial unstake that would leave less than 0.001 NEAR unstaked in the pool is refused with `below-minimum`. Such a balance was sent, then never shown as a request and never claimable through the module.
  - A partial unstake that would leave less than 0.001 NEAR staked is refused with `below-minimum` too, and the message says to unstake `'all'`. Such a remainder could not be taken out by any later partial unstake.
  - The whole of a stake below 0.001 NEAR (made outside the module) can still be unstaked, with `'all'` or its exact amount, even in a paused pool. The quote carries the warning `leaves-dust`: the balance it leaves unstaked is below the claim minimum.
  - Unstake and claim no longer depend on the validator set or the epoch, which only decorate them. When those reads fail, the unstake still goes out with `unlock: null` (the quote's `unlock` type is now `UnlockEstimate | null`). Requests, balances and claims still work too: positions then carry `poolInfo: null` and no unlock estimate. Exits are always possible from a known pool, as the README says.
  - The reserve a stake leaves now covers the largest exit: an unstake that withdraws an unlocked balance first (`[withdraw_all, unstake]` in one transaction, about 0.11 NEAR of upfront gas today, up from one unstake's 0.055). Before, a user who staked the most allowed and later unstaked the rest next to an unlocked balance got `InsufficientFundsError`, with nothing saying how to get out. If the balance still cannot pay both calls (it was spent, or gas got dearer) but can pay the `withdraw_all` alone, the unstake is refused with the new code `claim-first`. Its `details.id` names the request to claim. After that claim, the unstake needs the gas of one call only. We chose a bigger reserve plus a clear refusal over quietly sending something else. Sending `withdraw_all` alone would not be the unstake the user asked for. Sending the unstake alone would lock the unlocked NEAR for 4 more epochs. The extra reserve stays on the user's own account as spendable NEAR.
  - Every `*.pool.near` pool now gets the scheduled-fee check (`get_pool_summary`, the higher of the current and the next fee), including a staking-farm build the app accepted through `codeHashes`. Before, such a build skipped the check, so a pool with a 100 % fee already scheduled read as eligible.
  - The spendable balance no longer subtracts `locked` from a `view_account.amount` that never included it. It is now `amount − max(0, storage − locked)`, because the locked balance pays for storage first. Accounts with a direct stake were capped too low, or refused everything when `locked ≥ amount`.
  - `@anywalletkit/wallet-near`: `getAccountView().available`, `getAvailableBalance()` and the transaction preflight use the same corrected rule, `amount − max(0, storage − locked)`. An account holding a locked balance is no longer told it can spend less than it can.

## 0.4.0

### Minor Changes

- 102fd4a: `signBuilt` now runs the same hard checks as `signTransaction` before it signs: the transaction must be this account's (signer and key), and a dangerous action — AddKey, DeleteKey, DeleteAccount, DeployContract, Stake, CreateAccount, global-contract actions, SignedDelegate — is refused with `UnsafeTransactionError` (`code: 'dangerous-action'`) unless the account was created with `allowDangerousActions: true`. Plain transfers and function calls sign as before, still with no node call. If your app signs prebuilt transactions that add or delete keys on purpose, set `allowDangerousActions: true` for that account.
- e5f92cf: `getTransactionReceipt` returns `undefined` while a NEAR transaction is not executed yet. It used to answer `{status: 1}` (with `raw.pending`) for a transaction the node had only received or included (`final_execution_status` NONE / INCLUDED), so an app could show a payment as done before it ran. Now: `undefined` while pending (no execution status, `NotStarted` / `Started`, or NONE / INCLUDED / INCLUDED_FINAL), `status: 1` only once it executed successfully (`SuccessValue` / `SuccessReceiptId`, no failed receipt), `status: 0` with `failure` when the transaction or any receipt failed. This matches every other chain. The exported `receiptOf()` now returns `NearReceipt | undefined`, and `raw.pending` is gone: treat `undefined` as "keep polling".

### Patch Changes

- 35c026a: `signBuilt`, `signTransaction`, `sendTransaction` and `transfer` now take one plain copy of the transaction (encoded to borsh and decoded back) before the hard checks, and sign exactly that copy. A transaction object that changes between reads — a getter on `actions`, or an `actions` array the caller edits while the account waits for the node — can no longer get a different transaction signed from the one that was checked. `signBuilt` returns the copy as `transaction`; its bytes are the same as before for every ordinary transaction, so nothing changes for apps.
- c12ae08: A `send_tx` error is now a plain `NearRpcError` only when the node clearly refused the transaction (`INVALID_TRANSACTION`, or `REQUEST_VALIDATION_ERROR` / `PARSE_ERROR`). Any other JSON-RPC error — including gateway errors that carry no NEAR error name, such as `-32000 upstream request timeout` or `-32603 Internal error` — now throws `BroadcastUnknownError` (`maybeSent: true`, with the locally computed `hash`), because the transaction may still land. Treat it like a timeout: watch the hash, do not sign again. Reads are unchanged.
- f67c685: Back-to-back NEAR sends no longer reuse a nonce. The nonce was read from the access key at `final`, which lags the block that holds the previous transaction, so a second `transfer()` / `sendTransaction()` right after the first signed the same nonce and was refused with `InvalidNonce`. The account now remembers the last nonce it broadcast (accepted or maybe sent, not after a definitive refusal) and signs at least that + 1, and it runs its sends one at a time. A nonce you set yourself, or an already-serialized transaction, is used as given. Nothing to change in apps.
- Updated dependencies [0919427]
  - @anywalletkit/core@0.8.0

## 0.3.1

### Patch Changes

- ab63422: An AddKey access-key permission must be exactly one known variant: `{ fullAccess: {} }` or `{ functionCall: { receiverId, methodNames, allowance? } }`. An empty, misspelled, unknown or doubled variant used to be encoded as FullAccess while `describeTransaction` gave no `full-access-key` warning. Now `assertWellFormed` (top level and inside a `signedDelegate`) refuses it with `malformed-action`, the encoder throws on it, and the description reads the same tag the encoder writes (a malformed permission gets a `dangerous-action` warning saying the wallet refuses it). New export `accessKeyPermissionTag`.

## 0.3.0

### Minor Changes

- 834c24d: A protocol module can no longer reach the private key. On a `Wallet` without `policies`, `getProtocol` handed the module the raw account, and `account.signer.key()` — private in TypeScript only — returned the 32-byte key, a copy of which outlived `dispose()`. Three layers now close it:
  
  - `kit`: a module always gets the restricted account. Without policies it is a wrapper with no rules: no limits, but the signer, internal helpers and the account's settings stay out of reach, as they did with `policies: {}`.
  - `core`: `LocalSigner` reads its key through a function of the module, not a method: nothing outside `@anywalletkit/core` can call it.
  - every chain account keeps its signer in a private field (`#signer`). The new `signerKind` field (`'seed' | 'key' | 'external'`) says what holds the key.
  
  **Breaking:** chain accounts (`WalletAccountEvm`, `WalletAccountSolana`, `WalletAccountTon`, `WalletAccountTron`, `WalletAccountBtc`, `WalletAccountNear`, `WalletAccountZcash`) no longer have a `signer` property, the app's own accounts included. Read `account.signerKind` instead of `account.signer.kind`; keep a reference to the `Signer` you injected if you need it.
  
  **Breaking:** a protocol module registered on a wallet without policies gets the policy wrapper instead of the raw account: it is a different object from `wallet.getAccount(chain)`, and writes through it are refused when they sign on another network than the module's chain.
  
  **Breaking:** `LocalSigner` has no `key()` method at runtime any more (it was private in TypeScript).

### Patch Changes

- Updated dependencies [834c24d]
  - @anywalletkit/core@0.7.0

## 0.2.0

### Minor Changes

- cff44a8: NEAR: a base64 borsh transaction is signed only when it re-encodes to the exact bytes given (`UnsafeTransactionError` code `non-canonical`). Borsh strings decode strictly (invalid UTF-8 throws, a leading U+FEFF is kept instead of dropped), an Option tag other than 0/1 and an unknown global-contract mode byte are refused, and every method name a transaction carries must be ASCII letters, digits and `_` (code `invalid-method`; access-key method lists and delegated actions included), every account id it names valid (code `invalid-account`). In the kit, a NEAR function call whose method name is not plain ASCII makes the write `destinationUnknown`. A BOM in front of `ft_transfer` read as an unknown method to the policies and was signed as a clean `ft_transfer` to the attacker.
- 7900e03: NEAR object transactions are validated before they are built or signed, `signBuilt` included (`UnsafeTransactionError` code `malformed-action` / `invalid-method`): every action object has exactly one known key, a function call's `methodName` is a string of the method grammar, `args` are bytes, a string or a plain object (not an array or a class instance), and `gas` / `deposit` are bigints. The borsh encoder refuses the same shapes. In the kit, an action object with more than one key, a non-string `methodName`, and `ft_transfer` / `nft_transfer` / `storage_deposit` args that are not one plain JSON object make the write `destinationUnknown`. New exports `assertWellFormed`, `isPlainObject`.

### Patch Changes

- 4df03a5: The internal signing helpers (BTC `signPlan` / `signInputs` / `signSpend`, Zcash `signInputs` / `signSpend`, EVM `signHash` / `signPrepared` / `signAndBroadcast`, NEAR `signBytes`, Solana `signChecked` / `signPlan`, TON `signMessages`, Tron `signDigest`) are `#private` methods. They were private only in TypeScript, so code holding an account could call them at runtime and skip the checks the public methods run on what they sign.

## 0.1.9

### Patch Changes

- b1350b4: Every type a public signature uses is exported, so the API reference documents it and apps can name it: the provider config types (`LifiSwap2Config`, `BalancerSwap2Config`, `NearIntentsSwap2Config`, `FyndSwap2Config`, …), the explorer client options in history-evm (`EtherscanClientOptions`, `AlchemyClientOptions`, `BlockscoutClientOptions`), `Swap2ExecutionPhase`, the Omniston client shapes, and the row / view types the chain packages already expose through their methods. Type-only additions, plus the account-meta role constants of native SOL staking (`READONLY`, `WRITABLE`, …). Renames on export: Aave and Morpho activity `Action` → `AaveActivityAction` / `MorphoActivityAction`; conformance `ProtocolCtor` / `WriteProtocolCtor`; history-evm `RawRow`.
- eb14cb5: npm metadata: every package has a description and the `anywalletkit` keyword. The LI.FI, NEAR Intents, Omniston and THORChain packages had an empty description, so npm showed the README badge markdown in its place, and 24 packages were missing from a `keywords:anywalletkit` search. `pnpm pack:check` now refuses a package without either.
- Updated dependencies [eb14cb5]
  - @anywalletkit/core@0.6.1

## 0.1.8

### Patch Changes

- 143065c: History pages no longer duplicate a transaction whose receipt rows a page boundary cut: each list is read one row ahead, a transaction that goes on past the page waits for the next page whole, and one with more rows than a page goes out with the rows that fit while the next cursor skips the rest (new optional `skip` in the cursor; old cursors still decode).
- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- Updated dependencies [f743c06]
- Updated dependencies [f743c06]
- Updated dependencies [d82e140]
- Updated dependencies [f743c06]
- Updated dependencies [398129f]
  - @anywalletkit/core@0.6.0

## 0.1.7

### Patch Changes

- 2d9fe4b: One external ed25519 key registered for several chains can no longer be made to sign another chain's transaction as a "message": TON and NEAR `sign()` refuse bytes that carry the account's public key (a Solana transaction names its signer's key), and Solana `sign()` on an external signer refuses 32-byte messages (a TON or NEAR transaction digest). TON Connect `signData` binary payloads accept whitespace in their base64, as `atob` does, and a non-integer `workChain` is refused.
- a354990: TON and NEAR `sign()` refuse a 32-byte message with `MessageIsTransactionError`: both chains sign transactions over a 32-byte digest (the V5R1 signing-cell hash, sha256(borsh(tx))), so a "message" of those bytes was a valid transaction signature the policies treated as harmless. TON accounts gain `signTonProof` and `signTonConnectData`, which build the TON Connect digests from the request and their own address; the kit treats both as message signatures. extension-kit's `tonProofMessage` / `tonSignDataMessage` are documented as verification helpers.
- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
  - @anywalletkit/core@0.5.0

## 0.1.6

### Patch Changes

- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1

## 0.1.5

### Patch Changes

- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- 80d6451: No signing account outlives `WalletManager.dispose()`. Every chain manager awaited between its cache check and storing the account, so: an account whose build was in flight during `dispose()` was created afterwards with a live key (a child derived from an injected seed signer kept signing); concurrent `getAccount` calls for one path built two accounts and leaked the first; a signer-built manager handed out new accounts after `dispose()`. New protected `cachedAccount()` / `signerAccount()` in core build each account once, refuse after dispose, dispose an account finished late and a derived child that never became an account. All seven chain managers use them. `describeChainModule` checks the contract (one account under concurrent calls, none after dispose). Audit 2026-10-25, #3.
- 8541692: Fixes from the 2026-10-25 audit: timeouts, failover and exact amounts.
  
  - **wallet-tron, wallet-near: timeouts.** Url providers had no timeout, so a node that never answered hung every call and failover never ran. Each request now times out after the new `timeoutMs` option (default 15 000; `AbortSignal.timeout`, or a timer on runtimes without it) and the next provider is tried.
  - **wallet-tron: broadcast outcome.** A broadcast without an answer is re-sent as the same signed bytes to the next provider, `DUP_TRANSACTION_ERROR` counts as accepted (it used to be reported as a failure, inviting a second transaction), and when no node answers the new `BroadcastUnknownError` (`maybeSent`, `hash` = txID) is thrown.
  - **wallet-near: broadcast outcome.** `send_tx` is never re-sent to another RPC; without a definitive answer (no response, a node timeout) it throws the new `BroadcastUnknownError` with the locally computed hash. Definitive refusals stay clean errors.
  - **wallet-tron: exact sun.** Balances went through `JSON.parse` and `Number()`, rounding above 2^53. Url providers now keep big integers exact; a custom transport that hands over an unsafe number is refused with a clear error, and a TRX transfer above 2^53 − 1 sun is refused before the node builds it.
  - **Lido, SSV, Tonstakers, Mellow:** their REST reads (APR, rewards, queue times, stats) time out after 15 s instead of hanging.
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
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
  - @anywalletkit/core@0.3.0

## 0.1.1

### Patch Changes

- 82464d8: `WalletManager` keeps the 64-byte seed, never the mnemonic string: a phrase passed to a constructor is stretched there and dropped (strings cannot be zeroized, `Uint8Array`s can). Chain managers read it through `seedBytes()`; the base `dispose()` zeroizes it.
- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
  - @anywalletkit/core@0.2.0

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / its earlier 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`anywalletkit` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @anywalletkit/core@0.1.0
