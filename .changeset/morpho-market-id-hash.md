---
"@anywalletkit/protocol-lending-morpho-evm": minor
---

A market configured by its 32-byte id checks the RPC's `idToMarketParams` answer: `marketId(params)` must equal the configured id, or every read and write on that instance is refused before anything is approved or sent. Morpho picks the market from the params in the calldata, so before, a hostile or user-added RPC could answer with its own market's params (same loan token, its own oracle) and take the supplied assets or collateral.

**Breaking:** an RPC whose `idToMarketParams` answer does not hash to the configured id now makes `getMarket`, `getPosition`, the quotes and every write throw `MorphoError` ("… hash to … refusing them"). Real markets are unaffected: their params always hash to their id.
