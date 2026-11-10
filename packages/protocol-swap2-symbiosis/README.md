# @anywalletkit/protocol-swap2-symbiosis

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-swap2-symbiosis?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-symbiosis)

[Symbiosis](https://docs.symbiosis.finance) as a swap2 provider: any-to-any
cross-chain swaps between Ethereum, BNB Chain, Avalanche, Polygon, Arbitrum,
Optimism, Base, Tron and TON, with Tron and TON as **sources** too. Quotes and
calldata come from Symbiosis' public REST API
(`api.symbiosis.finance/crosschain`); the transaction is decoded and bound to
the request on the device before a quote is shown and again before anything is
signed. No API key is needed, no partner id is set, and this module adds no fee
of its own.

## Install

```sh
npm install @anywalletkit/protocol-swap2-symbiosis @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-swap2-symbiosis @anywalletkit/core  ·  yarn add @anywalletkit/protocol-swap2-symbiosis @anywalletkit/core
```

On npm: [@anywalletkit/protocol-swap2-symbiosis](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-symbiosis), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

```ts
import {symbiosisProvider} from "@anywalletkit/protocol-swap2-symbiosis/provider";
import {RouterSwap2Protocol} from "@anywalletkit/protocol-swap2-router/swap2/router";

const swap2 = new RouterSwap2Protocol(bscAccount, {fromChain: "eip155:56", providers: [symbiosisProvider()]});
const res = await swap2.swap2({fromToken: "USDC", toToken: "USDT", toChain: "ton:-239", recipient: tonAddress, fromTokenAmount: 1_500n * 10n ** 18n});
const status = await swap2.getSwap2Status(res.id); // pending → completed | partial | refund-pending → refunded
```

| From (sources) | How the swap is sent | Default |
|---|---|---|
| Ethereum, BNB Chain, Avalanche, Polygon, Arbitrum, Optimism, Base | one `metaRoute` call on the chain's MetaRouterGateway; a token sale gets an exact approval to the same gateway first | on |
| TON (jettons) | one jetton transfer to Symbiosis' TON Portal with the bridge request in the forward payload | on |
| Tron (TRC-20) | one `metaRoute` call on the Tron MetaRouterGateway (`TPuaJ6gnYfE9gLUDFrbWbPx3tMnjG8max1`) | **off** — `tronSource: true` |
| Bitcoin | a deposit address the API names | **off** — `btcSource: true` |

Destinations: every chain above except Bitcoin. Tokens are the ones the shared
catalog (`@anywalletkit/swap2-assets`) knows on those chains; which pairs get a
route is Symbiosis' answer at that moment.

Not served: TON's native coin as a source (Symbiosis sends it through a partner
exchange), TRX as a source (no swap router is allow-listed on Tron), same-chain
swaps, and any route labelled `partner-swap`, `semi-centralized` or `intent`,
where a third party holds the funds (ChangeNOW-style legs, THORChain and
Chainflip bridges inside Symbiosis).

## What is checked before signing

`getQuote` never forwards the API's transaction blindly. It decodes every level
of it, requires each level to re-encode to exactly the same bytes, and refuses
the quote unless all of the following hold. `preflightDeposit` and the pins'
`verifyQuote` / `verifyBuild` run the same code again on the device right before
signing, so a server-side instance of this provider is trusted no more than the
API is.

**EVM and Tron source**

- the contract called is the chain's pinned MetaRouterGateway, the function is
  `metaRoute`, the chain id is the source chain, `amount` is the sell amount, the
  transaction value is the sell amount for a native sale and 0 for a token sale,
  the first approved token is the sell token, and an approval names only that
  gateway;
- before the bridge there is nothing, the wrap of the native coin, or **one**
  swap on an allow-listed router (below) decoded to: sell token and amount in,
  the bridged token out to the chain's pinned MetaRouter, no partial fill;
- the relay recipient is the chain's pinned Portal, and it gets
  `metaSynthesize` naming the pinned host-chain Synthesis and Bridge, the host
  chain id, the user as `syntCaller`, and only the user's own addresses — or
  Symbiosis' revert service, see below — as `chain2address` /
  `revertableAddress`;
