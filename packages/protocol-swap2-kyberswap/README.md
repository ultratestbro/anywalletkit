# @anywalletkit/protocol-swap2-kyberswap

KyberSwap Aggregator as a same-chain swap2 provider: exact-input swaps routed by KyberSwap and settled through
MetaAggregationRouterV2 on 18 EVM chains — Ethereum, Base, BNB Smart Chain, Arbitrum, Optimism, Polygon, Avalanche,
Linea, Sonic, Berachain, Unichain, HyperEVM, Plasma, Monad, MegaETH, Robinhood Chain, Arc and Elysium.

Keyless (KyberSwap's public API) or with an API-gateway key. No integrator fee is charged.

## Use

```ts
import {kyberswapProvider} from '@anywalletkit/protocol-swap2-kyberswap'

const kyber = kyberswapProvider({
  rpcUrls: {8453: ['https://…'], 999: ['https://…']}, // required to execute (simulation before signing) and for receipts
  enabledChains: [8453, 999],                         // default: every chain in KYBER_CHAINS
  clientId: 'my-wallet',                              // x-client-id and the build's `source` (written on-chain)
})
// in the router: new RouterSwap2Protocol(account, {fromChain, providers: [kyber, …]})
```

Standalone: `new KyberswapSwap2Protocol(account, {fromChain: 'eip155:8453', rpcUrls})`.

Behind a backend: `remoteProvider({name: 'kyberswap', baseUrl, ...kyberPins})` in the app, so every quote the backend
returns is checked on the device against the pinned router and the app's own request.

| Option | Default | |
|---|---|---|
| `rpcUrls` | — | per chain id; without one, execution quotes on that chain are refused |
| `enabledChains` | all of `KYBER_CHAINS` | |
| `apiKey` | — | KyberSwap API-gateway key (`X-Api-Key`, `https://api.kyberswap.com/swap`); keep it on a server. With a key, `x-client-id` is not sent |
| `baseUrl` | public API | override the API base |
| `clientId` | `anywalletkit` | `x-client-id` (keyless only) and the build's `source` |
| `defaultSlippageBps` | 50 | KyberSwap accepts under 2000 |
| `quoteTtlMs` | 30 000 | how long a quote stays executable (the review fits; an approval mined meanwhile gets one re-quote) |
| `excludeRfqSources` | `true` | RFQ / private market makers quote for seconds only |
| `excludedSources` | — | KyberSwap source ids |

## How a swap is checked

- A dry quote is `GET /routes`; an execution quote also calls `POST /route/build`. The route summary is sent back
  untouched, with sender, recipient, slippage, a 20-minute deadline and `source` — never fee fields, `permit`,
  `ignoreCappedSlippage` or `origin`.
- KyberSwap's build endpoint encodes whatever route summary it receives, fee entries and output amount included, so
  nothing in its answer is trusted. `checkKyberTransaction` decodes the calldata strictly (re-encoded byte for byte)
  and refuses unless:
  - the target is MetaAggregationRouterV2 and the call is `swap()` (`swapGeneric`, `swapSimpleMode` and router V3 are
    refused by name);
  - the executor is the pinned AggregationExecutorProxy and the router approves nothing itself;
  - input token and amount are the request's: a native input carries no split and `value` equal to the amount, a token
    input's split adds up to the amount and sends no value;
  - output token and receiver are the request's (never the zero address);
  - the minimum is positive and at least the quote's minimum and the caller's floor;
  - there are no fee receivers, no permit, and no flag but `0x200`.
- The quote's minimum is KyberSwap's own: `floor(amountOut × (1 − slippage)) − 1` (the build lands one unit under the
  plain floor on every chain). `destAmount` is KyberSwap's `amountOut`, the route's ceiling: executed outputs come a few
  basis points under it, and KyberSwap keeps any output above the quote.
- Every execution quote is simulated before the user pays for anything: a native input with a balance override; a
  token input with its approval and the swap as one simulated block (`eth_simulateV1`), or as the plain call when the
  allowance is already there — so a route that reverts never asks for an approval. A wallet without the input, or an
  RPC without `eth_simulateV1` (Monad, Avalanche, HyperEVM on 2026-11-25), skips that early check
  (`providerData.simulated: "none"`). Every swap is simulated again from the account at the latest block right before
  signing (`preflightDeposit`). A revert, or no RPC answering, refuses the swap — nothing is sent unsimulated. Gas is
  the account's own estimate of the exact call (`ownGasEstimate`).
- Token inputs approve exactly the amount to the router (the engine default), spent in the same transaction.
- KyberSwap's own USD values of the input and the output (`amountInUsd` / `amountOutUsd`) reach the router's
  `quoteValues` as `providerData.priceImpactBps` — the value lost to pool impact and pool fees — so a near-total loss
  gets the "be careful" warning even when the app has no price for the token (2026-11-25 Unichain USDC → JUP: 7 824 bps).
  Information only, never a refusal; a token KyberSwap does not price carries none.

## Gas: `gasEstimate`

Every quote, dry or for execution, carries `gasEstimate` = KyberSwap's `routeSummary.gas` from `GET /routes` (asked
with `gasInclude=true`), `gasEstimateSource: "venue"`. It is there to compare routes (see protocol-swap2-core, "Gas:
`gasEstimate` vs `gasLimit`"): a dry quote has no transaction, so before this the router could only assume a gas limit
for it. Nothing in execution reads it: the swap still goes out with the account's own estimate of the exact call
(`ownGasEstimate`), and the transaction carries no gas limit. It counts the swap call only, no approval. A route that
states no gas (or 0) gives a quote without one.

What KyberSwap's figure is: its own model of the route's gas, not a simulation. The build answers the same number
(`gas` of `POST /route/build` equalled `routeSummary.gas` in all 16 recordings), and routine routes land on round model
values (330 498 for one Uniswap v3 or PancakeSwap v3 pool, 956 331 on two different chains). Against the gas the built
call used — 16 live routes recorded 2026-11-28 (`fixtures/quotes`) on Ethereum, Base, Arbitrum, Optimism, Polygon, BNB
Smart Chain, Linea, Sonic and Unichain for a throwaway sender = recipient, each built call run with `eth_simulateV1`
right after, at the chain's gas price (sender funded by a state override, a token input approved exactly in the same
simulated block; nothing sent):

