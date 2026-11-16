# Stargate integration (in development)

Work for [SDK-321](https://megabunny.xyz/b/SDK/t/321), starting with
[SDK-322](https://megabunny.xyz/b/SDK/t/322) and
[SDK-323](https://megabunny.xyz/b/SDK/t/323). This private package contains interfaces,
amount accounting, a reviewed deployment registry, direct quotes, execution/client
pins, Taxi payout tracking and destination recovery. `stargateProvider` and
`StargateSwap2Protocol` are disabled by default (`enabled: true` is an explicit opt-in).
The package remains private and absent from the module registry while Bus tracking,
API routes and additional evidence are implemented. No funded send has been performed.

The full scope includes direct Stargate Taxi/Bus, verified deployments, tracking,
recovery and gas drop. The separate planned `protocol-swap2-layerzero` package covers
Value Transfer API routes. Composer support requires an explicit adapter for a
verified deployment; a new universal Solidity composer is a separate project.

## Run the foundation checks

```sh
pnpm --filter @anywalletkit/protocol-swap2-stargate build
pnpm --filter @anywalletkit/protocol-swap2-stargate test
pnpm --filter @anywalletkit/protocol-swap2-stargate typecheck
```

Tests are offline. Refresh evidence explicitly, after building:

```sh
pnpm --filter @anywalletkit/protocol-swap2-stargate fixtures:upstream
pnpm --filter @anywalletkit/protocol-swap2-stargate fixtures:live
pnpm --filter @anywalletkit/protocol-swap2-stargate registry:capture
pnpm --filter @anywalletkit/protocol-swap2-stargate fixtures:receipts
```

`fixtures:upstream` retrieves only interfaces from deployment artifacts at the
immutable commit recorded in `tests/fixtures/upstream.json`. Artifact URLs and SHA-256
digests identify the source. Tests compare parameter types, tuple layouts, output
types, mutability and event indexing against that artifact.

`fixtures:live` checks five deployments across Base, Arbitrum and BNB Chain and captures
four directions in both Taxi and Bus mode. Each chain is read at one block, 24 blocks
behind its head, whose number, hash and timestamp are recorded. The block hash is
checked again before writing. This margin is not a universal finality guarantee.
Every `eth_call` request and raw result/revert is retained. RPC URLs are not retained;
optional `RPC_8453`, `RPC_42161` and `RPC_56` overrides may contain credentials.

The snapshot records deployment identity, code hash, metadata provenance and
TokenMessaging asset/peer checks. It is a candidate verification sample, **not a
production allowlist or proof that deployed bytecode matches the source commit**.
The quote caller/recipient is a public placeholder; quotes do not simulate delivery.

The current fixture has four successful Taxi quotes and four Bus refusals with
`Bus_InvalidFare(false)` (the no-native-drop mode). This is an observation at the recorded blocks, not a permanent
statement about the protocol. A transport failure aborts capture; an observed quote
revert is retained as an unavailable route. Failed capture preserves the previous
snapshot. Refreshes require review, including changes to availability assertions.

The deployment artifact, pinned `src/libs/Bus.sol` and observed revert use
`Bus_InvalidFare(bool)`. The collector preserves and decodes the raw revert, rather
than assuming Bus is available whenever TokenMessaging peers are configured.

## Reviewed registry and coverage

`src/deployments.ts` pins 25 deployments in 15 SDK networks and 210 directed
TokenMessaging peer relationships. `src/registry.ts` resolves exact token addresses
and matching asset IDs, validates identities and shared precision, and returns frozen
copies of call targets and ERC20 spenders. Native pools and messaging contracts are
never ERC20 spenders. Same-chain swaps and missing directions are not routes.

The candidate evidence in `tests/fixtures/registry.json` records 117 metadata entries
across 55 chains, 36 verified deployments across 17 SDK chains, and 272 checked peer
relationships. Verification compares metadata with deployment addresses at a pinned
upstream revision, then checks token/config/type/active status, decimals, endpoint/eid,
asset mappings and messaging peers at recorded blocks. Code hashes record the
observed deployment; they do not prove source/bytecode equivalence.

| SDK network | Pinned token symbols (lookup uses addresses) | Verified but excluded from runtime: absent from SDK token catalog |
|---|---|---|
| Arbitrum | USDC, native ETH | — |
| Avalanche | USDC, USDt | — |
| Base | USDC, native ETH | — |
| Berachain | — | USDC.e, WETH, EURC.e |
| BNB Chain | USDC, USDT | — |
| Ethereum | USDC, USDT, native ETH | mETH, EURC |
| Flare | USDC.e, WETH (OFT) | USDT |
| Ink | — | USDC.e |
| Mantle | USDC, WETH, mETH | — |
| Optimism | USDC, native ETH | — |
| Plasma | WETH (OFT) | — |
| Plume | WETH (OFT) | USDC.e, USDT, EURC.e |
| Polygon | USDC | — |
| Scroll | native ETH | USDC |
| Sei | WETH (OFT) | — |
| Sonic | USDC | — |
| Unichain | native ETH | — |

Linea was discovered but excluded because no matching TokenMessaging artifact was
found at the pinned revision. Other discovered networks have no SDK chain entry;
the evidence records each exclusion. Catalog omissions need a separate reviewed
catalog update; metadata symbols cannot silently select another token.

**Verified does not mean currently quotable.** Peers are chain relationships, not
210 guaranteed token routes. Both endpoints must share an asset ID, and quotes must
still check current credits, fees, paused state and mode availability. Mantle mETH
currently has no included destination. Bus availability is not inferred from peers.

`registry:capture` writes candidate evidence only, never runtime pins. Optional
`RPC_<chainId>` overrides select an RPC without storing its URL. A missing artifact,
RPC failure or identity mismatch produces an explicit exclusion; a detected reorg
aborts publication. Review candidate changes and edit the static manifest deliberately.
The manifest records the evidence digest, and offline tests require exact agreement
with the reviewed entries and raw contract responses. No runtime fetch trusts metadata.

## Historical delivery evidence

`fixtures:receipts` refreshes five fixed historical GUIDs, without a signer or sends:
Base→Arbitrum native ETH and USDC, BNB Chain→Arbitrum USDC (18→6 decimals),
Flare→Arbitrum USDC.e (OFT→pool), and Arbitrum→Plume ETH/WETH (pool→OFT).
LayerZero Scan discovers transaction hashes. Successful source/destination receipts,
block hashes and raw logs are retained in `tests/fixtures/receipts.json`.

The collector checks the source endpoint's `PacketSent`, messaging peers, GUID,
Taxi asset/recipient/amount payload, source `OFTSent`, and destination pool
`OFTReceived`. Amounts must match after local-decimal conversion. The same checks
replay offline. These examples establish delivery to the named receiver for plain
Taxi, without proving unrelated compose actions or implementing a runtime tracker.
Packet layout: [PacketV1Codec](https://github.com/LayerZero-Labs/LayerZero-v2/blob/main/packages/layerzero-v2/evm/protocol/contracts/messagelib/libs/PacketV1Codec.sol);
payload layout: [TaxiCodec](https://github.com/stargate-protocol/stargate-v2/blob/414f47412123d7737520c6ba331c1376ec874a88/packages/stg-evm-v2/src/libs/TaxiCodec.sol).

## Amount and fee contract

`splitSourceAmount` separates the shared-decimal amount from source dust and enforces
the uint64 wire limit. `destinationAmount` converts a quote receipt from source local
units to destination units and rejects an unaligned receipt. `sourceMinimum` rounds
the user's destination floor upward to a representable shared amount before encoding
it in source units. Negative signed fee details are charges; positive details are
rewards. A reward must not be rejected merely because output exceeds input.

`createStargateQuoter` and `stargateProvider` reject zero effective input/output,
clipped exact-input receipts, inconsistent signed fees and insufficient output
credits (including rewards). Caller floors and slippage floors are rounded upward
to shared precision. Native
assets are identified by `token() == address(0)`: the captured native pool reports
`approvalRequired() == true`, so this flag alone must not trigger an ERC20 approve.

Quotes verify both chains, deployment identities, reciprocal messaging peers and
active status at fixed blocks, then recheck block hashes. Nodes more than five
minutes behind are refused. Credits are not reserved. `etaSeconds`, source gas
and approval gas are explicitly unknown; the signing wallet estimates execution
gas. `Quote.etaSeconds` is nullable throughout swap2, its API, router and extension
view. Unknown ETA receives no speed bonus or fastest tag.

The low-level quote separates requested input, actual sent input, dust, protocol
fee/reward, current messaging fee and its cap (25% default headroom, rounded up).
ERC20 dust remains in the wallet; native dust is attached with the original input
and becomes surplus messaging payment sent to the sender as a refund. Native
refunds depend on the recipient accepting them. `sourceAmount` remains the user's
requested maximum, while `providerData.sentAmount` and `dust` disclose the wire
amount. Protocol charges are already deducted from output. Messaging cap is
additional; neither its unused headroom nor rewards are counted as protocol fees.
There is no USD oracle in this provider (`feeUsdKnown: "false"`); applications can
use the router's valuation callback with their own prices.

Taxi native drop uses a type-3 executor option addressed to the transfer recipient.
Bus uses the pathway's current fixed drop amount; that setting can change before
the bus is driven. `nativeDrop: {taxi: amount, bus: true}` opts into either mode on
the provider and its client pins. Arbitrary options and compose bytes are refused.

References: [StargateBase](https://github.com/stargate-protocol/stargate-v2/blob/414f47412123d7737520c6ba331c1376ec874a88/packages/stg-evm-v2/src/StargateBase.sol),
[native pool](https://github.com/stargate-protocol/stargate-v2/blob/414f47412123d7737520c6ba331c1376ec874a88/packages/stg-evm-v2/src/StargatePoolNative.sol).

## Execution and tracking contract

| Flow | Evidence and identity | Completion / recovery |
|---|---|---|
| Taxi | Source receipt, pool, asset mapping, GUID, destination TokenMessaging peer | Verify destination pool `OFTReceived` for the expected receiver/asset/amount |
| Bus | `BusRode` ticket/passenger, then the matching `BusDriven` ticket range and GUID | Track the specific passenger; one package GUID does not identify one payout |
| Cached token | Destination `UnreceivedTokenCached` and matching `unreceivedTokens` commitment | Revalidate and build `retryReceiveToken`; completion requires payout evidence |
| Undelivered LayerZero message | Verified endpoint packet/pathway and current execution state | Separate endpoint retry; do not confuse it with cached-token recovery |
| Compose | Bridge delivery plus adapter-specific final action evidence | Final swap completes only after the requested action; recovery depends on the actual composer |

Taxi runtime tracking replays all five historical mainnet transfers. It verifies
source sender/amount, endpoint packet/pathway, GUID, asset and receiver, then checks
the destination pool's payout and canonical receipt/log identities. Scan supplies
candidate transaction hashes only. By default receipts must be below the RPC's
`finalized` head; `confirmations[chain]` explicitly substitutes an app's chosen
confirmation depth. RPC outages, unindexed messages and reorgs remain pending.
A finalized reverted direct source call is failed, never refunded.

Cached-token recovery requires the exact `unreceivedTokens` commitment. Endpoint
retry separately requires the exact `inboundPayloadHash` of GUID + message; cleared
or nilified payloads are refused. Both quote a distinct destination transaction
with zero attached value and separately paid wallet gas. Client validation rereads
the commitment after review. They integrate with the durable `recoverSwap2` flow,
whose operation ID and transaction hash are separate from the original source.
Native-drop delivery is not yet independently proved: token payout with a requested
drop reports `partial`, not full completion. Real Bus/recovery receipts and drop
delivery evidence remain to be collected; synthetic cases are labelled as such.

`stargatePins(config)` requires the client's own source/destination RPCs and reviewed
registry. It verifies the entire canonical `sendToken` calldata, including mode,
recipient, amount, minimum, refund address, options, native value and spender.
Remote builds additionally recheck current chain state and fees on the client,
including after the backend's preflight. A backend cannot substitute that check.
`getQuotes` enumerates Taxi/Bus only for previews; execution keeps the selected mode.

Bus acceleration must assemble the valid current queue prefix, obtain `quoteDriveBus`,
and review a separate source-chain payment. Revalidate after any competing drive.
See [TokenMessaging](https://github.com/stargate-protocol/stargate-v2/blob/414f47412123d7737520c6ba331c1376ec874a88/packages/stg-evm-v2/src/messaging/TokenMessaging.sol)
and [Bus events](https://github.com/stargate-protocol/stargate-v2/blob/414f47412123d7737520c6ba331c1376ec874a88/packages/stg-evm-v2/src/libs/Bus.sol).

## Integration boundaries and remaining work

- SDK-323: implemented reviewed registry and evidence collection for the current
  supported intersection; coverage and explicit exclusions are listed above.
- SDK-324: core/router now support optional display candidates, stable `routeId`,
  `using(provider, routeId)`, sealed remote candidates and pinned requotes. Existing
  `getQuote`, `using(provider)` and tracking IDs remain compatible. Stargate's
  provider now implements these hooks.
- SDK-325: core now provides application-owned atomic journals, read-only reconciliation
  and a separate reviewed/value-bounded EVM recovery path. Stargate must supply the
  on-chain validators and recovery offers in SDK-328/329. Old `awk1` IDs and zero-value
  claims retain their existing contracts.
- SDK-326/327: direct quoting, execution and client pins are implemented and tested.
  SDK-328: Taxi payout tracking and destination recovery are implemented; historical
  failed-delivery/retry evidence remains outstanding.
- SDK-329: Bus tracking and
  recovery. These are not implemented by the current helpers or fixtures.
- SDK-330/SDK-331: API discovery and resumable steps, key held server-side. Include only
  routes for which every wallet operation has a validator. EVM multicall, signatures
  and fresh Solana transactions need separate adapters. Unknown VM steps fail closed.
- SDK-332: select a verified composer deployment and validate success and recovery.
- SDK-333: history, documentation, package exports, module registry, changesets,
  conformance, regressions, Hermes and controlled end-to-end validation.

Stage 1 remains open for real Bus delivery and recovery fixtures,
API contract fixtures/access, and the complete capability matrix. No mainnet sends or
package publication are part of the collection commands above.

Protocol documentation: [Stargate integration](https://docs.layerzero.network/v2/developers/evm/stargate/overview),
[Value Transfer API](https://docs.layerzero.network/v2/developers/value-transfer-api/overview).
