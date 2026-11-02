---
"@anywalletkit/protocol-swap2-cctp": patch
---

A CCTP swap whose claim was sent no longer reads `completed` when the provider has no RPC for the destination chain. `trackIntent` now returns `pending` (`depositReceived: true`, the claim hash in `destTxHash`, `claim.ready: false`) until the destination's `usedNonces` shows the mint, which needs the destination chain in `rpcUrls`. Before, the recorded claim hash alone was taken as the mint, so a claim that never minted could show as done.

What to do: pass `rpcUrls` for every destination chain you route CCTP to (`cctpProvider({rpcUrls})`), or poll with the id `claimSwap2` returns for a claim the destination account saw succeed (see the `destTxConfirmed` note); with neither, a claimed swap stays `pending`.
