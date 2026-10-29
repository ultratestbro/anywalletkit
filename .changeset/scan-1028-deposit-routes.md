---
"@anywalletkit/protocol-swap2-core": minor
"@anywalletkit/protocol-swap2-router": minor
"@anywalletkit/protocol-swap2-near-intents": minor
"@anywalletkit/protocol-swap2-thorchain": minor
"@anywalletkit/protocol-swap2-chainflip": minor
---

A remote stub's deposit-address and plain-value routes need the app's opt-in (scan 2026-10-28, F9). The pins applied only to builds with calldata, so a pinned calldata stub (LI.FI, CCTP, Uniswap, Balancer, wrap, USDT0, Chainflip) could answer with `depositAddress` = the backend's address, or a plain value send, and the engine paid it.

- **Core / router:** `remoteProvider({depositAddressRoutes: true})` (also a `RemotePins` field) opens a stub to routes that pay an address its backend names. Without it, the engine refuses such a build and `remotePinRefusal` drops such a quote in the router and the single-provider path, on every chain. The router keeps the flag in its snapshot.
- **NEAR Intents:** new `nearIntentsPins` — no call targets, no spenders, `depositAddressRoutes: true` (1Click deposit addresses are minted per quote).
- **THORChain:** `thorchainPins()` set `depositAddressRoutes`: the Tron vault is the one `verifyBuild` confirms with two THORNodes.
- **Chainflip:** `chainflipPins` set `depositAddressRoutes` and carry `verifyQuote: chainflipVerifyQuote`, the provider's own decode on the device: an EVM vault call on the pinned Vault, or a Tron send to the pinned Tron Vault whose note names the app's destination, refund address and a minimum price that guarantees the quoted minimum, with no DCA, boost, broker fee or affiliates; and `verifyBuild` requires the Tron note to go as hex bytes.

**Breaking:** a remote stub without `depositAddressRoutes` gets no deposit-address or plain-value route — spread `...nearIntentsPins` into your NEAR Intents stub (THORChain's and Chainflip's pins already carry it); a remote Chainflip quote that fails `chainflipVerifyQuote` is refused. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.
