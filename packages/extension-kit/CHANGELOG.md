# @anywalletkit/extension-kit

## 0.2.0

### Minor Changes

- f2de8b6: A site on the shipped phishing list is now refused, not only warned about. `PhishingDetector.refusal(origin)` gives the reason for a listed host; `ApprovalQueueOptions.refuse` and `RouterDeps.refuse` take it and answer every request from that origin with EIP-1193 4100 (`OriginRefused` at the queue) before any approval window opens — reads, `eth_accounts` and an earlier permission included. Lookalikes and punycode still only warn. Wire both hooks; without them the behaviour is unchanged.
- f2de8b6: `eth_sendTransaction` takes the nonce after the review, not before. Two requests waiting at once used to show and sign the same nonce, so the second replaced the first or was refused. The nonce is now read after the approval under a per-account lock that also covers the broadcast, and never below the wallet's own next nonce. The fee caps signed are the ones shown; when the network outgrew them while the sheet was open (EIP-1559: base fee + tip above the shown cap; legacy: a higher gas price), the user is asked again with the new numbers (`SignApproval.repriced: true`).
- f2de8b6: The swap gate checks the order itself and the account. A gasless swap's sheet said "Signed order" without the order, and its pre-approval let any EIP-712 data on the chain through once — another order or a Permit, for any account.
  
  - `SwapApproval.source` for a typed order carries `typedData` (parsed) and `text` (pretty JSON) for the sheet.
  - `GatedOp` `evm-typed-data` requires `typedDataHash` — `typedDataHash(typed)` from `@anywalletkit/wallet-evm` (now exported), the digest the account signs; `planMatchers` compares it (`typedDataMatcher`). A plan whose order cannot be hashed is refused before the sheet opens.
  - `ReviewGate.preApprove(matchers, ttlMs, account)` binds pre-approvals to an account; a bound one passes only an op whose new `account` field names it. `SwapReviewMeta.account` and `EarnReviewMeta.account` are required and `reviewSwapPlan` / `reviewEarnPlan` always bind — pass the account in the ops your reviewed account builds.
  - `@anywalletkit/wallet-evm` is now a dependency of extension-kit.

### Patch Changes

- eec3745: `wallet_addEthereumChain` drops private / local RPC hosts (localhost, *.local, 10.x, 172.16–31.x, 192.168.x, 169.254.x, IPv6 loopback / unique-local / link-local) even over https: a page could otherwise point the extension's RPC reads at the user's router or LAN services.
- f2de8b6: `Session` with `autoLockMs: 0` ("no auto-lock") stays unlocked in Chrome. The record stored `expiresAt: Infinity`; chrome.storage keeps JSON, Infinity became `null`, and the next read took the wallet for locked right after unlock. "No auto-lock" is now stored as `expiresAt: null`. A stored record that is there but unreadable (wrong types, a key that is not 32 bytes) now locks the wallet: it is removed and `onLock` listeners run.
- f2de8b6: `SwapsStore` writes one after another. `add`, `update` and `remove` read the list, changed it and wrote it back with no ordering, so an alarm tick's `update` that read the list before a just-executed swap was added wrote the old list back: the new swap vanished and was never tracked. They now run in a queue (as `PermissionStore` does), each reading the list inside its turn. `parseSwapId` also reads the id `claimSwap2` returns, whose 4th segment is the claim hash (`destTxHash`).
- f2de8b6: The vault wipes the copies it hands to WebCrypto. Every input went through a fresh `ArrayBuffer` copy (`toArrayBuffer`), and the copies of the password, the scrypt KEK, the DEK, the passkey PRF output and each sealed plaintext (the recovery phrase) stayed in memory. They now go through `withSecretBuffer`, which zero-fills the copy once the call settles (WebCrypto copies its input when called); the PBKDF2 password bytes are wiped too.
- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- Updated dependencies [f743c06]
- Updated dependencies [f743c06]
- Updated dependencies [f2de8b6]
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
- Updated dependencies [f743c06]
- Updated dependencies [9e4bcd2]
- Updated dependencies [9e4bcd2]
- Updated dependencies [9e4bcd2]
- Updated dependencies [9e4bcd2]
- Updated dependencies [eec3745]
  - @anywalletkit/core@0.6.0
  - @anywalletkit/keyring@0.3.6
  - @anywalletkit/wallet-evm@0.3.0
  - @anywalletkit/protocol-swap2-core@0.6.0
  - @anywalletkit/swap2-assets@0.2.1

