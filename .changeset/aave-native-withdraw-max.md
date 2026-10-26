---
"@anywalletkit/protocol-lending-aave-evm": patch
---

`withdraw({token: 'native', amount: 'max'})` approves the gateway for the held aWETH plus 0.1 % (+1). The approval was exactly the balance read at planning, while the WETH gateway pulls the balance at execution — grown by interest in between — so `transferFrom` failed.
