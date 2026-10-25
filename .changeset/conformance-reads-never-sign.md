---
"@anywalletkit/conformance": minor
---

`describeProtocolModule` now catches a read or quote that signs. The check used to look only at `sent` and swallowed every error, so a quote that called `sign`, or `signTypedData` (which the recording mock does not have, so it threw), passed. Reads now run on an account wrapped by the new `watchSigning()`, and any `sign*` / `send*` / `transfer*` / `approve*` / `broadcast*` / `revoke*` call fails the suite, even when the quote then throws. The new `mustResolve` option lists reads whose sample must succeed (an error fails the suite) for modules with fixture-backed accounts. Audit 2026-10-25, finding 14.
