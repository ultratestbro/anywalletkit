# @anywalletkit/protocol-swap2-lifi

LI.FI REST cross-chain swaps and bridges as a swap2 module: EVM calldata
routes through the LI.FI Diamond (Solana legs via guarded serialized
transactions). Standalone through `LifiSwap2Protocol`, or as one provider of
`@anywalletkit/protocol-swap2-router`.

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
