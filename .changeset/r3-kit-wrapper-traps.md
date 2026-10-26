---
"@anywalletkit/kit": patch
---

Policy wrappers close the reflective ways around them: the signer is hidden from property descriptors and key listings, writes to a guarded account (methods, settings) are refused, `_config` reads as a frozen copy, and `getManager` exposes only `getAccount`, `getAccountByPath`, `getNamedAccount`, `getReadOnlyAccount`, `getFeeRates` and `basePath`. Under a `maxFee` rule, a `sign*` / `send*` method the policies cannot quote (a chain package's internal helper) is refused. TON and NEAR destinations come only from the field the package builds from (`to`, `receiverId`).
