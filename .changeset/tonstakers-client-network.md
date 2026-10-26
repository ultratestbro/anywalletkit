---
"@anywalletkit/protocol-staking-tonstakers-ton": patch
---

The default client works with every documented account config, and the network follows the account. An account configured with `provider` (wallet-ton's alias of `tonClient`) had no client ("must be initialized with a tonClient"); a wallet-ton `TonRpc` was wrapped as `TonClient({ endpoint: undefined })` and failed on every call — it is now driven through an HTTP adapter that hands TonClient's JSON-RPC calls to it. The network comes from the account (`chain` / wallet-ton `network`): a testnet account used to stake into the mainnet pool; a `config.network` that contradicts the account is refused.
