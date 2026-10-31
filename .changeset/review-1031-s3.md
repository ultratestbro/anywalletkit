---
"@anywalletkit/tx-preview-evm": patch
---

The review checks now list every plain native transfer in a batch as a recipient. Only the last call was looked at, so a batch that sent 1 ETH to a stranger and then 1 wei to yourself showed no `recipient-foreign` warning. Each call with no selector and a value above zero now adds its `to` (lowercased, once) to the recipient checks. Your review screen may show more `recipient-*` checks for multi-call batches; nothing to change.