- the swap on Symbiosis' host chain is `multicall` on the pinned
  MulticallRouter; every step is `swap(tokenIndexFrom, tokenIndexTo, dx, minDy,
  to, deadline)` on a **pinned Symbiosis pool**, between that pool's pinned
  tokens, paid to the MulticallRouter, with the running amount written into
  `dx` and nowhere else; the path is the swap token list and the result goes to
  the pinned host-chain MetaRouter;
- the token burned on the host chain is the one the pools pay out, and it is
  the **pinned synthetic of a token on the destination chain** (`pools.ts`,
  read from the host chain's SyntFabric); the burn names the destination chain
  id, its pinned Portal and Bridge, and the user's address as receiver;
- after the bridge there is either nothing — then the released token is the
  quoted token and the last pool minimum less the relayers' fee is not below
  the quote's minimum — or Symbiosis' pinned Unwrapper `unwrap(amount, to)`
  paying the recipient, or **one** swap on an allow-listed router decoded to:
  the released token in, the quoted token out to the recipient, a minimum not
  below the quote's minimum. Anything else is refused;
- every place a contract writes a running amount into the next call
  (`finalOffset`, the multicall `offsets[]`) is the amount word of the function
  it patches.

**Tron source, additionally.** The call is the same `metaRoute` ABI on the
pinned Tron gateway; the fee limit the API asks for is capped
(`tronFeeLimitCap`, default 300 TRX). The engine does not execute contract
calls on Tron yet, so `tronSource` is off by default. With it on, an app builds
the transaction itself: `symbiosisTronCall(quote)` returns the node request and
the exact `expected` transaction for `@anywalletkit/wallet-tron`'s
`assertNodeBuild` — txID = sha256(raw_data_hex), one `TriggerSmartContract`,
owner = the user, contract = the pinned gateway, calldata = the checked bytes,
call value and fee limit as checked.

**TON source.** The message body is parsed (BOC) as a jetton transfer of
exactly the sell amount to the pinned TON Portal, excess back to the sender, no
custom payload, forwarding less TON than the message attaches (itself capped at
1 TON); the forward payload is Symbiosis' bridge request, and its host-chain and
destination legs go through the same checks as above. The message is addressed
to the sender's own jetton wallet; that address is derived and checked by the
wallet engine (`wallet-ton`), not by this module.

**Allow-listed swap routers.** 1inch AggregationRouterV6 and KyberSwap
MetaAggregationRouterV2 (same address on every EVM chain here, non-upgradable,
source-verified), and a Uniswap-V2-style router on BNB Chain (PancakeSwap),
Polygon (QuickSwap) and Base. A leg on any other venue (0x, OpenOcean, Bitget,
…) is not read: the provider asks the API again with that venue switched off,
up to four requests a second apart, and refuses if nothing readable comes back.
1inch calls carry a tracking tag after their arguments, which is not the
canonical encoding of one swap; such an answer is asked for again without
1inch.

## What is still trusted

- **Symbiosis itself**: its contracts, relayers (an MPC group signs the
  cross-chain messages), pools and the relayers' fee (`stableBridgingFee`,
  bound only to "the minimum still holds after it").
- **The revert path.** On every route the API writes Symbiosis' own revert
  service (`0x67f9…851D`) as `revertableAddress` of the bridge request, and a
  request cannot change that. A stuck swap is reverted by that service, not by
  the user's key. The quote carries `providerData.serviceReverts = "1"` so an
  app can say so.
- **Inside an aggregator swap**: which venues the executor trades on. What
  holds is the router's own guarantee: it reverts unless the receiver got at
  least the decoded minimum of the decoded token.
- **The price of a swap before the bridge.** Its minimum is tied to the amounts
  the API states and to the route's final minimum, not to a market price. A
  route can be poor value and still pass (live 2026-11-10: Tron USDT → Base
  USDC through the Base V2 router lost about 3 %). Showing that is the app's
  job; `providerData.priceImpact` carries the API's figure.
- **The minimum itself** comes from the quote (`minDestAmount`); the checks
  hold the route to it, they do not judge it.
