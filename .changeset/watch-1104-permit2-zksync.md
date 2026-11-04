---
"@anywalletkit/protocol-approvals-evm": minor
"@anywalletkit/tx-preview-evm": patch
---

zkSync Era (eip155:324) has two live Permit2 contracts: the CREATE2 one (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) and the one Uniswap documents there (`0x0000000000225e31D15943971F47aD3022F714Fa`). `protocol-approvals-evm` used to know only the CREATE2 one, so on zkSync Era it missed Permit2 allowances on Uniswap's contract and did not recognise approvals or revokes on it in activity. It now handles both:

- Approvals scans pick up `Approval` / `Permit` / `Lockdown` events from both contracts and read each allowance on the contract that holds it. Every Permit2 approval now carries `permit2`, the contract it lives on (new `EvmApproval` type). For an allowance on zkSync Era's own Permit2, `@<contract>` is added to the end of its `id`, so the same pair on both contracts is reported as two approvals. Ids of approvals on the CREATE2 Permit2 do not change.
- A scan `cache` entry now records the Permit2 contracts it covered (`permit2` in `CacheEntry`). On zkSync Era an entry written by an earlier release did not cover the second Permit2, so the next `getApprovals` scans that entry's whole range again once (from its `fromBlock`, keeping its candidates) instead of only the new blocks, and finds the allowances it missed. Entries on other chains are not rescanned.
- `revoke` / `buildRevokeTransaction` send `lockdown` to the approval's own Permit2. `revokeAll` sends one `lockdown` per contract. An approval without `permit2` (one kept with the core `Approval` fields only) is revoked on the Permit2 its `id`'s `@<contract>` suffix names, else on the CREATE2 one. A `permit2` that is not a Permit2 contract on the approval's chain, or that the `id` suffix contradicts, is refused with `invalid-approval`.
- `isRevokeTransaction(tx, { chainId })`: with the new `chainId` option, a `lockdown` sent to any Permit2 of that chain counts as a revoke. Without `chainId` it behaves as before (CREATE2 Permit2 only).
- Activity labels Permit2 `approve` / `lockdown` calls on zkSync Era's own Permit2, and titles an ERC-20 approve of it "for Permit2" on zkSync Era (on other chains that address is not a Permit2 and is shown as an address). `SPENDER_LABELS` still lists only the CREATE2 Permit2.
- New exports in `STANDARDS`: `PERMIT2_ZKSYNC_ADDRESS`, `PERMIT2_ADDRESSES`, `permit2AddressFor(chainId)`, `permit2AddressesFor(chainId)` and `isPermit2Address(address, chainId)`.

`tx-preview-evm` now labels calls to zkSync Era's Permit2 "(Permit2)" instead of "(Permit2 signature)". It already classified them as Permit2 approvals.
