# @anywalletkit/wallet-evm

## 0.8.0

### Minor Changes

- 56e3c33: `describeTypedData` describes every asset-granting typed-data form as a grant. Permit2 (all primary types)
  now returns `permit2` with the spender, every token / amount (with expiration and nonce for
  AllowanceTransfer), the deadline and the witness type; Seaport `OrderComponents` / `BulkOrder` is a new
  `seaport` kind with the offer and the consideration (each item's recipient); `SafeTx` returns `safeTx` with
  to / value / data / operation and the decoded inner call. New warnings: `spender-unknown` on any permit or
  Permit2 grant whose spender is not in the new `knownSpenders` option (address → label),
  `consideration-foreign` when a Seaport order pays anyone but the signer (worded as "receive nothing back"
  when nothing returns to the signer), and `safe-delegatecall` for operation 1 or an unreadable operation.
  Callers that compared the warning list of a permit with `[]` now also see `spender-unknown` unless they
  pass the spender in `knownSpenders`; code that switches on `kind` should handle `seaport`.

### Patch Changes

- 9677422: The fee-cap refusal (the account's configured maximum or the call's `maxFee`) is now a typed `FeeLimitExceededError` with `code: 'fee-limit-exceeded'`, the `fee` the transaction would pay and the `limit` it is above. The message is unchanged and the error is still thrown before anything is broadcast or returned, so a wallet can show the new fee and ask the user again instead of matching the message text.
- 867041b: `describeTypedData` no longer puts `spender-unknown` on a Permit2 grant to Uniswap's Universal Router:
  
  - New pinned table `UNISWAP_UNIVERSAL_ROUTERS` (chain id → deployments with `address`, `version`, `source`): 65 Universal Router addresses on 19 chains, taken from Uniswap's deployment files, SDK table and documentation and each checked on-chain. `permit2KnownSpender(chainId, spender)` is the lookup, `PERMIT2_ADDRESS` and `UNISWAP_UNIVERSAL_ROUTER_LABEL` the constants.
  - A Permit2 grant (any primary type) whose verifying contract is Permit2 and whose spender is a router listed for the chain in the signed domain comes back with `spenderLabel: "Uniswap Universal Router"` and without the warning. The same address on a chain where it is not listed, any other spender, a domain without a chain id, another verifying contract and EIP-2612 / DAI token permits keep the warning. Other warnings (`approve-unlimited`, `deadline-passed`, `chain-mismatch`) are unchanged.
  - `knownSpenders` keeps working and its label takes precedence. Only the Universal Router is built in; no other protocol.

## 0.7.0

### Minor Changes

- 828593e: New default fee-rate ceiling for fee fields you pass yourself. When a transaction you sign or send sets `gasPrice`, `maxFeePerGas` or `maxPriorityFeePerGas`, the account now reads the network's current quote (the higher of `eth_gasPrice` and the EIP-1559 estimate) and refuses the transaction with `UnsafeTransactionError` before signing if the rate is more than 10× that quote and more than 10 gwei. This stops a mistyped or hostile fee (for example 10,000 gwei) from being signed, while a gas spike is fine because the quote is read at signing time, and fixed prices of a few gwei on cheap chains stay under the 10 gwei floor.
  
  - Fees the account fills in itself are not checked and cost no extra RPC call.
  - Without a provider, or when the quote cannot be read, nothing is refused; for offline signing keep using `transactionMaxFee` / `transferMaxFee`.
  - Change the multiple with `maxFeeRateMultiplier` (e.g. `20`), or turn the check off with `maxFeeRateMultiplier: null` (or `Infinity`).
  - `DEFAULT_MAX_FEE_RATE_MULTIPLIER` and `MIN_FEE_RATE_CEILING_WEI` are exported.
- 701d651: New `account.waitForTransaction(hash, timeoutMs?)` on the EVM signing account: resolves once the transaction is mined successfully, throws `TransactionRevertedError` (`code: 'reverted'`, with `hash` and `blockNumber`) when it reverted; when no receipt came within `timeoutMs` (default 180 s) or the RPC failed it throws viem's error without that code (the transaction may still land). swap2's engine already calls it, when the account has it, between an ERC-20 approval and the swap that spends the allowance, so EVM swaps that need an approval now wait for the approval to be mined before the swap is estimated and sent, instead of racing it. Nothing to change in apps; expect the approval step of a swap to take one block longer.

### Patch Changes

- f2d2e4f: After a successful broadcast, `sendTransaction` / `transfer` now always return the hash of the bytes the account signed (EVM: keccak256 of the signed transaction; Tron: the signed `txID`), not the id the RPC node echoes back. An honest node echoes the same value, so nothing changes in practice; a buggy or hostile node can no longer point the app's tracking and receipt at a different transaction.
- 2e5fcf4: The fee-rate check on caller-set fees now waits at most `FEE_QUOTE_TIMEOUT_MS` (5 seconds, exported) for the network's fee quote. If the RPC does not answer in time the check is skipped, as it already was for an unreadable quote, so `signTransaction` of a fully specified transaction no longer hangs on a provider that never answers. Note that with a provider configured, signing a transaction with caller-set fees makes two read calls (`eth_gasPrice` and the latest block) for this check.
- 7c2f089: `maxFeeRateMultiplier` is now validated when the signing account is created: it must be unset, `null`, `Infinity` or a number of at least 1. A value below 1, `NaN`, `-Infinity` or a non-number throws a `RangeError` (before, such values were accepted and refused fees at or near the network quote). A very large finite value (above 1,000,000, exported as `MAX_FEE_RATE_MULTIPLIER`) now means "off", like `Infinity`, instead of failing every signature with a `RangeError` from an overflow. The default (10) is unchanged.
- eb3af5f: `sendTransaction`, `signTransaction` and `quoteSendTransaction` now check that the transaction is one plain object before doing anything else. Before, a list that also carried named fields (`Object.assign([call], { to, value, gasLimit })`) could still be sent on an account with `simulate: false` when the caller set `gasLimit`, or quoted, because the send path copied it into a plain object before the check ran. It now throws `UnsafeTransactionError` on every path, without touching the RPC. Nothing to change in apps that pass `{ to, value, data }` objects.
- 204217e: The kit and the wallets now read the same amount from a raw send. For `sendTransaction` / `signTransaction` on EVM, Bitcoin, Zcash, Solana, Tron and TON, the amount `confirm` sees comes from `value` (the field the wallet signs). An `amount` field next to `value` that says something else makes the amount unknown (`intent.amount` is undefined), and an `amount` alone is no longer shown as what the transaction pays. `transfer` still reads `amount`. On the wallet side, a value given as a string is signed only when it is at most 300 characters long and has no whitespace, because the policies read no longer string. Longer or padded strings now throw `UnsafeTransactionError` (`wallet-evm` for `value` and the `transfer` amount; `wallet-btc` / `wallet-zcash` with `code: 'malformed-spend'`). Apps that pass bigints, integers or plain decimal / `0x` strings need no change; trim strings before passing them.
- 6820874: A transaction's `value` is now accepted only as a bigint, a whole number, or a string that `BigInt()` reads (decimal or `0x…`), which are the shapes the kit's policies read as the amount. Before, the wallets coerced other shapes that the policies could not read. `wallet-evm` read a one-element list or an object with `valueOf` through `BigInt()`. `wallet-btc` and `wallet-zcash` also rounded `'1e5'`, `1.4` or `[100000]` into sats or zatoshis. In each case `confirm` saw no amount while the full value was signed. These shapes now throw `UnsafeTransactionError` (BTC/Zcash: `code: 'malformed-spend'`). Apps that pass values in base units as bigints, integers or integer strings need no change. An app that passes a fractional number of sats, or a string like `'1e5'`, must round or convert it before sending. BTC `feeRate` is still rounded as before.
- f08dce7: When `provider` is an EIP-1193 object, an `eth_sendRawTransaction` error without a JSON-RPC code (viem reports it as `UnknownRpcError`, code -1), an error whose `code` is an HTTP status such as 502, or an `HttpRequestError` / `TimeoutError` thrown by another copy of viem inside the provider now ends as `BroadcastUnknownError` (`maybeSent: true`) unless its text carries a node's exact refusal words ("nonce too low", "insufficient funds for gas", "transaction underpriced", …). Before, any such text that mentioned "nonce" or "tip" read as a definite refusal. Errors with a JSON-RPC code (-32000 and the like) are read as before. Treat `BroadcastUnknownError` like a timeout: watch the hash, do not sign again.
- b269e9b: A broadcast error that a gateway or load balancer gives when its upstream node failed — JSON-RPC `-32603` (internal error) or `-32005` (limit exceeded), or any code whose message says "upstream", "gateway", "timeout" or "unavailable", including a 5xx whose body is JSON-RPC shaped — now ends as `BroadcastUnknownError` (`maybeSent: true`) unless the message carries a node's exact refusal words ("nonce too low", "transaction underpriced", "insufficient funds for gas", …). Before, a loose word such as "nonce", "tip" or "fee cap" in such a message read as a definite refusal. Ordinary `-32000` node refusals are unchanged.
- c533926: With a list of RPC urls (`provider: [a, b, …]`), a broadcast refusal from a later endpoint — "method not found", "transaction underpriced", "insufficient funds" and the like — now throws `BroadcastUnknownError` (`maybeSent: true`, with the transaction's `hash`) when an earlier endpoint was sent the same signed bytes and gave no answer (a timeout, an HTTP error). That earlier endpoint may already have passed the transaction on, so watch the hash instead of signing a new one. An "already known" answer from any endpoint is a success, a refusal when every endpoint answered is still the plain error, and "nonce too low" keeps its existing handling (the hash is looked up first). A single endpoint is unchanged.
- af7a82b: An HTTP error page (a gateway's 5xx without a JSON-RPC body) that happens to contain "already known" is no longer reported as a successful send: it now ends as `BroadcastUnknownError` (`maybeSent: true`), like any other HTTP failure. A node's JSON-RPC "already known" answer is still accepted, on any HTTP status and from any endpoint of a provider list.
- 91fe18a: A transaction is now one plain object everywhere it is signed. `wallet-evm` (`sendTransaction`, `signTransaction`, quotes and simulation), `wallet-btc` and `wallet-zcash` throw `UnsafeTransactionError` (BTC/Zcash: `code: 'malformed-spend'`) for a list or a class instance instead of reading its fields. In the kit's policies, a list that also carries named fields (`Object.assign([call], { to, value })`) has no known destination on any EVM chain (`destinationUnknown: true`, never a revoke or approval), and on Bitcoin, Zcash and other one-recipient chains any list does: an allowlist refuses it, a blocklist refuses it without a `confirm` hook. Plain lists of EVM calls for batching accounts and TON message lists are read as before. Nothing to change in apps that pass `{ to, value, data }` objects; an EVM list sent to a plain wallet-evm account (for example the approvals module with `batch: true`) now throws instead of being signed as a transaction other than the listed calls.
- e6c97b4: When `eth_sendRawTransaction` fails at the HTTP level (a gateway 5xx page, a timeout), the error is now always `BroadcastUnknownError` (`maybeSent: true`, with the signed `hash`), even when the gateway's page or the RPC URL happens to contain words like "nonce", "tip" or "insufficient funds". Before, such words could make the failure look like a clean node refusal. Node refusals are still read from the JSON-RPC error itself and stay plain errors. Nothing to change in apps.
- 4a552d4: When `provider` is an EIP-1193 object backed by another copy of viem, an `HttpRequestError` or `TimeoutError` it throws from `eth_sendRawTransaction` now always ends as `BroadcastUnknownError` (`maybeSent: true`), even when the HTTP page it carries contains a node's exact words such as "insufficient funds for gas", "transaction underpriced" or "already known". Before, viem's `UnknownRpcError` wrapper repeated that page in its own text, so the page could be read as a definite refusal, or as a successful send for "already known". Such errors are also recognised by their fields (`url` with `status` / `headers`) when a bundler renamed the class. Errors with a JSON-RPC code and plain provider errors with a node's exact words are read as before. Treat `BroadcastUnknownError` like a timeout: watch the hash, do not sign again.
- f90112a: A broadcast error with JSON-RPC code `-32002` (resource unavailable), which gateways give when their upstream node cannot be reached, is now treated like `-32603` and `-32005`: it ends as `BroadcastUnknownError` (`maybeSent: true`) unless its message carries a node's exact refusal words ("nonce too low", "insufficient funds for gas", "transaction underpriced", …). Before, a loose word such as "nonce", "tip" or "fee cap" in such a message read as a definite refusal. Ordinary `-32000` node refusals are unchanged.
- 89c63eb: An ambiguous JSON-RPC error from `eth_sendRawTransaction` is now "maybe sent". Before, any numeric error code (for example `-32603` internal error, `-32005` limit exceeded, `-32000` "upstream request timeout" from a gateway) counted as the node's refusal, so the send threw a plain error without the hash even when the node had already taken the transaction, and a retry could pay twice. Now only a node's refusal wording (nonce, underpriced, insufficient funds, …) or a request-level code (`-32700`, `-32600`, `-32601`, `-32602`, `-32003`) is a plain error; anything else throws `BroadcastUnknownError` with the signed hash. Apps that already handle `BroadcastUnknownError` / `maybeSent` (check the hash before retrying) need nothing new.
- 477f10e: Sending on a chain without EIP-1559 works without fee fields. On a network whose blocks have no base fee, `quoteTransfer` / `quoteSendTransaction` already priced the transaction at `gasPrice`, but `transfer()` and `sendTransaction()` without fee fields threw, so a transfer that quoted fine could not be sent. Now, when the transaction sets no `type` and no EIP-1559 fee field, both the quote and the send use the network's `gasPrice` and sign a legacy transaction; the fee cap applies as before. An explicit `type: 2` / `type: 4` or `maxFeePerGas` / `maxPriorityFeePerGas` on such a chain still throws, and a network error while reading fees is no longer turned into a `gasPrice` quote. Nothing to change in apps.
- Updated dependencies [0919427]
  - @anywalletkit/core@0.8.0

## 0.6.0

### Minor Changes

- 1b85326: "nonce too low" is re-signed only when the nonce is proven taken by another transaction (scan 2026-10-30, F1). After the node refused a send with "nonce too low" and said it never saw the hash, the account signed the same payload again with the next nonce — but that RPC already held the first signed bytes, so a malicious RPC could broadcast both. Now the account asks every distinct configured endpoint directly: it signs again only when at least two of them count the account's mined transactions past the nonce and none knows the first hash (any endpoint that knows it ends the send as accepted). Otherwise the send throws the new `NonceConflictError` (extends `BroadcastUnknownError`: `maybeSent`, `hash`, plus `nonce` and `nextNonce`) and the account's next send skips the refused nonce.
  
  **Breaking:** with one RPC configured, a stale `pending` nonce is no longer recovered silently — the send throws `NonceConflictError` and the caller's retry goes through. Show "the network didn't confirm — check activity, then retry". Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

### Patch Changes

- 6c035e4: A Permit2 grant is read only through the schema that gets signed (scan 2026-10-30, F4). The policies took `details` whenever the message had one, so a `PermitTransferFrom` that signs `permitted` (a large amount) could show an undeclared `details` decoy (a tiny amount of another token) to `confirm`. Now the grant field is the one Permit2 uses for the primary type (`details: PermitDetails` / `PermitDetails[]` for allowance permits, `permitted: TokenPermissions` / `TokenPermissions[]` for transfer permits), its struct must declare `token` and `amount` with Permit2's types, and `spender`, `sigDeadline` / `deadline` and `expiration` count only when declared. Any other schema is the worst case: `unlimited`, no token or amount, and an undeclared spender is an unknown destination. `describeTypedData` in wallet-evm reads Permit2 the same way and flags an unreadable schema `approve-unlimited`. Canonical Permit2 payloads (Uniswap, 1inch, witness and batch forms) read exactly as before.

## 0.5.0

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

## 0.4.1

### Patch Changes

- 0e43992: Follow-ups from a review of the modules-scan fixes against the code (2026-10-28).
  - **CCIP-Read is off** in every viem client the SDK creates: wallet-evm, approvals and the protocol modules. names-ens keeps its own filtered one. A contract's `OffchainLookup` revert no longer makes the device fetch URLs it names, LAN addresses included. Two cases were reachable: an approvals scan calls every contract that emitted an Approval naming the user, spam tokens included, and wallet-evm reads tokens the user added.
  - **networks:** `isPrivateHost` treats a host that is not printable ASCII as private. A URL parser maps `127.0.0.１`, `127。0。0。1` and `ｒｏｕｔｅｒ.ｌａｎ` to 127.0.0.1 and router.lan (IDNA), so these got past `isPublicHttpsUrl`. Names in other scripts arrive as punycode and stay public. 6to4 addresses (`2002::/16`) carry their IPv4.
  - **tokens:**
    - The look-alike danger rule now also covers more lettering: Roman numerals, small capitals from Latin Extended-D/E, enclosed letters of the supplement (🅤), Tifinagh, Vai, Deseret, Osage, Lycian, Carian, Old Italic, Warang Citi and Georgian's look-alike letters.
    - It now covers more characters that hide: C0 and C1 controls, line breaks inside a symbol, the braille blank, interlinear annotation, tag characters (ASCII smuggling) and astral format controls.
    - It reads the stored symbol as well as the raw head, so leading spaces cannot push a look-alike out.
    - Fewer false alarms: ™ ℠ ℗, the tag-sequence flag emoji and ZWNJ in Persian or Indic spelling stay a caution.
    - `foldSymbol` drops spaces after NFKD, so "USDC´" reads as USDC.
  - **names-ens:** `ipfsGateway` may be an origin (`/ipfs/<cid>` is appended, as before the fix) or a prefix ending in `/ipfs/`.
  - **approvals:** `isRevokeTransaction` never throws, and `targets` may also be a plain object or `[address, standard]` pairs.
  - **mellow:** `claimWithdrawals` claims only on pinned redeem queues, like every other queue call.
  - **swap2-core:** `remoteProvider` trims `baseUrl` and refuses a scheme-relative one (`//host`). A leading space or `//` used to get past the https check.
  - **omniston:** `createOmnistonTonValidators()` declares the validators it always returns as required, so `omnistonVerifyBuild({ ...createOmnistonTonValidators() })` typechecks.

## 0.4.0

### Minor Changes

- ef0aae1: EVM transaction `data` must be bytes or `0x`-prefixed hex of whole bytes; anything else (`'1x…'`, no prefix, `0X`, an odd length, non-hex) is refused with `UnsafeTransactionError` before simulation, description and signing, and every `accessList` storage key must be 32 bytes of `0x`-hex. viem's `hexToBytes` drops any two leading characters and pads odd lengths, so such data was signed as different calldata than the policies and `describeTransaction` read. New export `canonicalData`. In the kit, non-canonical calldata makes the write `destinationUnknown`.
- 60c1999: EIP-712: `signTypedData` refuses a uintN / intN field (nested structs and arrays included) that is not a bigint, a safe integer, or a decimal / `0x`-hex string; viem would have passed `' 115…'`, `'0X…'` or `'0b…'` through `BigInt()` and signed the maximum. `describeTypedData` reads amounts the way the signer does and shows a present but unreadable permit amount as unlimited, never as 0; `PermitBatchWitnessTransferFrom` is recognised as Permit2. A transaction `chainId` string must be decimal or `0x`-hex within 2^53 in wallet-evm (`chainIdNumber`), and the kit refuses a present but unreadable `chainId` (`PolicyViolationError`, `policy: 'chain'`) instead of treating it as absent.
- e6d0d39: `approve({ amount: 0 })` is a revoke only on an ERC-20. wallet-evm's `approve` refuses a token that reports ERC-721 through ERC-165 (`0x80ac58cd`) or has no `decimals()` (`UnsafeTransactionError`), since on an NFT approve(spender, n) approves token #n. The kit classifies `approve({ amount: 0 })` as `kind: 'revoke'` only when the token is in the swap2-assets catalog or the account's `getTokenInfo` reads it as `erc20`; otherwise it is an approval of the spender and the allowlist and blocklist apply.

### Patch Changes

- 4df03a5: The internal signing helpers (BTC `signPlan` / `signInputs` / `signSpend`, Zcash `signInputs` / `signSpend`, EVM `signHash` / `signPrepared` / `signAndBroadcast`, NEAR `signBytes`, Solana `signChecked` / `signPlan`, TON `signMessages`, Tron `signDigest`) are `#private` methods. They were private only in TypeScript, so code holding an account could call them at runtime and skip the checks the public methods run on what they sign.
- 9684dab: Availability: a token's `name()` / `symbol()` answer is read only as far as a 128-character string needs (the offset and length words, then 4 bytes per character, cut back to a UTF-8 boundary), and trailing NULs are cut by a linear walk; a megabyte of NULs before one other byte no longer freezes `getTokenInfo`. EIP-712 primary-type inference uses a set, and typed data declaring more than 256 types or 4096 fields is refused before it is walked, in wallet-evm (`inferPrimaryType`, `typedDataHash`; new exports `assertTypedDataSize`, `MAX_TYPED_DATA_TYPES`, `MAX_TYPED_DATA_FIELDS`) and in the kit's `resolvePrimaryType`.

## 0.3.1

### Patch Changes

- b1350b4: Every type a public signature uses is exported, so the API reference documents it and apps can name it: the provider config types (`LifiSwap2Config`, `BalancerSwap2Config`, `NearIntentsSwap2Config`, `FyndSwap2Config`, …), the explorer client options in history-evm (`EtherscanClientOptions`, `AlchemyClientOptions`, `BlockscoutClientOptions`), `Swap2ExecutionPhase`, the Omniston client shapes, and the row / view types the chain packages already expose through their methods. Type-only additions, plus the account-meta role constants of native SOL staking (`READONLY`, `WRITABLE`, …). Renames on export: Aave and Morpho activity `Action` → `AaveActivityAction` / `MorphoActivityAction`; conformance `ProtocolCtor` / `WriteProtocolCtor`; history-evm `RawRow`.
- eb14cb5: npm metadata: every package has a description and the `anywalletkit` keyword. The LI.FI, NEAR Intents, Omniston and THORChain packages had an empty description, so npm showed the README badge markdown in its place, and 24 packages were missing from a `keywords:anywalletkit` search. `pnpm pack:check` now refuses a package without either.
- Updated dependencies [eb14cb5]
  - @anywalletkit/core@0.6.1

## 0.3.0

### Minor Changes

- f2de8b6: The swap gate checks the order itself and the account. A gasless swap's sheet said "Signed order" without the order, and its pre-approval let any EIP-712 data on the chain through once — another order or a Permit, for any account.
  
  - `SwapApproval.source` for a typed order carries `typedData` (parsed) and `text` (pretty JSON) for the sheet.
  - `GatedOp` `evm-typed-data` requires `typedDataHash` — `typedDataHash(typed)` from `@anywalletkit/wallet-evm` (now exported), the digest the account signs; `planMatchers` compares it (`typedDataMatcher`). A plan whose order cannot be hashed is refused before the sheet opens.
  - `ReviewGate.preApprove(matchers, ttlMs, account)` binds pre-approvals to an account; a bound one passes only an op whose new `account` field names it. `SwapReviewMeta.account` and `EarnReviewMeta.account` are required and `reviewSwapPlan` / `reviewEarnPlan` always bind — pass the account in the ops your reviewed account builds.
  - `@anywalletkit/wallet-evm` is now a dependency of extension-kit.
- 9e4bcd2: EIP-7702 (type 4) transactions are simulated and gas-estimated with their `authorizationList`, so the dry run executes the delegate's code instead of the account's own. A type 4 with `gasPrice` (or on a chain that answers with a legacy gas price) is refused instead of silently becoming a legacy transaction without its authorizations, and an `authorizationList` on a transaction that is not type 4 is refused instead of dropped (`assertTxShape`, exported).

### Patch Changes

- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- 9e4bcd2: `describeTransaction` decodes the call inside an EIP-7702 (type 4) transaction. It returned only the delegation, so an `approve(spender, max)` riding in the calldata showed no spender, amount or `approve-unlimited` warning. The kind stays `eip7702-delegation`; the new `call` field says what the call is, and its token / spender / amount fields and warnings are filled as for any transaction.
- 9e4bcd2: `describeTypedData` reads more of what dApps send: a hex domain `chainId` (it was dropped, and with it the chain-mismatch warning); Permit2 SignatureTransfer messages (`PermitTransferFrom` / `PermitBatchTransferFrom`, amounts under `permitted`) are flagged `approve-unlimited` at the max amount like AllowanceTransfer ones; a DAI-style permit (`holder`, `expiry`, `allowed`) is a `permit` — `allowed: true` an unlimited approval, `allowed: false` a revoke, `expiry` 0 no deadline — instead of `generic`.
- 9e4bcd2: Sends from one account go out one at a time. Two `sendTransaction` / `transfer` calls started together both read the `pending` nonce before either was broadcast and signed the same nonce: the second replaced the first or was refused. Prepare → sign → submit now runs in a per-account queue (the nonce floor then covers the next send); a failed send does not block the next.
- eec3745: `isUnlimitedAmount` (and so `describeTransaction` / `describeTypedData`'s `approve-unlimited`) uses the SDK-wide threshold, type(uint128).max: `approve(spender, 2^255 − 1)` and Permit2's uint160 max were described as bounded approvals.
- Updated dependencies [f743c06]
- Updated dependencies [f743c06]
- Updated dependencies [d82e140]
- Updated dependencies [f743c06]
- Updated dependencies [398129f]
  - @anywalletkit/core@0.6.0

## 0.2.0

### Minor Changes

- b08c01a: `getTokenInfo(address)`: an ERC-20's decimals, symbol, name and total supply read from the contract (`bytes32` symbols decoded, strict UTF-8, no `TextDecoder`), and `upgradeable` when it sits behind an EIP-1967 / EIP-1822 / beacon / ZeppelinOS proxy. No code, an EIP-7702-delegated account or no `decimals()` throws `NotATokenError`; RPC failures are not mistaken for "not a token".

### Patch Changes

- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
  - @anywalletkit/core@0.5.0

## 0.1.6

### Patch Changes

- 8aa911d: `policies.maxFee` reaches `approve` (EVM) and `sendSerialized` (Solana) too. It reached only `sendTransaction`, `signTransaction` and `transfer`; an approval or a provider-built Solana transaction paid whatever fee it carried. The kit now hands those two the tightest cap as `WriteOptions.maxFee` (second argument of `approve`, third of `sendSerialized`; a tighter caller cap stays), and the accounts hold it on what they sign: wallet-evm's `approve(options, writeOptions?)` passes it to each transaction it sends (the USDT reset too), wallet-solana's `sendSerialized(base64, guard, options?)` checks the proven fee against the tighter of `transactionMaxFee` and `options.maxFee`. The kit README now lists which writes the cap covers, and no longer calls raw `approve(spender, 0)` a revoke. Audit 2026-10-25 (post-release), L2.
- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1

## 0.1.5

### Patch Changes

- 80d6451: `verifyTypedData` accepts the signatures `signTypedData` makes when the domain `chainId` is a string. Signing normalised `"0x89"` / `"137"` to the number 137 before hashing (so `chainId` is part of the domain, as a verifying contract computes it), while verifying hashed the domain as given — the account's own signature did not verify. Both now use one `typedDataHash()`. Audit 2026-10-25, #1.6.
- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- 80d6451: No signing account outlives `WalletManager.dispose()`. Every chain manager awaited between its cache check and storing the account, so: an account whose build was in flight during `dispose()` was created afterwards with a live key (a child derived from an injected seed signer kept signing); concurrent `getAccount` calls for one path built two accounts and leaked the first; a signer-built manager handed out new accounts after `dispose()`. New protected `cachedAccount()` / `signerAccount()` in core build each account once, refuse after dispose, dispose an account finished late and a derived child that never became an account. All seven chain managers use them. `describeChainModule` checks the contract (one account under concurrent calls, none after dispose). Audit 2026-10-25, #3.
- 80d6451: `policies.maxFee` now holds for the transaction that is signed, not only for the quote. The kit compared the cap with `quoteSendTransaction` (an EVM estimate of 21 000 gas) while the account signed its own gas limit with headroom (25 200 gas), so a 22 000 000 wei cap let a 25 200 000 wei transaction through. New `WriteOptions { maxFee }` in core is an optional second argument of `sendTransaction`, `signTransaction` and `transfer`; every chain package checks the tighter of it and its configured `transactionMaxFee` / `transferMaxFee` on what it signs (`feeLimit()` helper), and the kit passes the tightest matching policy cap through it after the quote check. A write whose quote fits but whose signed worst case does not is now refused by the account after `confirm`, with the chain package's own error (EVM: `Error('Exceeded maximum fee cost…')`), not `PolicyViolationError`. Audit 2026-10-25, #4.
- 760ca6e: Security fixes from the 2026-10-25 audit.
  
  - **No second signature on failover.** A lost broadcast answer followed by `already known` from the next RPC now resolves to the hash of the transaction already sent, instead of signing a new one with the next nonce (a double payment). `nonce too low` is re-signed only after the account has checked that the rejected hash is not on the network; when that lookup fails the send ends as `BroadcastUnknownError`. `replacement transaction underpriced` is no longer retried.
  - **The fee cap holds for what is signed.** `transferMaxFee` / `transactionMaxFee` were checked on a network quote while the caller's own `gasPrice` / `maxFeePerGas` was signed. They are now checked on the prepared transaction (gas limit × fee cap) before every signature, in `signTransaction` too, and the balance check uses the same worst-case fee. `quoteSendTransaction` prices the caller's fee fields, so the kit `maxFee` policy sees them. `TransferResult.fee` is that worst-case fee. A caller tip above the network's now lifts the fee cap with it (it used to produce a tip above the cap).
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
- 29af9d6: EIP-712 domain `chainId` sent as a string (hex "0x89" or decimal) is now hashed as a NUMBER. viem includes `chainId` in the EIP712Domain type only for numeric values, so such typed data was signed over a domain without chainId and the verifying contract rejected the signature (Omniston EVM→TON order on Polygon, 2026-10-16: registered, never filled). `WalletAccountEvm.signTypedData` normalizes (and the cross-chain guard now recognizes hex strings), the swap2 engine normalizes before handing typed orders to any signer, and the Omniston provider returns typed data with a numeric chainId.
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
