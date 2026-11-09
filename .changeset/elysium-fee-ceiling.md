---
"@anywalletkit/protocol-swap2-core": patch
---

Native-fee ceiling for Elysium (`eip155:99901`): 0.1 HYPE, as on HyperEVM. Elysium pays gas in HYPE, so the 0.005 default for ETH-denominated chains (≈ $0.37 in HYPE) would have refused ordinary bridge fees on routes out of Elysium.
