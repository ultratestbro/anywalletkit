---
"@anywalletkit/protocol-swap2-core": minor
---

The swap engine can pay a swap through a Permit2 signature transfer.

A provider whose router pulls the input with Permit2's `permitTransferFrom` (0x Settler) now sets `txRequest.permit2Transfer`: the JSON EIP-712 `PermitTransferFrom` the account signs for this one swap. The engine never signs that payload as given.

- **The payload is read strictly and rebuilt locally.** `readPermit2Transfer` accepts exactly Permit2's `PermitTransferFrom` (no witness, no extra types or fields) in the Permit2 domain of the source chain, for the source token, for exactly the input amount, with the contract the swap calls as the spender, a uint256 nonce and a deadline no further than an hour away. What goes to `signTypedData` is a payload rebuilt from local constants and the checked values. Anything else is refused before an approval or a signature.
- **The allowance goes to Permit2 only.** `approvalAddress` must be the canonical Permit2 (`PERMIT2_ADDRESS`). The approval is for exactly the input (USDT reset on mainnet, revoked if the swap does not go out). A standing Permit2 allowance that already covers the input is left as it is.
- **Signing is typed data only.** The account needs `signTypedData`; there is no raw-hash path. The signature is appended as `calldata ++ uint256(length) ++ signature` (`appendPermit2Signature`), the signed call is estimated from the account before the broadcast, and a call that does not simulate is not sent.
- **The plan shows it.** `Swap2ExecutionPlan.source` (kind `call`) carries `permit2Transfer` — the exact typed data the account will sign — next to the unsigned calldata.
- A native-coin input, a typed order next to it, a build that changes the payload, a quote valid past the signature deadline and a token call carrying a permit are refused. A remote stub needs the pinned spender, the pinned target and its own calldata check, as for any other call.
- The server handler keeps `permit2Transfer` through the quote seal, `build` and `preflight`; `validQuote` requires a string.

New exports (`@anywalletkit/protocol-swap2-core` and `/util`): `PERMIT2_ADDRESS`, `PERMIT2_MAX_DEADLINE_SECONDS`, `PERMIT2_TRANSFER_TYPES`, `readPermit2Transfer`, `permit2TransferJson`, `appendPermit2Signature`, types `Permit2Transfer`, `Permit2TransferExpectation`.
