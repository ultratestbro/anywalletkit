---
"@anywalletkit/extension-kit": patch
---

`DEFAULT_NETWORKS`: Plasma gains a second RPC endpoint run by a different operator — `https://plasma.gateway.tenderly.co` (Tenderly's public gateway, no key) after `https://rpc.plasma.to`. A wallet that requires two independent operators before it acts (the Omniston HTLC-secret quorum) could not reach that on Plasma with one endpoint; ordinary reads gain a failover. Checked live on 2026-11-10: chain id 0x2611, no redirect, CORS open, the same block hashes and escrow-factory logs as `rpc.plasma.to`, state reads at past blocks. An extension that allowlists hosts must list the new one.
