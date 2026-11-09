---
"@anywalletkit/names-ens": patch
---

`ensResolver` can cross-check names across independent RPC endpoints: pass `rpcUrls: [a, b]` (two or more different hosts) or `clients: [a, b]`. Every forward resolution, the `fresh` signing-time check included, asks each endpoint and is refused unless they all return the same address; a disagreement throws `EnsNameError` with code `lookup-failed` and reason `rpc-disagreement` (the new `EnsNameErrorReason` value), and an endpoint that does not answer fails the lookup. The single `client` / `rpcUrl` options behave as before.
