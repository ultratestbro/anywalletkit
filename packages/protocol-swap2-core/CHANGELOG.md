# @anywalletkit/protocol-swap2-core

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
