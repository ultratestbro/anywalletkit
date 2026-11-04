---
"@anywalletkit/protocol-approvals-evm": minor
"@anywalletkit/tx-preview-evm": patch
---

zkSync Era (eip155:324) has two live Permit2 contracts: the CREATE2 one (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) and the one Uniswap documents there (`0x0000000000225e31D15943971F47aD3022F714Fa`). `protocol-approvals-evm` used to know only the CREATE2 one, so on zkSync Era it missed Permit2 allowances on Uniswap's contract and did not recognise approvals or revokes on it in activity. It now handles both:

- Approvals scans pick up `Approval` / `Permit` / `Lockdown` events from both contracts and read each allowance on the contract that holds it. Every Permit2 approval now carries `permit2`, the contract it lives on (new `EvmApproval` type). For an allowance on zkSync Era's own Permit2, `@<contract>` is added to the end of its `id`, so the same pair on both contracts is reported as two approvals. Ids of approvals on the CREATE2 Permit2 do not change.
- `revoke` / `buildRevokeTransaction` send `lockdown` to the approval's own Permit2. `revokeAll` sends one `lockdown` per contract. A `permit2` that is not a Permit2 contract on the approval's chain is refused with `invalid-approval`.
- `isRevokeTransaction(tx, { chainId })`: with the new `chainId` option, a `lockdown` sent to any Permit2 of that chain counts as a revoke. Without `chainId` it behaves as before (CREATE2 Permit2 only).
- Activity labels Permit2 `approve` / `lockdown` calls on zkSync Era's own Permit2, and titles an ERC-20 approve of it "for Permit2".
- New exports in `STANDARDS`: `PERMIT2_ZKSYNC_ADDRESS`, `PERMIT2_ADDRESSES`, `permit2AddressFor(chainId)`, `permit2AddressesFor(chainId)` and `isPermit2Address(address, chainId)`.

`tx-preview-evm` now labels calls to zkSync Era's Permit2 "(Permit2)" instead of "(Permit2 signature)". It already classified them as Permit2 approvals.
