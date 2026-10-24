# @anywalletkit/protocol-swap2-core

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
