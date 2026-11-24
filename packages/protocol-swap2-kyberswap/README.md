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
| `apiKey` | — | KyberSwap API-gateway key (`X-Api-Key`, `https://api.kyberswap.com/swap`); keep it on a server |
| `baseUrl` | public API | override the API base |
| `clientId` | `anywalletkit` | |
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
- A native input is simulated at quote time (balance override); every swap is simulated from the account at the latest
  block right before signing (`preflightDeposit`). A revert, or no RPC answering, refuses the swap — nothing is sent
  unsimulated. Gas is the account's own estimate of the exact call (`ownGasEstimate`).
- Token inputs approve exactly the amount to the router (the engine default), spent in the same transaction.

## Router owner

`KYBER_CHAINS[id].build` names the router build on each chain, read on-chain:

- `generic` (Ethereum, Base, BNB Smart Chain, Arbitrum, Optimism, Polygon, Avalanche, Linea): the router has
  `swapGeneric` and an owner-managed whitelist, so its owner (a single key on all but Linea) could make it spend an
  allowance left on it. This module never leaves one: the approval is exact and spent by the swap itself.
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
