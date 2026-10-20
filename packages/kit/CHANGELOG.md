# @forgewallet/kit

## 0.2.0

### Minor Changes

- 32ea93a: Policies guard every write surface of an account, not only `sendTransaction` / `transfer`: `signTransaction` (fee cap, lists, confirm — a module that signs and broadcasts on its own cannot skip them), `sign` (message signatures: confirm only), and the chain-specific `sendSerialized` / `signCompiled` / `signTransactionMessage` where an account has them. `WriteIntent.method` is the new `WriteMethod` union and carries `message`.
- 99555a7: Policies guard every signing surface, not a fixed list: `signTypedData`, `signPermit`, `approve`, Tron `signRaw`, NEAR `signNep413` / `signBuilt` join the known writes, and any account method named `sign*` / `send*` / `approve*` / `revoke*` / `transfer*` is guarded unless listed in `UNGUARDED_WRITES`. Approvals (`approve`, `signPermit`, EIP-2612 and Permit2 typed data) are checked against the spender — a blocklisted or non-allowlisted spender is refused — and `confirm` receives `kind: 'approval'` with `unlimited` and `deadline`. Other typed data is `kind: 'typedData'` (confirm only). `WriteIntent` gains `kind`; `isGuardedWrite` is exported.

### Patch Changes

- 0d5d074: `buildFeed` matches intent legs to chain rows through the chain alias table: an intent journaled under the catalog id (`bitcoin:mainnet`) now owns the row a source names by genesis hash (`bip122:…`), instead of leaving a bare "send" next to a pending intent; a row already on the page still inherits its intent.
- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
- Updated dependencies [7004ecf]
- Updated dependencies [e0edbf6]
  - @forgewallet/core@0.2.0
  - @forgewallet/swap2-assets@0.1.1

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`forgewallet` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @forgewallet/core@0.1.0
  - @forgewallet/swap2-assets@0.1.0
