---
"@anywalletkit/protocol-staking-native-monad": patch
---

Validator-set reads (`getNetworkStats`, `getApr`, `listValidators` in `'any'` mode) now read every `getValidator` through Multicall3, 100 per `eth_call`, instead of one `eth_call` per consensus validator (~194 on mainnet): an APR or validator-list read is about 4 `eth_call`s instead of ~200. Results are unchanged. When the multicall fails (no Multicall3, an EIP-1193 provider or RPC that refuses it) the validators are read one call each as before; a rate-limited multicall fails as it is instead of fanning out. URL reads retry 4 times with backoff (0.4, 0.8, 1.6, 3.2 s, or the RPC's `Retry-After`) instead of twice within 0.5 s, and the default `concurrency` is 4 (was 6), so a burst no longer draws HTTP 429 from public Monad RPCs.
