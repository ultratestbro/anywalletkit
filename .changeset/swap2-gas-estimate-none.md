---
"@anywalletkit/protocol-swap2-relay": patch
"@anywalletkit/protocol-swap2-across": patch
"@anywalletkit/protocol-swap2-stargate": patch
"@anywalletkit/protocol-swap2-usdt0": patch
"@anywalletkit/protocol-swap2-cctp": patch
"@anywalletkit/protocol-swap2-symbiosis": patch
---

README: a "Gas estimate" section saying why these quotes carry no `Quote.gasEstimate` (protocol-swap2-core): no API or contract answer states the gas the source transaction uses, and none is guessed. Relay's deposit-step `gas` is `eth_estimateGas` × 1.3, a limit with a margin (measured on ten live quotes, 2026-11-28); Across, Stargate, USDT0, CCTP and Symbiosis read no gas figure at all. No code change.
