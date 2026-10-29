---
"@anywalletkit/tx-preview-evm": minor
---

Permit-style approvals are decoded. An EIP-2612 `permit()` call (`0xd505accf`), Permit2 `permit()` single (`0x2b67b570`) and batch (`0x2a2d80d1`) and `increaseApproval` (`0xd73dd623`) came back with no `approval` and no unlimited or spender warnings. Now they carry `approval`: for an EIP-2612 permit the token is the call's target, for Permit2 it is read from the struct, and `approval-unlimited` / `approval-unknown-spender` apply as for `approve`. A Permit2 batch lists every allowance in the new `DecodedCall.approvals` (the first is also `approval`), and each one gets its own checks. The permits are read strictly, as their contracts read them: a body too short for the ABI head, or with an offset or length out of range, is flagged `unparsedApproval` and gives the new `approval-unparsed` warning instead of passing as a plain contract call.

**Breaking:** `CheckCode` gains `"approval-unparsed"`; a `switch` over check codes that must be exhaustive needs a case for it.
