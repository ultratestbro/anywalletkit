---
"@anywalletkit/networks": patch
---

Builtin Plasma network: a second RPC endpoint run by a different operator, `https://plasma.gateway.tenderly.co` (Tenderly's public gateway, no key), after `https://rpc.plasma.to` — the same list the extension's `DEFAULT_NETWORKS` now ships. Checked live on 2026-11-10 (chain id 0x2611, no redirect, CORS open, block hashes and logs equal to `rpc.plasma.to`).
