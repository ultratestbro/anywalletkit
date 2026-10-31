---
"@anywalletkit/kit": minor
---

Typed data signed for another network than the account's is now judged by that network's policies too. With `allowCrossChainTypedData: true`, an EIP-712 message whose `domain.chainId` is another chain (a Polygon Permit signed from an Ethereum account) used to be checked only against the account chain's allow/block lists and fee rules, so a spender blocklisted under `eip155:137` got signed. Now the domain chain's rules apply as well, a `domain.chainId` that is present but not a chain id is refused with `PolicyViolationError('chain')`, and `confirm` receives the new optional `WriteIntent.domainChain` (CAIP-2) so your confirmation UI can show which network the signature is valid on. `chain` is still the account's network. Nothing to change unless your `confirm` hook should display or check `domainChain`.