## 0.1.5

### Patch Changes

- 9dfb5bb: New `pageRequestFrom(event, window)`: a content script's message listener takes a request only when the page window itself posted it (`event.source` is the page and `event.origin` its origin). Without it an iframe on the page (an ad, an embed) could `parent.postMessage` a request that was stamped with the site's origin and shown in the approval window as the site. The example extension's content script uses it.
- a354990: TON and NEAR `sign()` refuse a 32-byte message with `MessageIsTransactionError`: both chains sign transactions over a 32-byte digest (the V5R1 signing-cell hash, sha256(borsh(tx))), so a "message" of those bytes was a valid transaction signature the policies treated as harmless. TON accounts gain `signTonProof` and `signTonConnectData`, which build the TON Connect digests from the request and their own address; the kit treats both as message signatures. extension-kit's `tonProofMessage` / `tonSignDataMessage` are documented as verification helpers.
- Updated dependencies [6dde4e4]
- Updated dependencies [b08c01a]
- Updated dependencies [e9cc028]
- Updated dependencies [a354990]
- Updated dependencies [0d0e46e]
  - @anywalletkit/swap2-assets@0.2.0
  - @anywalletkit/core@0.5.0
  - @anywalletkit/protocol-swap2-core@0.5.0
  - @anywalletkit/keyring@0.3.5

## 0.1.4

### Patch Changes

