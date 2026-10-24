# @anywalletkit/wallet-solana

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
