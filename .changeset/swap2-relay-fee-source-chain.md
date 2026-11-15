---
"@anywalletkit/protocol-swap2-relay": patch
---

Relay's fee is itemized only when Relay prices it in a currency of the source chain (`fees.relayer.currency.chainId`). A fee token carries no chain and the zero address names the native coin of every EVM chain, so with the engine's fee caps now counting native fees against a native input (SDK-318), a fee priced on another chain must not be summed as source wei. Honest quotes are unchanged: Relay prices its fee on the source chain.
