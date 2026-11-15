---
"@anywalletkit/conformance": minor
---

The swap2 behaviour suite runs Permit2 signature-transfer swaps. `createMockAccount({signTypedData: true})` exposes a recording `signTypedData` (answers `MOCK_TYPED_DATA_SIGNATURE`). For a plan whose call carries `permit2Transfer`, the suite checks that the permit is Permit2's transfer of exactly the input of the source token to the declared contract the plan calls, that exactly that permit is signed once, and that the call goes out as the reviewed calldata with that signature appended — nothing else.
