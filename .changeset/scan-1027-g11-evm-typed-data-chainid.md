---
"@anywalletkit/wallet-evm": minor
"@anywalletkit/kit": patch
---

EIP-712: `signTypedData` refuses a uintN / intN field (nested structs and arrays included) that is not a bigint, a safe integer, or a decimal / `0x`-hex string; viem would have passed `' 115…'`, `'0X…'` or `'0b…'` through `BigInt()` and signed the maximum. `describeTypedData` reads amounts the way the signer does and shows a present but unreadable permit amount as unlimited, never as 0; `PermitBatchWitnessTransferFrom` is recognised as Permit2. A transaction `chainId` string must be decimal or `0x`-hex within 2^53 in wallet-evm (`chainIdNumber`), and the kit refuses a present but unreadable `chainId` (`PolicyViolationError`, `policy: 'chain'`) instead of treating it as absent.
