---
"@anywalletkit/protocol-swap2-cctp": patch
"@anywalletkit/protocol-swap2-core": minor
---

A CCTP claim hash is no longer taken as proof that the USDC was minted when the destination can be checked.

- `cctpProvider`: when a destination RPC is configured but the `usedNonces` read fails (or the attested message carries no nonce to read), a swap with a recorded claim hash now reports `pending` (the claim hash is kept in `transactions`) instead of `completed`. Poll again; it completes once the RPC answers and the nonce is used. Without any destination RPC the recorded claim hash is still the evidence, as before.
- `claimSwap2` (all two-phase providers): when the destination account has `waitForTransaction`, the engine now waits for the claim before returning. If the wait proves the claim reverted on chain (the account's error has `code: "reverted"` or says the transaction reverted, as `@anywalletkit/wallet-evm` does), `claimSwap2` throws `Swap2ExecutionError` (claim hash in the message, the account's error as `cause`) and returns no id that carries the claim hash; poll the swap's status with the id you already had and claim again if it is still `action-required`. A wait that times out or loses the RPC proves nothing: the id with the claim hash is returned as before, and the provider's status decides (for CCTP with a destination RPC, `pending` until the mint is seen). Accounts without `waitForTransaction` behave as before.
