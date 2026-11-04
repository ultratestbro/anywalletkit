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
input token (or what its source swaps make of it). Every refund, depositor or fallback address a
bridge carries in its own data (Stargate's LayerZero fee refund, an expired Across deposit or LI.FI
intent, a Mayan Swift order's trader, Chainflip's refund address, …) must be the sender or the
recipient. Refused, because the recipient cannot be read from the calldata: routes with a destination call, EVM-source routes to a non-EVM chain, and the
bridges whose facet does not bind the delivery to `BridgeData` (Relay, Garden, deBridge DLN,
ThorSwap, Squid, Symbiosis) — cross-chain requests ask LI.FI to route around Relay, Garden, Squid
and Symbiosis, and not to offer destination calls (`allowDestinationCall=false`), so their pairs get
another bridge. Unknown calldata is refused.

Every swap step is read, not only the ends: each must spend what the step before delivered, only
steps that spend the input token may pull from the wallet (`requiresDeposit`), and together at most
the input — a middle step pulling DAI under an old allowance is refused. The V3 entry points are
bound to the asset kinds they move (`*ToNative` only for a native output, `*ToERC20` for a token,
`NativeTo*` / `ERC20To*` for the matching input), since each counts its minimum in its own asset. A
bridge without source swaps must bridge the input, less at most a 1 % bridge fee. `apiUrl` must be
`https:` (`allowInsecureApiUrl` for local development).

Mostly not checked: a bridge's output. The destination minimum — and for some bridges (Relay, Across)
what finally reaches the recipient — sits in bridge-specific data, so on most cross-chain routes the
reviewed minimum relies on LI.FI's API (or your `apiUrl` proxy) answering honestly. Two bridges name
it outright and are held to the quote: an Eco intent must run on the destination chain and its route
must end in the destination token's `transfer` of at least the reviewed minimum to the recipient; an
M0 order must ask for the destination token and at least the reviewed minimum.

`routeWideSlippage: true` (default off) asks LI.FI for one slippage budget for the whole route
(`slippageScope=route`) on EVM → EVM requests instead of one per step; when LI.FI can protect no
route for a request, it is asked again in its default scope, held to the same floor.

## Behind `remoteProvider`

When the provider runs on your server, spread its pins into the app's stub:
`remoteProvider({name: "lifi", baseUrl, ...lifiPins})`. The engine then lets the EVM route call and
approve only the LI.FI Diamond of that chain, never an address the backend names, and `lifiVerifyQuote` decodes the
server's Diamond call on the device with the same check the provider runs on LI.FI's answer (receiver, minimum, input
token and amount, output token, destination chain, refund addresses; value and approval for the input kind). Without the pins the stub
gets no EVM calldata route (fail closed).

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
