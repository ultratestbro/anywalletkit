# @anywalletkit/protocol-approvals-evm

## 0.5.0

### Minor Changes

- b449d15: Revokes are classified by the token's standard. `revoke()` and `revokeAll()` ask an `'erc20'` approval's token for ERC-165 (`supportsInterface(0x80ac58cd)`) before sending `approve(spender, 0)`, and refuse (`invalid-approval`) when it is an ERC-721 — there that call approves the spender for token #0; a token without ERC-165 is revoked as before, and a failed read sends nothing (`source-failed`). `isRevokeTransaction(tx, { targets })` takes the scan's approvals, a map from address to standard, or bare addresses (`RevokeTargets`): `approve(spender, 0)` is a revoke only on an ERC-20 target, `approve(0x0, id)` and `setApprovalForAll(operator, false)` on an NFT or bare-address target, and **without `targets` only a Permit2 `lockdown` is a revoke** (an `approve(x, 0)` without targets used to pass).
  
  **Breaking:** `isRevokeTransaction` without `targets` is true only for a Permit2 `lockdown`, and a bare-address target no longer makes `approve(x, 0)` a revoke; `revoke()` / `revokeAll()` refuse an `'erc20'` revoke of an ERC-721 (`invalid-approval`) after an ERC-165 read through the protocol's provider (`provider-required` without one, `source-failed` when the read fails); `buildRevokeTransaction()` does not check, so run your own ERC-165 read before you batch its output. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

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

## 0.4.7

### Patch Changes

- Updated dependencies [eb14cb5]
  - @anywalletkit/core@0.6.1

## 0.4.6

### Patch Changes

- d82e140: `policies.maxFee` now reaches Tron's `signRaw` (second argument), an account's `revokeDelegation` (its only argument) and swap2's `sendSerializedTransaction` hook (third argument) as `{ maxFee }`, and the hook / approvals types say so. Under a fee cap, a write that pays a fee but cannot take one (NEAR `signBuilt`, Solana `signCompiled` / `signTransactionMessage`, name-guarded helpers) is refused instead of signed unchecked; off-chain signatures (messages, typed data, permits) are not affected. The conformance mock records the hook's options.
- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- Updated dependencies [f743c06]
- Updated dependencies [f743c06]
- Updated dependencies [d82e140]
- Updated dependencies [f743c06]
- Updated dependencies [398129f]
  - @anywalletkit/core@0.6.0

## 0.4.5

### Patch Changes

- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
  - @anywalletkit/core@0.5.0

## 0.4.4

### Patch Changes

- 8aa911d: History no longer calls a raw `approve(spender, 0)` a revoke when it may be an NFT approval. On an ERC-20 it resets the allowance, on an ERC-721 it APPROVES `spender` for token #0; the policies already read it as an approval, while history wrote "Revoked …", so a user could believe an NFT approval was withdrawn when one was granted. The kit's generic description reads it as a `revoke` only on a known ERC-20 (a transfer marked `erc20`, or the swap2-assets catalog: USDT, USDC…), otherwise as an `approve` of the spender; `approve(0x0, id)` now reads as a `revoke` (it clears an NFT approval). `describeApprovalActivity` returns a `revoke` on a token `tokens` lists with `decimals` above 0 (or a transfer marks `erc20`), an `approve` on a known NFT, and null otherwise so the kit's catalog decides; pass `tokens` with `decimals` to keep the module's labels on ERC-20 revokes. Audit 2026-10-25 (post-release), M5.
- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1

## 0.4.3

### Patch Changes

