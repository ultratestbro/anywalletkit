---
"@anywalletkit/protocol-swap2-balancer": minor
---

`balancerPins` now carry `verifyQuote: balancerVerifyQuote`, so a remote Balancer route is opened on the device (scan 2026-10-28, F2). The pins used to pin only the Vault: a compromised backend could redirect `batchSwap`'s output or call `manageUserBalance` on the user's Vault allowances. The verifier decodes the Vault call and requires `batchSwap` of kind GIVEN_IN with no internal balances and no pool `userData`, at most `BALANCER_MAX_SWAPS` hops; funds from the sender the provider names (the refund address, else the recipient) to the recipient; every hop that brings in an amount selling the source token, the amounts adding up to exactly the input, and a hop delivering the destination token; limits of exactly the input in and the quote's minimum out, zero for everything else; a deadline still ahead. Apps that spread `...balancerPins` get it without other changes.

**Breaking:** a remote Balancer quote whose Vault call is `manageUserBalance`, `swap`, `setRelayerApproval` or any batch that pays someone else, uses internal balances or other limits is refused, as is one without a Vault call. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.
