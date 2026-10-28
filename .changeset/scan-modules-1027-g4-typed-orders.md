---
"@anywalletkit/protocol-swap2-core": minor
"@anywalletkit/protocol-swap2-omniston": minor
---

The engine signs a provider's EIP-712 payload only when it is the swap's own order: a Limit Order Protocol `Order` whose `domain.verifyingContract` is the settlement contract the swap approves (for a remote stub, a pinned spender), on the source chain, with this account as `maker`, the source token as `makerAsset` and exactly the input as `makingAmount` (hex or decimal). A `Permit`, `PermitSingle`, `PermitBatch`, `PermitTransferFrom*` or any other `primaryType` is refused before anything is approved or signed — a backend's build could hand the wallet an EIP-2612 permit to itself and the engine signed and posted it. `remoteProvider` takes `verifyBuild(quote, tx)` (the provider's own check of a build, run on the client) and **refuses an absolute `baseUrl` that is not `https:`** (a same-origin path is fine; `allowInsecureBaseUrl: true` for local development). Omniston exports `omnistonPins(trustedEvmOrderProtocols)` — the app's audited order protocols as the remote stub's spenders — and `validateEvmTypedOrder`.
