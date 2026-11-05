# @anywalletkit/protocol-swap2-curve

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-swap2-curve?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-curve)

[Curve](https://docs.curve.finance) same-chain swaps as a swap2 module, straight from the contracts: the router's own
`get_dy` quotes and its `exchange` executes, on the Router NG deployments in `src/deployments.ts`, over a curated pool
allowlist the package pins. No API on the money path, no key, no fee. Standalone through `CurveSwap2Protocol`, or as one
provider of the router.

Chains (18): Ethereum (router v1.2), Arbitrum, Base, OP Mainnet, Polygon, Gnosis, Avalanche, BNB Chain — the `[5][5]`
routers; Sonic, Unichain, HyperEVM, Mantle, Monad, Plasma, Robinhood Chain (v1.1.1), Ink, X Layer, Plume — the `[4][5]`
routers, which drive NG pools only. A chain is offered when it has a pinned router, allowlisted pools and an RPC.

## Install

```sh
npm install @anywalletkit/protocol-swap2-curve @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-swap2-curve @anywalletkit/core  ·  yarn add @anywalletkit/protocol-swap2-curve @anywalletkit/core
```

On npm: [@anywalletkit/protocol-swap2-curve](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-curve), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

## Configure

```ts
import { curveProvider } from '@anywalletkit/protocol-swap2-curve'

const curve = curveProvider({
  rpcUrls: { 1: ['https://eth.example/rpc'], 42161: ['https://arb.example/rpc'] },
})
```

| Option | Default | Meaning |
|---|---|---|
| `rpcUrls` | — | `{ chainId: [url…] }`, tried in order. Quotes, preflight and receipts. A chain without one is not offered. |
| `defaultSlippageBps` | auto | Used when the caller passes none. Default: swap2-core's `suggestSlippage` for the pair and the route's price impact (stable ↔ stable 10 bps, majors 50, others 100, plus half the impact). |
| `quoteTtlMs` | `180000` | The only expiry: Router NG has no deadline. Long enough for an approval to be mined on Ethereum. |
| `onWarning` | `console.warn` | Told when a chain's AddressProvider lists another router than the pinned one (never acted on). |
| `deployments`, `pools` | shipped tables | Overrides for tests. |

## How a swap is built

- **Routes come only from the allowlist** (`src/pools/`, generated in CI from Curve's pool lists and checked on-chain:
  coins by address, code hash, TVL and age thresholds). One or two pools per route; intermediate tokens are only coins
  of allowlisted pools. The router's own pseudo-hops are added: swap_type 8 between the native coin and the pinned
  wrapped native, and on Ethereum's v1.2 router swap_type 9 between crvUSD and scrvUSD (ERC-4626). Never type 9 on a
  v1.1 or `[4][5]` router. The registered fake-USDT pool and the pools drained in 2023 are refused whatever a list says.
- **Quotes** are the router's `get_dy` for every candidate (at most 30, JSON-RPC batches of at most 10); the best
  output wins. Price impact comes from a probe at 1/1000 of the amount on the same route.
- **Execution** is the explicit-receiver `exchange` — `0xc872a3c5` (`[5][5]`, zero `_pools`) or `0xfd44959c`
  (`[4][5]`) — paying the recipient, with `min_dy` from the slippage (never 0; a caller's `minAmountOut` floor is
  refused when the minimum is below it). A native input is sent as exactly that `value`; an ERC-20 input approves
  exactly the input to the pinned router (the engine resets USDT to 0 first) and sends no value.
- **Before use**, once per chain, the router's runtime code hash and `version()` are checked against the pins. The
  chain's AddressProvider is only compared (its id 2 may change at its admin's will) — a difference is a warning, the
  pinned router is still used.
- **Right before broadcast** (`preflightDeposit`): the transaction is byte for byte the quoted call; the route passes
  the same rules again; the router is still the pinned code; every hop pool still has its pinned code and coins; and a
  fresh `get_dy` of the exact route still pays at least the minimum. Anything else refuses with the reason.

Router NG approves each pool it meets for the maximum from its own balance; that touches only what is in transit
through the router, never the user's allowance, which is exact and spent in the same transaction. The router also
sweeps any dust it holds into the output (a few wei at most).

**Ethereum and MEV.** `min_dy` caps what a sandwich can take at the slippage; it does not stop one from taking up to
that. Keep the default (small) slippage on stable pairs and send Ethereum swaps through an MEV-protected RPC (a private
transaction relay) where the app can. Other chains in the list have sequencers or much less public-mempool exposure.

**The ERC-4626 hop.** For crvUSD → scrvUSD the router's `get_dy` uses `convertToShares`, which can sit a hair above
what `deposit` mints (2026-11-05: 2 × 10⁻⁸ on 1 000 crvUSD); the minimum covers it.

## Behind `remoteProvider`

When the provider runs on your server, spread its pins into the app's stub:
`remoteProvider({name: "curve", baseUrl, ...curvePins})`. The engine then lets the EVM route call and approve only the
pinned Router NG, and `curveVerifyQuote` opens the router call on the device against the app's own request: the
explicit-receiver `exchange`, exactly the input, the destination token, the quote's minimum (never 0), paid to the
recipient, no zap pools, and a route through allowlisted pools only — synchronous, from the shipped tables. For the
build checked on chain as well (router and pool code, pool coins, a fresh `get_dy` ≥ the minimum over the app's RPCs),
use `remoteProvider({name: "curve", baseUrl, ...curveRemotePins({rpcUrls})})`.

## Activity

`describeActivity(tx, ctx)` recognizes a call into the chain's pinned Router NG — and Ethereum's older v1.1
(`0x16C6…5353`) and v1.0 (`0xF0d4…8b8D`) routers, for history — with one of the family's `exchange` entry points
(`[5][5]`: `0x371dc447`, `0x5c9c18e2`, `0xc872a3c5`; `[4][5]`: `0xaad348a2`, `0xfd44959c`) as `swap`, "Swapped A → B"
from the owner's net transfers. Subtitle `Curve · <chain>`, counterparty = the router. When the receiver (the calldata's
`_receiver`, else the router's `Exchange` log) is not one of the owner's addresses, the subtitle ends in
`· paid to 0x…` and the receiver is the counterparty. `curveKnownContracts(chainId)` gives tx-preview its labels.

Fixtures (`fixtures/activity/`, public transactions captured with `scripts/capture-fixtures.mjs`, 2026-11-05): Ethereum
v1.2 CRV → crvUSD (`0x5c9c18e2`), Plasma `[4][5]` WXPL → XPL (`0xaad348a2`); negatives: a Uniswap SwapRouter02 swap, a
WETH9 deposit.

## Live check

`node scripts/verify-live.mjs [chainId,…]` (after `pnpm build`): per chain the router's code hash, version, wrapped
native and ABI family against the pins, then up to three quotes from the allowlist, each simulated with `eth_call` as a
dummy wallet funded by a state override (balance and router allowance); the router's return must reach the minimum.
Read-only, nothing signed.
