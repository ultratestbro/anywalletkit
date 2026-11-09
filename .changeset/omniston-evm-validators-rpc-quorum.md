---
"@anywalletkit/protocol-swap2-omniston": patch
---

`createOmnistonEvmOutputValidator` and `createOmnistonEvmInputValidator` take `quorum` (and `operatorOf`): with `quorum: 2` the secret disclosure no longer rests on one RPC. The chain's endpoints (`rpcUrls`, then the public fallbacks) are grouped by operator (`omnistonRpcOperatorGroups`, registrable domain via `omnistonRpcOperator`); every operator runs the whole validation on its own — factory log, receipt and block, CREATE2 derivation, `FACTORY()`, balances — with its state reads pinned to its finalized block (head minus the chain's confirmations) instead of `latest`, and at least `quorum` operators must prove the position (`rpc-quorum-unavailable` / `rpc-quorum-not-met` refusals otherwise, each operator's own refusals carry `operator`). A quorum needs `rpcUrls`; passing it with a single `request` throws. The default (`quorum` 1) is unchanged: one validation over the first answering endpoint.
