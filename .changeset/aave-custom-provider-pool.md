---
"@anywalletkit/protocol-lending-aave-evm": minor
---

The Pool that receives approvals and EIP-2612 permits is always pinned. Before, a custom `addressesProvider` without `pool` took whatever Pool the RPC's `getPool()` reported, so a hostile or user-added RPC could name its own contract as the spender of `supply` and `repay`. Now the Pool comes from the preset, from `pool` in the config, or — when the `addressesProvider` given is a preset's on the same chain — from that preset, and `getMarket()` refuses an RPC that reports a different one.

**Breaking:** `new AaveProtocolEvm(account, { addressesProvider })` for a market that is not a preset now throws `AaveError` ("Pass 'pool' with a custom 'addressesProvider' …"). Pass the market's `pool` as well. Presets, and a preset's provider passed explicitly, are unaffected.
