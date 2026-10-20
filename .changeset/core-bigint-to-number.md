---
"@forgewallet/core": minor
"@forgewallet/protocol-lending-aave-evm": patch
"@forgewallet/protocol-lending-morpho-evm": patch
"@forgewallet/protocol-swap2-router": patch
---

`bigintToNumber` / `bigintToUnits` in core: BigInt → Number that stays correct on engines whose multi-limb conversion is broken (Hermes on Linux x64 returns 3·2^64 for `Number(2n ** 64n)`). Aave rates and health factors, Morpho utilization / health / LTV / fees and the router's quote USD values now convert through it.
