---
"@anywalletkit/protocol-swap2-stargate": minor
---

New provider: direct Stargate V2 Taxi transfers between 15 EVM chains (USDC, USDT, ETH and
the pinned OFT assets). Quotes read the pinned pools; the client rebuilds and checks the
`sendToken` calldata, re-quotes after review and proves delivery from finalized destination
receipts. Cached-token and LayerZero message recovery are separate reviewed, paid actions;
historical Bus transfers stay trackable. Off until `enabled: true`.

Opt-in `compose` route: Taxi into the pinned Ethereum LI.FI receiver plus one locally
encoded 1inch `unoswap2` swap through two canonical Uniswap V3 pools, with client preflight,
`completed` / `partial` tracking and a gas-bounded `lzCompose` retry.