- 8aa911d: Audit 2026-10-25 (post-release), low findings L3–L7:
  
  - **backup-cloud (L3).** `iCloudKeychain().getOrCreate` runs one call at a time per keychain item, process-wide. Two at once (a double tap on "back up") both saw no key, both created one, and the second overwrote the key the first backup had just been sealed with, so that file no longer opened without its password. Each caller still gets its own copy of the key.
  - **keyring (L4).** `importMnemonic(phrase, { adoptId })` reads the id once and requires it to hold this phrase and passphrase (`{"type":"mnemonic",…}`). Before, the source took the id unread: the accounts' addresses came from the phrase passed in, while signatures used whatever the id held. A missing, different or unreadable secret is refused with `invalid-input`; a bad or taken id and a phrase already in the keyring are refused before that read (no prompt).
  - **extension-kit (L5).** `Vault.addPasskey` is refused (`invalid-input`) while the vault holds no secret. With nothing to prove the DEK against, any 32 bytes were sealed under the passkey, and every later passkey unlock handed out that wrong key.
  - **core (L6).** `assertNameUnchanged` compares addresses without case only on `eip155:*`. On other chains a case variant of a base58 address is another key, and it passed as "unchanged".
  - **networks (L7).** `rpcUrlsForSync` / `usesUserRpcSync` throw `NetworkError('not-loaded')` before `load()`. They answered from the builtin table, so a client built at cold start used public RPCs the user had turned off (`onlyOwnRpc`), and the review sheet called the RPC not custom. `listSync` / `getSync` still answer builtin-only before `load()`. A failed storage read no longer counts as an empty table: `load()` rejects and stays retryable, and no write runs on top of it (the next write used to replace the user's stored RPCs).
- Updated dependencies [8aa911d]
- Updated dependencies [8aa911d]
- Updated dependencies [8aa911d]
  - @anywalletkit/keyring@0.3.4
  - @anywalletkit/core@0.4.1
  - @anywalletkit/protocol-swap2-core@0.4.1
  - @anywalletkit/swap2-assets@0.1.5

## 0.1.3

### Patch Changes

- 95da085: Security fixes from the 2026-10-25 audit.
  
  - **A lock is never undone.** A `touch()` that read the session record before a `lock()` removed it wrote it back afterwards, leaving the wallet unlocked. `unlock` / `lock` / `touch` / `getKey` / `isUnlocked` now run one at a time, and a touch writes only when no lock happened since its read.
  - **Parallel writes keep every change.** `setSecret`, `deleteSecret`, `addPasskey`, `removePasskey`, `changePassword`, the v1 → v2 upgrade on `unlock`, `create` and `destroy` were read-modify-write without a lock, so two imports at once lost a secret. They are serialized per `Vault` (keep one `Vault` per storage area).
  - **Internal errors stay internal.** `toRelayError` passed any error's message to the dApp page, and viem's messages carry the RPC URL (often with the provider key) and the request body. It now passes `RouterError`, `ReviewDeclined`, a core `UserRejectedError` (4001) and a node's JSON-RPC error (code, node message, revert data) with URLs removed; everything else is `-32603 Internal error`, with the error handed to the new `options.log`.
  - **Bounded KDF and envelope.** An envelope could ask for any scrypt cost or PBKDF2 iteration count, so an edited vault hung or crashed the worker on unlock. New `VAULT_LIMITS` (scrypt N ≤ 2^20, r ≤ 16, p ≤ 4; ≤ 5 000 000 iterations; ≤ 1 000 secrets of ≤ 16 KiB, ≤ 32 passkeys, ≤ 4 MiB envelope) are checked before any KDF runs (`unsupported-envelope`), by the constructor for its options, and before every write.
- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- Updated dependencies [80d6451]
- Updated dependencies [bf2c90f]
- Updated dependencies [07db4c1]
- Updated dependencies [80d6451]
- Updated dependencies [a9a5e0a]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
- Updated dependencies [c4dc4d6]
- Updated dependencies [ed99146]
  - @anywalletkit/keyring@0.3.3
  - @anywalletkit/core@0.4.0
  - @anywalletkit/protocol-swap2-core@0.4.0
  - @anywalletkit/swap2-assets@0.1.5

## 0.1.2

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2
  - @anywalletkit/keyring@0.3.2
  - @anywalletkit/protocol-swap2-core@0.3.2
  - @anywalletkit/swap2-assets@0.1.4

## 0.1.1

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [6b164bd]
- Updated dependencies [65c3bca]
  - @anywalletkit/protocol-swap2-core@0.3.1
  - @anywalletkit/core@0.3.1
  - @anywalletkit/keyring@0.3.1
  - @anywalletkit/swap2-assets@0.1.3

## 0.1.0

### Minor Changes

- 48855f9: First release: the core of a Chromium (MV3) wallet extension, no UI. Vault envelope v2 (scrypt N=2^17 r=8 p=1 via `@noble/hashes`, AES-256-GCM, KDF parameters bound into the DEK box's AAD, `weak-kdf` refusal, v1 PBKDF2 envelopes re-sealed on unlock, passwords ≥ 8 characters) with passkey unlock (DEK sealed under HKDF-SHA256 of the WebAuthn PRF output); `Session` with auto-lock in `chrome.storage.session`; keyring adapters; page ⇄ content script ⇄ worker relay with sender-origin checks; `RequestRouter`, `PermissionStore`, `ApprovalQueue` (3 pending per origin, one pending `connect`, WalletConnect transport notes via `setVia`); signing classification (SIWE parsing, site EIP-7702 delegations refused), `wallet_addEthereumChain` with `eth_chainId` verification and `custom` provenance; `ReviewGate`, swap and Earn plan review, `SwapTracker`; TON Connect v2 data helpers; `PhishingDetector`, `RecipientBook` (address poisoning), WebAuthn assertion verification; structural chrome adapters with in-memory twins for tests.
- 06cecff: Swap2 status ids decode only under the current `awk1.` prefix. `getSwap2Status`, `claimSwap2` and the extension-kit swap tracker refuse any other prefix as a malformed id; an app still holding ids minted under an earlier prefix maps them to `awk1.` before calling.

### Patch Changes

- d06290f: `personal_sign` runs the EIP-4361 checks on the decoded bytes whenever they are valid UTF-8, not on the hex fallback shown for unprintable text. A sign-in message carrying hidden control characters is refused.
  
  Before, one DEL or form-feed byte turned a cross-site sign-in into an unchecked hex blob, with no cross-site, chain or expiry warning.
- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- Updated dependencies [f3b164f]
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
- Updated dependencies [0d68fda]
- Updated dependencies [6568e08]
- Updated dependencies [06cecff]
- Updated dependencies [24b888a]
- Updated dependencies [bdc77c2]
- Updated dependencies [4fcb9b6]
- Updated dependencies [d08e37e]
  - @anywalletkit/keyring@0.3.0
  - @anywalletkit/core@0.3.0
  - @anywalletkit/protocol-swap2-core@0.3.0
  - @anywalletkit/swap2-assets@0.1.2
