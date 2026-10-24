# @anywalletkit/protocol-swap2-thorchain

## 0.1.3

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [6b164bd]
- Updated dependencies [65c3bca]
  - @anywalletkit/protocol-swap2-core@0.3.1
  - @anywalletkit/core@0.3.1
  - @anywalletkit/swap2-assets@0.1.3

## 0.1.2

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- 6568e08: Renames: the base of every swap2 error is now `Swap2Error`; the pinned derivation vectors are exported as `derivationVectors` and shipped as `vectors/derivation.json` (values unchanged). The approvals module drops its policy-engine rule set and its `Policy` / `PolicyRule` / `PolicyContext` types — the kit's policies treat revokes as `kind: 'revoke'` on their own; `isRevokeCalldata` and `isUnlimitedAmount` stay. THORChain's default `clientId` is `anywalletkit`.
- 6c43761: THORChain no longer drops out of the route list when its own fees exceed the caller's slippage. `tolerance_bps` sets the memo limit from the pool's feeless spot output, so whenever the liquidity, outbound and affiliate fees came to more than the slippage (500 USDC Base → BTC at 1%: about 1.7%), THORNode refused the quote ("emit asset … less than price limit …"). The provider now makes one retry on the same node with `liquidity_tolerance_bps` set to the caller's slippage. THORNode measures that from the expected output after fees, so the memo limit becomes expected × (1 − slippage): the same floor every other provider quotes and `validQuote` enforces. For destinations with more than 8 decimals the retry asks 1 bp tighter, because the limit is rounded down in 1e8 units. Quotes where the fees fit inside the slippage still take a single request and are unchanged. The memo limit is still read from the node's memo and enforced on-chain, the caller's `minAmountOut` still has to be met, and if THORChain's fees alone (affiliate share included) exceed 5% there is no route, with the reason "THORChain fees X% — too expensive at this amount". A configured affiliate, which used to leave the memo limit above the expected output on accepted quotes, triggers the same retry. Two more cases used to return no quote without saying why and now give a named reason: a memo limit below the slippage floor, and a slippage outside 0–500 bps.
- bdc77c2: With a caller slippage the quote is asked with `liquidity_tolerance_bps` in a single request: LIM = expected output after THORChain's fees × (1 − slippage), the floor every other provider quotes. Previously the first request used `tolerance_bps` (measured from the feeless spot), which left only (slippage − fees) of room when fees fit and needed a retry when they did not. The 5% fee cap now reads the node's `fees.total_bps`. Quotes without a slippage keep `tolerance_bps` 300 and the adaptive widening.
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
- Updated dependencies [0d68fda]
- Updated dependencies [6568e08]
- Updated dependencies [06cecff]
- Updated dependencies [24b888a]
- Updated dependencies [bdc77c2]
- Updated dependencies [4fcb9b6]
- Updated dependencies [d08e37e]
  - @anywalletkit/core@0.3.0
  - @anywalletkit/protocol-swap2-core@0.3.0
  - @anywalletkit/swap2-assets@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
- Updated dependencies [412164a]
- Updated dependencies [f427dec]
- Updated dependencies [7004ecf]
- Updated dependencies [e0edbf6]
- Updated dependencies [29af9d6]
  - @anywalletkit/core@0.2.0
  - @anywalletkit/protocol-swap2-core@0.2.0
  - @anywalletkit/swap2-assets@0.1.1

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`anywalletkit` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @anywalletkit/core@0.1.0
  - @anywalletkit/protocol-swap2-core@0.1.0
  - @anywalletkit/swap2-assets@0.1.0
