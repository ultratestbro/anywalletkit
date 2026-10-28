# @anywalletkit/protocol-staking-lido-evm

## 0.3.9

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

## 0.3.8

### Patch Changes

- Updated dependencies [eb14cb5]
  - @anywalletkit/core@0.6.1

## 0.3.7

### Patch Changes

- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- Updated dependencies [f743c06]
- Updated dependencies [f743c06]
- Updated dependencies [d82e140]
- Updated dependencies [f743c06]
- Updated dependencies [398129f]
  - @anywalletkit/core@0.6.0

## 0.3.6

### Patch Changes

- 34c3734: `requestWithdrawal` falls back to approve + request only when the permit does not work: an error from the permit transaction's broadcast (it may have been sent), a declined signature (`UserRejectedError`) and a policy refusal now end the call instead of sending an approval and a second request. Before an approval the module checks the token balance, the queue's pause and the 100 wei minimum, and a tail chunk under 100 wei is evened out with the chunk before it.
- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
  - @anywalletkit/core@0.5.0

## 0.3.5

### Patch Changes

- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1

## 0.3.4

### Patch Changes

- 80d6451: Lido, SSV, Mellow and Approvals read over a list of RPCs. They take the account's RPC from wallet-evm's config, where `provider` may be a list (the documented failover form); they handed that list to viem's `custom()`, which needs one EIP-1193 provider, so every read failed with `Cannot read properties of undefined (reading 'bind')`. A list now becomes a `fallback` transport, as in wallet-evm, Aave and Morpho, and each module's own `provider` option accepts a list too. Audit 2026-10-25, #1.4.
- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- 8541692: Fixes from the 2026-10-25 audit: timeouts, failover and exact amounts.
  
  - **wallet-tron, wallet-near: timeouts.** Url providers had no timeout, so a node that never answered hung every call and failover never ran. Each request now times out after the new `timeoutMs` option (default 15 000; `AbortSignal.timeout`, or a timer on runtimes without it) and the next provider is tried.
  - **wallet-tron: broadcast outcome.** A broadcast without an answer is re-sent as the same signed bytes to the next provider, `DUP_TRANSACTION_ERROR` counts as accepted (it used to be reported as a failure, inviting a second transaction), and when no node answers the new `BroadcastUnknownError` (`maybeSent`, `hash` = txID) is thrown.
  - **wallet-near: broadcast outcome.** `send_tx` is never re-sent to another RPC; without a definitive answer (no response, a node timeout) it throws the new `BroadcastUnknownError` with the locally computed hash. Definitive refusals stay clean errors.
  - **wallet-tron: exact sun.** Balances went through `JSON.parse` and `Number()`, rounding above 2^53. Url providers now keep big integers exact; a custom transport that hands over an unsafe number is refused with a clear error, and a TRX transfer above 2^53 − 1 sun is refused before the node builds it.
  - **Lido, SSV, Tonstakers, Mellow:** their REST reads (APR, rewards, queue times, stats) time out after 15 s instead of hanging.
- Updated dependencies [07db4c1]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
  - @anywalletkit/core@0.4.0

## 0.3.3

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2

## 0.3.2

### Patch Changes

- 6c4f606: The account types these modules take no longer declare a public `_config`. A `wallet-evm` account keeps its RPC in a protected `_config`, so `new LidoProtocolEvm(account)` (and SSV, Mellow, Approvals) with a real `WalletAccountEvm` or `WalletAccountReadOnlyEvm` failed to type-check — only the loosely typed `wallet.registerProtocol` path compiled. The modules still pick up the account's RPC when `config.provider` is absent.
- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/core@0.3.1

## 0.3.1

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
