---
"@forgewallet/history-evm": patch
---

Alchemy backend: transport failures (timeout / abort / DNS) on a JSON-RPC call are retried with the same backoff as rate limits, and when the per-page enrichment batch (`eth_getTransactionByHash` + receipt) still fails the page is served from the Transfers lists alone — bare rows without fee / status — instead of `HistoryUnavailableError`. Matters on chains where Alchemy is the only free backend (Base): one aborted call used to blank the whole chain's history.
