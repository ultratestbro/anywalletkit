# @anywalletkit/extension-kit

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
