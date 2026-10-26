---
"@anywalletkit/kit": minor
"@anywalletkit/protocol-approvals-evm": patch
"@anywalletkit/protocol-swap2-core": patch
"@anywalletkit/conformance": patch
---

`policies.maxFee` now reaches Tron's `signRaw` (second argument), an account's `revokeDelegation` (its only argument) and swap2's `sendSerializedTransaction` hook (third argument) as `{ maxFee }`, and the hook / approvals types say so. Under a fee cap, a write that pays a fee but cannot take one (NEAR `signBuilt`, Solana `signCompiled` / `signTransactionMessage`, name-guarded helpers) is refused instead of signed unchecked; off-chain signatures (messages, typed data, permits) are not affected. The conformance mock records the hook's options.
