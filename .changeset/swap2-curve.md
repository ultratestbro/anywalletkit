---
"@anywalletkit/protocol-swap2-curve": minor
---

New package: Curve same-chain swaps as a swap2 provider, straight from the contracts — Router NG `get_dy` quotes and `exchange` execution on 18 EVM chains (Ethereum v1.2, Arbitrum, Base, OP Mainnet, Polygon, Gnosis, Avalanche, BNB Chain on the `[5][5]` routers; Sonic, Unichain, HyperEVM, Mantle, Monad, Plasma, Robinhood Chain, Ink, X Layer, Plume on the `[4][5]` routers). No API on the money path, no key, no fee.

- **Routes only through a curated, pinned pool allowlist** (one or two pools), plus the router's wrap hop through the pinned wrapped native and, on Ethereum's v1.2 router only, the crvUSD ↔ scrvUSD ERC-4626 hop. The registered fake-USDT pool and the pools drained in 2023 are refused whatever a list says.
- **Pins per chain**: router address, ABI family, `version()` and runtime code hash (checked once per chain before quoting), wrapped native; the AddressProvider is only compared and a different id 2 only warned about, never used.
- **Execution**: the explicit-receiver `exchange` paying the recipient, `min_dy` never 0 (auto slippage from swap2-core by default), exact approval to the pinned router only, `value` exactly the input for a native source. Router NG has no deadline, so the quote's lifetime is enforced by the engine (3 min).
- **Preflight**: byte-equality with the sealed quote, the route re-checked, router and pool code, pool coins re-read and a fresh `get_dy` at or above the minimum before broadcast.
- `curvePins` / `curveVerifyQuote` (synchronous, from the shipped tables) and `curveRemotePins({rpcUrls})` (with an on-chain `verifyBuild`) for `remoteProvider`; `describeCurveActivity` (both ABI families, Ethereum's older v1.1 / v1.0 routers for history, a receiver other than the owner said out loud); `curveKnownContracts` for tx-preview; `CurveSwap2Protocol` standalone.
- Checked live (read-only, `scripts/verify-live.mjs`): every router's code hash, version, immutables and ABI family; quotes on Ethereum, Arbitrum and Monad simulated with `eth_call` as a funded dummy wallet.
