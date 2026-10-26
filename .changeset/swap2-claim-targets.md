---
"@anywalletkit/protocol-swap2-core": minor
"@anywalletkit/protocol-swap2-cctp": minor
"@anywalletkit/protocol-swap2-router": patch
---

`claimSwap2` now calls only a contract the provider declares for the destination chain (new `CrossChainProvider.claimTargets(chain)`; CCTP: its MessageTransmitter), and refuses claim calldata that moves the account's tokens or grants an allowance. A provider with a claim step must declare its targets; a remote provider stub takes them from the app (`remoteProvider({ claimTargets })`, e.g. `cctpClaimTargets` from `@anywalletkit/protocol-swap2-cctp`), never from the server. The router passes them through.
