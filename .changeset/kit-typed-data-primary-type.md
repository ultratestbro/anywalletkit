---
"@forgewallet/kit": patch
---

EIP-712 policies judge exactly what gets signed (scan F5/F13). The primary type is resolved as wallet-evm's signer resolves it — the explicit `primaryType`, else the unique type no other type references (new export `resolvePrimaryType`; ambiguous typed data throws, as the signer does) — instead of the first key of `types`, and when the caller omitted it the wrapped `signTypedData` forwards the same object with that `primaryType` made explicit (same EIP-712 hash). An EIP-2612 / DAI `Permit` is classified from fields declared in `types[primaryType]` only: a revoke needs a declared `value` (uint256) of 0 or a declared `allowed` (bool) of false, and undeclared message keys are ignored, so an unlimited permit can no longer pass as a revoke.