- 80d6451: Lido, SSV, Mellow and Approvals read over a list of RPCs. They take the account's RPC from wallet-evm's config, where `provider` may be a list (the documented failover form); they handed that list to viem's `custom()`, which needs one EIP-1193 provider, so every read failed with `Cannot read properties of undefined (reading 'bind')`. A list now becomes a `fallback` transport, as in wallet-evm, Aave and Morpho, and each module's own `provider` option accepts a list too. Audit 2026-10-25, #1.4.
- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- 80d6451: Raw `approve(spender, 0)` calldata is no longer a revoke to the policy engine. On an ERC-20 it zeroes an allowance, on an ERC-721 it approves `spender` for token #0, and the calldata cannot tell them apart: read as a revoke, it skipped the spender's blocklist entry and the allowlist, so a blocklisted drainer could be granted an NFT through `sendTransaction`. It is now `kind: 'approval'` with the spender as a destination. Any single raw `approve` / `setApprovalForAll(…, true)` call is an approval (amount and `unlimited` read off the calldata; the contract called is checked too), and in a batch their spenders join the destinations. If you use an allowlist, it must now also hold the spenders of raw approve calldata (e.g. Permit2 or a router's approval address), and a swap engine's `approve(spender, 0)` cleanup reaches `confirm` as `kind: 'approval'` with amount 0. Unambiguous revokes are unchanged: `approve({amount: 0})`, `approve(0x0, tokenId)`, `setApprovalForAll(operator, false)`, Permit2 `lockdown`, `revokeDelegation()`. `ApprovalsProtocolEvm.revokeAll` with `batch: true` now revokes ERC-20 through the account's `approve` when it has one, so a blocklisted spender can still be revoked. Audit 2026-10-25, #5.
- Updated dependencies [07db4c1]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
  - @anywalletkit/core@0.4.0

## 0.4.2

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2

## 0.4.1

### Patch Changes

- 6c4f606: The account types these modules take no longer declare a public `_config`. A `wallet-evm` account keeps its RPC in a protected `_config`, so `new LidoProtocolEvm(account)` (and SSV, Mellow, Approvals) with a real `WalletAccountEvm` or `WalletAccountReadOnlyEvm` failed to type-check — only the loosely typed `wallet.registerProtocol` path compiled. The modules still pick up the account's RPC when `config.provider` is absent.
- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/core@0.3.1

## 0.4.0

### Minor Changes

- 5d7976e: Security audit 2026-10-13 fixes that had stayed on a side branch: Solana provider-tx guard refuses System Assign/Allocate, Token Batch and undecodable core instructions and checks ownership/authority in the post-state (F1, F2); tx-preview flags native value to unlabeled contracts and unverified token symbols (F5); approvals gets a strict `isRevokeCalldata` and a new `isRevokeTransaction` (F8); kit `applyPolicies` resolves or refuses an unknown EVM chain (F4); NEAR caps token storage deposits (F12); TON checks the jetton wallet's owner and master (F13); EVM signing detects the chain before the mismatch check and strips EIP-712 array types linearly (F16, F17); near-intents strips control characters from logs (F18).
- 6568e08: Renames: the base of every swap2 error is now `Swap2Error`; the pinned derivation vectors are exported as `derivationVectors` and shipped as `vectors/derivation.json` (values unchanged). The approvals module drops its policy-engine rule set and its `Policy` / `PolicyRule` / `PolicyContext` types — the kit's policies treat revokes as `kind: 'revoke'` on their own; `isRevokeCalldata` and `isUnlimitedAmount` stay. THORChain's default `clientId` is `anywalletkit`.

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
  - @anywalletkit/core@0.3.0

## 0.3.0

### Minor Changes

- 6e61b1a: Ported from plain ESM on ethers v6 to TypeScript on viem, built with tsup (ESM + CJS + d.ts). Same exports, same calldata and typed data, same error messages; the `provider` option still takes an RPC url or an EIP-1193 object. Receipt waits now time out after 180 s (viem default) instead of waiting forever; the `./package` subpath export is gone (`./package.json` stays).

### Patch Changes

- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
  - @anywalletkit/core@0.2.0

## 0.2.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`anywalletkit` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @anywalletkit/core@0.1.0