- **The pinned tables** (`config.ts`, `pools.ts`). They were read from
  Symbiosis' published configuration **and** from the chains; the public
  configuration alone is not enough (parts of it trail the live deployment).
  `scripts/build-pins.mjs --check` re-derives the pool and synthetic-token
  tables from the host chain, `scripts/verify-live.mjs` re-reads every pinned
  contract, and `watch.json` puts the EVM and host-chain ones (code, proxy
  implementations, pool token counts, the Unwrappers' `wrapper()`) under the
  module watch. The Tron contracts are not under the watch (it has no Tron
  reader); `verify-live.mjs` checks them.
- **Bitcoin source.** The deposit address is assigned by the API and cannot be
  verified on the device. It is off by default, quoted with
  `providerData.depositAddressAssigned = "1"`, and the pins open it only as
  `depositAddressRoutes` when `btcSource` is set. Whether to offer such a route
  is the app's policy. Symbiosis currently serves Bitcoin sources only through
  the partner routes this module switches off, so no real Bitcoin quote has
  been seen (2026-11-10).

## Fees and limits

Every fee the API reports is on the quote (`fees[]`, token, amount, where it is
taken) and summed into `feeUsd`; a response without readable fees, or with a
fee that has no price, is refused. All fees are included in the quoted output.
Observed 2026-11-10: about $0.50 between EVM chains and from Tron, $0.60 to
TON, $3 to Tron, plus pool fees inside the amount.

`GET /v1/swap-limits` is cached for five minutes and enforced locally: a sell
amount below the source token's minimum, or a result above the destination
token's maximum, is refused before a quote is asked for. On 2026-11-10 that was
0.3 – 200 000 for the bridged stablecoins and 0.0001 – 50 for ETH.

Slippage is the caller's `slippageBps`, else the config's, else
`suggestSlippage` from swap2-core for the pair. It is sent to the API as is.

## Status

`trackIntent` reads `GET /v2/tx/{chainId}/{hash}` (`SYMBIOSIS_STATUS`):

| API | State | What it means |
|---|---|---|
| not found | `pending` | the source transaction is not indexed yet |
| Pending | `pending`, or `refund-pending` when the hash is on `/v1/stucked/{address}` | in flight, or stuck |
| Success | `completed`; `partial` if another token or chain was paid | a failed destination swap delivers the bridged token instead |
| Stuck | `refund-pending` | Symbiosis reverts it itself, usually within an hour |
| Reverted | `refunded` **only with the revert transaction in the answer**, else `refund-pending` | the revert pays the token that crossed the bridge to the sender on the source chain, less the bridge fee — not always the token sold |

When neither side is an EVM chain (Tron ↔ TON) a failed last leg leaves
synthetic tokens on Symbiosis' host chain at `fallbackReceiver`, which must be
the user's own EVM address; the provider refuses such a route without it.

## Behind `remoteProvider`

When the provider runs on your server, spread its pins into the app's stub:
`remoteProvider({name: "symbiosis", baseUrl, ...symbiosisPinsFor({fallbackReceiver})})`.
The engine then lets an EVM route call and approve only the pinned
MetaRouterGateways, and `verifyQuote` / `verifyBuild` run the full decode above
on the device.

## Config

```ts
symbiosisProvider({
  enabled: true,            // default
  apiUrl: "https://api.symbiosis.finance/crosschain",
  tronSource: false,        // quote Tron sources (the app signs them through symbiosisTronCall)
  btcSource: false,         // quote Bitcoin sources (API-assigned deposit address)
  boundSourceOnly: false,   // true: refuse routes that swap on the source chain before bridging
  fallbackReceiver,         // the user's EVM address; required for Tron ↔ TON
  slippageBps,              // default when the caller names none
  quoteTtlMs: 60_000,
  tronFeeLimitCap: 300_000_000n,
  partnerAddress, partnerId, apiKey, // optional, never set by default; keep a key on your proxy, not in the app
})
```

The API serves about one quote per second per client.

## Activity

`describeActivity` (`./activity`) names a wallet's `metaRoute` transactions and
TON bridge transfers as swaps from their own bytes, with the destination chain
and recipient.

## Tests

```sh
pnpm --filter @anywalletkit/protocol-swap2-symbiosis test         # 300 tests over recorded API answers
pnpm --filter @anywalletkit/protocol-swap2-symbiosis verify:live  # read-only: pins on-chain, live quotes through the provider, eth_call / Tron node builds
```

`verify:live` signs and sends nothing. Fixtures are real answers recorded by
`scripts/record-fixtures.mjs`; the Bitcoin build tests use synthetic answers
and say so.
