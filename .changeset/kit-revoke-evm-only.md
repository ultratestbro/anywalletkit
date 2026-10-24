---
"@anywalletkit/kit": patch
---

Policies classify a raw `sendTransaction`/`signTransaction` as a revoke only on `eip155` chains, and only for plain EVM calls.

The fixed bypass: a Tron, NEAR or Solana write carrying EVM-looking `to`/`data` (a zero-amount approve) was treated as a harmless revoke. That skipped the allowlist, checked the blocklist only against the fake `to`, and told `confirm` it was a revoke, while the chain package signed the real `raw_data_hex` / `actions` / `instructions`.
