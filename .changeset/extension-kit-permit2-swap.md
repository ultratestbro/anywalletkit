---
"@anywalletkit/extension-kit": minor
---

Permit2 signature-transfer swaps (0x) are reviewed in one sheet. `swapApprovalPayload` carries the permit the account will sign (`source.permit2Transfer`: the typed data, its text, token, exact amount, the one contract that may use it, deadline) with a check line, and labels an approval to Permit2. `planMatchers` pre-approves the permit by its EIP-712 digest and the swap call by its exact signed structure (the reviewed calldata, one length word, that many signature bytes) instead of the unsigned calldata the engine never sends — before, the permit and the signed call each stopped for a second, raw review and one pre-approval stayed unused in the gate. New export: `evmSignedCallMatcher`.
