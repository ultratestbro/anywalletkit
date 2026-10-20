---
"@forgewallet/protocol-swap2-core": minor
"@forgewallet/conformance": minor
"@forgewallet/protocol-approvals-evm": minor
"@forgewallet/protocol-swap2-thorchain": patch
---

Renames: the base of every swap2 error is now `Swap2Error`; the pinned derivation vectors are exported as `derivationVectors` and shipped as `vectors/derivation.json` (values unchanged). The approvals module drops its policy-engine rule set and its `Policy` / `PolicyRule` / `PolicyContext` types — the kit's policies treat revokes as `kind: 'revoke'` on their own; `isRevokeCalldata` and `isUnlimitedAmount` stay. THORChain's default `clientId` is `anywalletkit`.
