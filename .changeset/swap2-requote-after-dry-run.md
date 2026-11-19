---
"@anywalletkit/protocol-swap2-core": minor
---

A dry run that fails right after an approval the execution mined is quoted once more on that allowance instead of revoking it (2026-11-19, 0x on Ethereum: the dry run after the mined Permit2 approval reverted, the engine revoked, the user paid two approvals for no swap). Same path as an approval that outlives its quote: same provider, route, spender and amount, the caller's minimum, a second `reviewExecution` with `requoted: true` when the plan changed, phase `requoting`, one re-quote per execution; the allowance is revoked only when that pass fails too. An RPC that does not answer (`upstream_unavailable`) is not re-quoted.

An allowance to canonical Permit2 that the swap spends only as a signature transfer (`PermitTransferFrom`, the 0x Settler) is no longer revoked after a failure: Permit2 moves nothing on it without a fresh signature per transfer, and the revoke cost a transaction, a prompt and the next swap's approval. Every other spender is revoked as before, and so is a Permit2 allowance a route would spend through Permit2's own allowances (`AllowanceTransfer`; no shipped provider does). Messages say which happened ("the Permit2 allowance was left in place").

`simulation_failed` names the revert when the account's error carries revert data (viem's `RpcRequestError.data`, `RawContractError.data`, `ContractFunctionRevertedError.raw`): `(reverted: 0x97a6f3b9 TooMuchSlippage)` — the selector, the name for known 0x Settler / Permit2 / ERC-20 / Uniswap router errors, and an `Error(string)` reason only when it is plain words; never addresses or amounts. A Permit2 execution reports one `signing` phase per pass.
