---
"@anywalletkit/tx-preview-evm": patch
---

On networks without `eth_simulateV1`, a failed `eth_call` is reported as `reverted` only when there is evidence the EVM reverted: revert data on the error (or nested in its `cause`), JSON-RPC code 3, a -32000 error that mentions a revert or execution, an "execution reverted" message, or one of viem's revert error types. A dropped connection, a timeout, a rate limit or any other node error is now `simulation.status: 'unavailable'` with the error in `reason`, so the review screen says "could not check" instead of warning that a good transaction would fail. Real reverts still show `reverted` with their reason.
