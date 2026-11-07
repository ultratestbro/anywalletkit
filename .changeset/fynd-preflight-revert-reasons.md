---
"@anywalletkit/protocol-swap2-fynd": patch
---

`preflightDeposit` no longer blames every revert on the price. It said "the price moved past your minimum" for any failed simulation — a balance under the amount, an approval the RPC does not see yet, a router fee check all read as slippage. Now the price is named only when the Tycho router reverts with `TychoRouter__NegativeSlippage` (with the amount it would pay and your minimum). Otherwise the wallet's side is read: a balance under the amount (ERC-20 or native) gives "the wallet's balance is below the amount", an allowance to the router under it gives "the token approval is not visible on-chain yet … try again in a moment", and anything else is "the swap would revert now (<reason>)" with the decoded router error or revert string. The swap is still refused in every case, nothing is sent, and the engine still revokes the approval.