| | Gas used ÷ `routeSummary.gas` |
|---|---|
| 16 routes | 0.58–1.85, median 0.73 |
| above the figure | 4 of 16: Linea Etherex CL 1.01, Polygon Ramses v3 + DODO 1.07, Sonic Metropolis LB 1.44, Base `kipseli-prop` 1.85 |

So it mostly runs high (the call used about three quarters of it at the median), and a proprietary-AMM route can run well over (how much gas such a pool
burns in a simulation need not be what it burns on-chain). The receiver held none of the output, so writing its first
balance is in these figures. On Arbitrum they are L2 execution gas without the L1 data component, which the router
leaves out too.

## Router owner

`KYBER_CHAINS[id].build` names the router build on each chain, read on-chain:

- `generic` (Ethereum, Base, BNB Smart Chain, Arbitrum, Optimism, Polygon, Avalanche, Linea): the router has
  `swapGeneric` and an owner-managed whitelist, so its owner (a single key on all but Linea) could make it spend an
  allowance left on it. With the engine's defaults none is left: the approval is exact and spent by the swap itself,
  and revoked if the swap does not go out. Two engine options change that (protocol-swap2-core, "Approvals"):
  `revokeUnspentApproval: false` leaves an approval whose swap did not go out on the router, and
  `allowanceReuse: "sufficient"` swaps from a larger allowance the account already gave the router, which then stays.
  On these chains either one leaves an allowance the router's owner could spend; keep the defaults for KyberSwap there.
- `lite` (every other chain): no `swapGeneric`, no whitelist.

## Limits

- Exact input only; same chain only; native ↔ wrapped is the Wrap provider's (not routed here).
- On Arc the native coin is refused (USDC with 18-decimal native accounting); swap its ERC-20.
- The public API allows 3 requests per second per IP, shared by everything behind that IP; dry routes for the same
  request are reused for 5 seconds. A 429 is a `rate_limited` refusal and the router carries on without KyberSwap.
- Smart-account / EIP-7702 senders, fee-on-transfer and rebasing tokens are not supported.

## Checked on mainnet

Base, 2026-11-24, one test wallet, through the engine (review → approval → preflight → send):

| Swap | Quoted | Received | Gas | Transaction |
|---|---|---|---|---|
| 0.000079 ETH → USDC (native value, no approval) | 0.133161 USDC (min 0.132494) | 0.133160 USDC | 239,155 | `0x989779e9…148fe7` |
| 1 USDC → ETH (exact approval, spent in the swap) | 0.000595564 ETH (min 0.000592587) | 0.000595540 ETH (−0.4 bps) | 305,229 + approval | `0xda5f2326…ba6dac` |

The router's USDC allowance was 0 after the token swap. `scripts/verify-mainnet.mjs` repeats it (`--send native|token`).

`scripts/verify-live.mjs` checks the contracts on every chain and builds (unsigned) one corridor each way per chain.
