---
"@anywalletkit/protocol-swap2-wrap": minor
---

HYPE ↔ WHYPE on Elysium by Kinetiq (`eip155:99901`): `WRAPPED_NATIVE[99901]` is `0xbA876237B0F021A6c6D852d6c26E107997cC5E81`, the chain's aeWETH behind a transparent proxy. Checked on-chain on 2026-11-10: symbol "WHYPE", 18 decimals, `deposit()` / `withdraw(uint256)` in the implementation, `eth_estimateGas` of a deposit with value and of a holder's withdraw both pass. The provider still re-reads symbol and decimals before its first quote. Because the wrapper is upgradeable, `watch.json` follows its implementation and admin slots (`evm-proxy`). 28 chains.
