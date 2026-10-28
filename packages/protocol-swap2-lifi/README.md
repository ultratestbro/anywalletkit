# @anywalletkit/protocol-swap2-lifi

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-swap2-lifi?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-lifi)

LI.FI REST cross-chain swaps and bridges as a swap2 module: EVM calldata
routes through the LI.FI Diamond (Solana legs via guarded serialized
transactions). Standalone through `LifiSwap2Protocol`, or as one provider of
`@anywalletkit/protocol-swap2-router`.

## Install

```sh
npm install @anywalletkit/protocol-swap2-lifi @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-swap2-lifi @anywalletkit/core  ·  yarn add @anywalletkit/protocol-swap2-lifi @anywalletkit/core
```

On npm: [@anywalletkit/protocol-swap2-lifi](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-lifi), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

## What is checked before a quote is used

The quote's `action` must match the request (chains, tokens, amount, sender, recipient), the
transaction must target the chain's LI.FI Diamond, and the Diamond **calldata** is decoded and must
do the same: a same-chain swap (GenericSwapFacet / V3) pays the reviewed recipient at least the
reviewed minimum, spending the input token and delivering the requested one; a bridge call must be
one of LI.FI's listed `startBridgeTokensVia*` / `swapAndStartBridgeTokensVia*` entry points (packed
calls are refused) and its `BridgeData` must name the reviewed recipient and chain and bridge the
input token (or what its source swaps make of it). Refused, because the recipient cannot be read
from the calldata: routes with a destination call, and EVM-source routes to a non-EVM chain.
Unknown calldata is refused.

Not checked: a bridge's output. The destination minimum — and for some bridges (Relay, Across)
what finally reaches the recipient — sits in bridge-specific data, so on cross-chain routes the
reviewed minimum relies on LI.FI's API (or your `apiUrl` proxy) answering honestly.

## Behind `remoteProvider`

When the provider runs on your server, spread its pins into the app's stub:
`remoteProvider({name: "lifi", baseUrl, ...lifiPins})`. The engine then lets the EVM route call and
approve only the LI.FI Diamond of that chain, never an address the backend names; without the pins the stub gets no
EVM calldata route (fail closed).

## Activity

`describeActivity(tx, ctx)` recognizes any call into the LI.FI Diamond on an
EVM chain this module routes — the documented Diamond per chain (`provider.ts`,
`LIFI_DIAMONDS`) plus any `trustedTransactionTargets` you configured:

- GenericSwapFacetV3 selectors (`swapTokensSingleV3…` / `swapTokensMultipleV3…`,
  listed in `src/activity.ts`) → `swap`, "Swapped A → B" from the owner's net
  transfers (native legs included, e.g. "Swapped USDT → ETH").
- Every other facet (`swapAndStartBridgeTokensVia…`, `startBridgeTokensVia…`)
  is the source leg of a bridge → `bridge`, "Bridged A". An inbound dust
  rebate in the same transaction (a Mayan WETH refund) does not turn it into a
  swap.
- Subtitle "LI.FI", counterparty = the Diamond. The destination leg is paid on
  another chain by a third-party relayer and cannot be tied back offline, so
  `related` stays empty — the kit's intent journal links the two legs.

Not recognized: Solana legs (no program-level marker in the normalized tx yet),
and the destination side of a bridge (an ordinary transfer from a relayer).

Fixtures (`fixtures/activity/`, test wallet `0x8AbE…55bA` on Ethereum): two
same-chain swaps (USDT → USDC, USDT → ETH), three bridge source legs
(RelayDepository, Mayan with rebate, NEARIntents facet); negatives: a THORChain
`depositWithExpiry`, a WETH9 `deposit()`.
