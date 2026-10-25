# @anywalletkit/protocol-swap2-core

## 0.4.1

### Patch Changes

- 8aa911d: The re-quote after a mined approval is reviewed again when it differs from what `reviewExecution` approved. When the first quote expired while the engine's approval was being mined, the second pass skipped the review and re-checked only spender, amount and `minAmountOut`, so the fresh quote's calldata, call target, deposit, memo, gas limit or a worse expected output reached the signer unseen. The engine now pins the reviewed plan (everything but timing, fee estimate, ETA and the mined approvals) and calls `reviewExecution` again with the fresh plan, `requoted: true` and empty `approvals` when anything pinned changed or `destAmount` dropped; throwing there, or the fresh quote expiring during that review, revokes the allowance exactly once and sends nothing. An unchanged or better re-quote is not asked again. A gas check that fails on the re-quote pass (the fresh call does not estimate, or the balance no longer covers it) now revokes the adopted allowance too; it was left live. New optional `Swap2ExecutionPlan.requoted`. Audit 2026-10-25 (post-release), M2.
- 8aa911d: `createSwap2Handler` seals a quote only when it passes the engine's own `validQuote` (the provider that was asked, the asked input amount, `minDestAmount` ≤ `destAmount`, the caller's `minAmountOut` and `slippageBps`, a live expiry, sane fees / ETA / reliability); otherwise the quote action answers 502. It sealed any well-formed quote, so a client that does not re-validate (anything but the SDK's `remoteProvider`) could get a sealed quote the engine would refuse. Audit 2026-10-25 (post-release), L1.
- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1
  - @anywalletkit/swap2-assets@0.1.5

## 0.4.0

### Minor Changes

- c4dc4d6: `createSwap2Handler` binds quotes and swaps to the caller (audit 2026-10-25, finding 12). A sealed quote and an intent id used to be good for any caller: one user could build another's quote, and anyone could ask about any swap (deposit addresses are public on chain), notify it or register against it.
  
  - Every quote's `intentId` leaves with an intent token appended (`<id>~<tag>`, HMAC under `sealSecret`); `track`, `claim`, `notify` and `register` refuse an id without a valid token (403), and the provider only ever sees its own id. The app, `remoteProvider` and the swap2 engine need no change: the swap id the engine hands out carries the token.
  - New `subject(context)`: the authenticated user (the Sign-In with Ethereum address, not an email). Quotes are sealed for it and tokens issued to it, so another user's quote or swap id is refused (403). Without it the token is a bearer capability for that one swap.
  - New `acceptUntokenedTrackUntil`: while moving from another backend, `track` (read-only) accepts ids without a token until that time.
  - `guard` now runs after validation and receives the validated request (`call.request`, with the provider's own intent id), so limits can depend on what is asked.
- ed99146: New `@anywalletkit/protocol-swap2-core/server`: `createSwap2Handler({ providers, sealSecret, guard })`, the server side of `remoteProvider`. Framework-free (`handle(action, body, context)` → `{status, body}`), it validates every field, seals quotes with HMAC-SHA256 and refuses `build` / `preflight` on an unsealed, altered or expired quote, passes a provider's named refusal through with URLs redacted, and requires a `guard` for authentication and rate limiting. WebCrypto, server-only (Node ≥ 20, edge runtimes); not part of the main entry, so apps never bundle it.

### Patch Changes

- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- a9a5e0a: package.json carried a second, empty `description` that overrode the real one, so npm showed the README badge line instead of the package description.
- Updated dependencies [07db4c1]
- Updated dependencies [80d6451]
- Updated dependencies [a9a5e0a]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
  - @anywalletkit/core@0.4.0
  - @anywalletkit/swap2-assets@0.1.5
  - @anywalletkit/tx-preview-evm@0.1.4

## 0.3.2

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2
  - @anywalletkit/swap2-assets@0.1.4
  - @anywalletkit/tx-preview-evm@0.1.3

## 0.3.1

### Patch Changes

- 6b164bd: The engine accepts the genesis-hash chain ids the wallet packages report (`solana:5eykt…`, `tron:0x2b6653dc`, `bip122:000000000019d6689c085ae165831e93`) as `fromChain`, `toChain` and the account's chain, and maps them to the swap2 ids (`solana:mainnet`, `tron:728126428`, `bitcoin:mainnet`). Previously `fromChain: account.chain` with a Solana, Tron or Bitcoin account found no route, and the short id failed the account-chain check, so an SDK account could not swap from those chains. `swap2ChainId()` and `SWAP2_CHAIN_ALIASES` are exported.
- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/core@0.3.1
  - @anywalletkit/swap2-assets@0.1.3
  - @anywalletkit/tx-preview-evm@0.1.2

## 0.3.0

### Minor Changes

- 0d68fda: New provider `@anywalletkit/protocol-swap2-chainflip`: Chainflip vault swaps (native BTC / ETH / SOL / TRX, USDC / USDT) from Ethereum, Arbitrum and Tron into Ethereum, Arbitrum, Solana, Tron and Bitcoin through Chainflip's public backend (no broker account, 0 bps). The encoder's output is decoded and checked before anything is signed (vault, destination chain / asset / address, amount, refund = sender, min price ≥ ours, no DCA / boost / broker fee / affiliates); fill-or-kill refunds to the sender. Tron sources are a TRC-20 transfer to the Vault with the swap as a binary note, so `UnsignedTx.memoEncoding` (`"utf8"` default, `"hex"`) is new in swap2-core and `wallet-tron` accepts `memoEncoding` on transfers and contract calls (`memoBytes` exported).
- 6568e08: Renames: the base of every swap2 error is now `Swap2Error`; the pinned derivation vectors are exported as `derivationVectors` and shipped as `vectors/derivation.json` (values unchanged). The approvals module drops its policy-engine rule set and its `Policy` / `PolicyRule` / `PolicyContext` types — the kit's policies treat revokes as `kind: 'revoke'` on their own; `isRevokeCalldata` and `isUnlimitedAmount` stay. THORChain's default `clientId` is `anywalletkit`.
- 06cecff: Swap2 status ids decode only under the current `awk1.` prefix. `getSwap2Status`, `claimSwap2` and the extension-kit swap tracker refuse any other prefix as a malformed id; an app still holding ids minted under an earlier prefix maps them to `awk1.` before calling.
- bdc77c2: `suggestSlippage(context, options?)` (also at `@anywalletkit/protocol-swap2-core/slippage`): auto slippage from the pair class (stable ↔ stable 0.1%, majors 0.5%, everything else 1%), half the provider-reported price impact (≤ 1%), a settle-time allowance for cross-chain routes (none for stable ↔ stable) and a quarter of recent volatility (≤ 1%), clamped to [5, 300] bps by default. Returns the parts so an app can show why. The app decides whether to use it and lets the user override.
- 4fcb9b6: TON deposits with a memo: `transfer({memo})` on a TON account sends it as the jetton forward-payload comment (TEP-74) or the native message comment (memo + forwardPayload together is refused), and swap2-core now executes TON jetton deposits that carry a memo through that surface, like Tron and NEAR token deposits — before, they were refused as not implemented.
- d08e37e: USDT0 no longer puts raw viem transport errors into refusal reasons or preflight errors. Those errors carry `URL: …`, which includes the key of a keyed RPC.
  
  - **USDT0:** an RPC failure becomes `usdt0: RPC for <chain> unavailable — try again`, and any other text loses its URLs.
  - **swap2-core:** new `redactUrls()`. Servers that forward refusal text to clients should pass it through this.

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- 24b888a: A caller's `slippage` decimal reaches the provider as the whole bps it names: 0.0029 is 29 bps, not 28 (0.0029 × 10 000 is 28.999…96 in floating point, and a plain floor shortened 573 of the 10 001 whole-bps values by one). Decimals between whole bps still round down, and the quote check against the decimal uses the same rule.
- Updated dependencies [5d7976e]
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
- Updated dependencies [87f9823]
  - @anywalletkit/tx-preview-evm@0.1.1
  - @anywalletkit/core@0.3.0
  - @anywalletkit/swap2-assets@0.1.2

## 0.2.0

### Minor Changes

- f427dec: Approvals no longer kill the quote (SDK-128). Mainnet USDT needed approve(0)+approve(n), 50–108 s on chain against LI.FI's 55 s / Omniston's 45 s quote TTL, and the engine then aborted with "quote expired before source broadcast" and revoked (a third tx). Two changes: the engine reads the live allowance through the new optional `account.getAllowance(token, spender)` and sends only what the chain needs — a single approve(n) for USDT when the allowance is 0, nothing when the exact amount is already in place (such an allowance is not ours and is left alone on failure), the reset only for a stale non-zero value; and when mined approvals still outlive the quote it re-quotes exactly once (new execution phase `"requoting"`), keeps the exact allowance and spends it. The second pass is bound to the same spender and amount, held to the caller's floor, not reviewed again, and never re-quotes itself; a fresh quote that moves the spender or drops the allowance revokes and aborts. Accounts without `getAllowance` keep the old reset-every-time behaviour.

### Patch Changes

- 412164a: Swap2 status ids are minted as `awk1.<provider>.<intent>[.<sourceTxHash>]` (`SWAP2_ID_PREFIX` exported).
- 29af9d6: EIP-712 domain `chainId` sent as a string (hex "0x89" or decimal) is now hashed as a NUMBER. viem includes `chainId` in the EIP712Domain type only for numeric values, so such typed data was signed over a domain without chainId and the verifying contract rejected the signature (Omniston EVM→TON order on Polygon, 2026-10-16: registered, never filled). `WalletAccountEvm.signTypedData` normalizes (and the cross-chain guard now recognizes hex strings), the swap2 engine normalizes before handing typed orders to any signer, and the Omniston provider returns typed data with a numeric chainId.
- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
- Updated dependencies [7004ecf]
- Updated dependencies [e0edbf6]
  - @anywalletkit/core@0.2.0
  - @anywalletkit/swap2-assets@0.1.1

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`anywalletkit` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @anywalletkit/core@0.1.0
  - @anywalletkit/swap2-assets@0.1.0
  - @anywalletkit/tx-preview-evm@0.1.0
