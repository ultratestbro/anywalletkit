# @anywalletkit/tokens

## 0.1.1

### Patch Changes

- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- Updated dependencies [f743c06]
- Updated dependencies [f743c06]
- Updated dependencies [d82e140]
- Updated dependencies [f743c06]
- Updated dependencies [398129f]
  - @anywalletkit/core@0.6.0
  - @anywalletkit/swap2-assets@0.2.1

## 0.1.0

### Minor Changes

- 3cf33ef: New package: tokens users add by address, at their own risk. `inspectToken(account, address)` reads the token from the chain through the account's `getTokenInfo` (EVM contracts, Solana mints including Token-2022) and returns `{ listed }` for a catalog token or `{ info, assessment, token }`. `assessToken` lists every warning, worst first: `impersonation` when the symbol reads as a catalog token of the same chain or a native coin / major stablecoin anywhere (Cyrillic and Greek look-alikes, `$`, `₮`, fullwidth and invisible characters folded), issuer powers (`permanent-delegate`, `transfer-hook`, `non-transferable` as danger; `upgradeable`, mint / freeze authority, transfer fee, default-frozen, pausable as caution) and `unlisted` always. `TokensTable` keeps the list over any JSON storage (queued writes, a failed read stays unloaded, catalog tokens and malformed entries refused). `swapSource(token)` gives the swap options for engines with `allowUnlistedTokens`.

### Patch Changes

- Updated dependencies [6dde4e4]
- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
- Updated dependencies [0d0e46e]
  - @anywalletkit/swap2-assets@0.2.0
  - @anywalletkit/core@0.5.0
