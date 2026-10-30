---
"@anywalletkit/protocol-swap2-lifi": minor
---

`lifiPins` carry `verifyQuote: lifiVerifyQuote` (scan 2026-10-30, F3), exported too. The pins named only the Diamond, so a compromised backend could answer with Diamond calldata paying its own receiver, bridging to another chain or accepting less, and the engine signed it. The app now runs the provider's own `diamondCallMismatch` on the device with the expectation the provider builds (input token and amount, requested output token, recipient, quoted minimum ≥ the caller's floor, destination chain), plus the input's value (native: input + declared bridge fee; token: only the declared fee, approving the Diamond) and the intent id. A Solana source's serialized transaction is left to the account's balance proof. Validated on live LI.FI answers across 32 corridors (Across, Stargate, Relay, Mayan, LayerSwap, Polymer, Glacis, LI.FI Intents, NEAR, same-chain swaps): every quote the provider accepts passes.
