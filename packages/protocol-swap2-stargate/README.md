# @anywalletkit/protocol-swap2-stargate

Direct Stargate V2 **Taxi** transfers between 15 EVM chains: quotes read straight from the
pinned pools, the source `sendToken` call is rebuilt and checked on the client, and delivery
counts only when the destination pool's payout is proven from finalized receipts. Cached
tokens and undelivered LayerZero messages get separately reviewed, separately paid recovery.
Historical Bus transfers stay trackable. No LayerZero API key is needed.

`stargateProvider` and `StargateSwap2Protocol` are off by default: pass `enabled: true`.
The executable compose route (Taxi into the pinned Ethereum LI.FI composer plus one checked
Uniswap V3 swap) is a second, separate opt-in: `compose: {enabled: true}` on the backend
provider **and** the client pins. Value Transfer API routes live in the separate, still
private `protocol-swap2-layerzero` package. Work tracked in
[SDK-321](https://megabunny.xyz/b/SDK/t/321).

```ts
import {stargateProvider} from '@anywalletkit/protocol-swap2-stargate/provider'

const stargate = stargateProvider({
  enabled: true,
  // Source AND destination RPCs: quotes, client checks and payout proofs read both chains.
  rpcUrls: {'eip155:42161': ARBITRUM_RPC, 'eip155:8453': BASE_RPC},
})
```

Pass the reviewed `toTokenAmountMin` as `minAmountOut`, persist an `operationStore`, and on
`Swap2MaybeSentError` resume the returned id instead of sending again (see
`examples/swap/src/stargate.ts` and `examples/server/src/stargate.ts`).

## Current service availability

New transfers use Taxi only. Bus was retired on **October 1, 2026**, per the
[LayerZero announcement](https://layerzero.network/blog/ecosystem-update-september-2026).
Bus quotes, selected Bus routes and source builds are refused, including client-side
validation of remote quotes. Historical Bus tracking and recovery remain available.

Scroll is the only pinned chain in the current Stargate sunset list. New transfers
involving Scroll are refused from **2026-12-08 00:00 UTC**; quote expiry is capped at
that boundary. Historical deployment identities remain available for tracking.
This is a conservative interpretation of the effective date in the
[updated support announcement](https://layerzero.network/blog/support-update-july-24-2026).
A configured peer is not a promise of continued service.

## Funded mainnet verification

`scripts/verify-mainnet.mjs` runs the production shape on public mainnet: quotes and builds
cross a sealed HTTP backend, the client applies its own pins and RPCs, the router journals
every step in SQLite, and tracking waits for finalized receipts. Without flags it only quotes.
`--send <case>` broadcasts one capped transfer (amount and attached native value are hard
limits checked in the review callback); `--resume <operationId>` reopens the journal in a
fresh process with a read-only account. The signer phrase is read from `STARGATE_ENV_FILE`
and never printed. Results go to `tests/fixtures/mainnet-funded.json`.

| Date | Transfer | Result |
|---|---|---|
| 2026-11-17 | Arbitrum → Base, 2 USDC (exact approval) | Received 1.998793 USDC, equal to the source `OFTSent` amount and the destination balance delta; 0.000688 ETH messaging paid against a 0.00085 ETH cap (headroom refunded); zero residual allowance; `completed` after both chains finalized (~18 min); fresh read-only process resumed to `completed` with one source step |
| 2026-11-17 | Base → Arbitrum, 2 USDC | Payout 1.998785 USDC proven from the finalized `OFTReceived`; 0.000695 ETH spent against a 0.000866 ETH cap; `completed` |
| 2026-11-17 | **Compose** Arbitrum 2 USDC → Ethereum DAI | Bridge 1.998759 USDC into the LI.FI receiver; the LayerZero executor ran `lzCompose` and the swap paid 1.998378 DAI (minimum 1.988386); client reported `completed` from the finalized executor events; 0.001884 ETH spent against a 0.002344 ETH cap (Ethereum compose gas included) |

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
pnpm --filter @anywalletkit/protocol-swap2-stargate fixtures:bus
pnpm --filter @anywalletkit/protocol-swap2-stargate fixtures:recovery
pnpm --filter @anywalletkit/protocol-swap2-stargate fixtures:compose
```

### Local mainnet fork integration

With Anvil installed and the workspace dependencies built:

```sh
pnpm --filter @anywalletkit/protocol-swap2-stargate verify:fork
```

This starts owned Base/Arbitrum forks on loopback. Public upstreams sit behind a
read-only RPC proxy; transaction submission goes only to the local nodes. Optional
`RPC_8453`, `RPC_42161` and `ANVIL_BIN` select upstreams/the executable. It uses public
test derivation vectors, rejects test addresses with existing delegated/deployed code,
and does not load a real signer or private credentials for signing.

Three scenarios execute the SDK wallet/router through an HTTP quote backend with
client pins: ETH, USDC with a lost broadcast reply, and ETH with a recipient that
temporarily rejects payment. They verify exact approvals, zero residual allowance,
source dust/messaging refunds, destination balance deltas, reviewed endpoint/token
recovery, refusal of consumed-message replay, and resuming a SQLite journal in a
fresh read-only Node process without another source transaction.

`tests/fixtures/fork.json` records the upstream block identities, local transaction
hashes, reviews, journal steps and observed balances. **These are local fork hashes,
not public explorer transactions.** Funding, receive-library/DVN verification and
any nonce-gap alignment are simulated; the cached-token case injects a local reverting
receiver. This does not establish real DVN delivery, public-network finality, latency
or operation on a mobile device. The report is replaced only after every case passes.

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
`Bus_InvalidFare(false)` (the no-native-drop mode). This is a historical observation at the recorded blocks, not a permanent
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
`nativeDrop: {taxi: amount}` opts in on the provider and client pins. Historical Bus
recovery uses its recorded batch drop parameters. Arbitrary options and compose
bytes do not enter the direct executable provider.

References: [StargateBase](https://github.com/stargate-protocol/stargate-v2/blob/414f47412123d7737520c6ba331c1376ec874a88/packages/stg-evm-v2/src/StargateBase.sol),
[native pool](https://github.com/stargate-protocol/stargate-v2/blob/414f47412123d7737520c6ba331c1376ec874a88/packages/stg-evm-v2/src/StargatePoolNative.sol).

## Executable compose route

With `compose: {enabled: true}` on both the provider and the client pins, a source USDC or
USDT deployment with an Ethereum counterpart can deliver **another ERC20 on Ethereum**
(`routeId: "compose"`, also offered by `getQuotes` next to Taxi). The bridge leg is Taxi into
the pinned LI.FI `ReceiverStargateV2`; its compose message carries one swap that this SDK
encodes itself: 1inch V6 `unoswap2` through two canonical Uniswap V3 pools (via WETH, USDC or
USDT), priced by QuoterV2 at one block. No LI.FI or 1inch API is called.

- **Exact bridge leg.** The bridge minimum equals the quoted output, so the swap input is
  known exactly; if Stargate's fee rises before the send, the source call reverts instead of
  delivering less than the encoded swap needs.
- **Self-contained intent.** `stargate:2:compose:…` carries every parameter (amounts, both
  pool words, swap minimum, compose gas, LI.FI transaction id). Clients rebuild the whole
  `sendToken` calldata and refuse any byte of difference, a changed recipient or minimum.
- **Client preflight.** Before signing, the pins re-quote the bridge (fee within the reviewed
  cap, output unchanged), check the receiver, executor, router and factory bytecode and the
  receiver's executor/endpoint/TokenMessaging wiring, confirm both pools through
  `factory.getPool`, require compose gas ≥ `recoverGas` + 250k, and re-price the exact path:
  a destination price already below the reviewed minimum refuses the build.
- **Gas.** Compose gas is the receiver's `recoverGas` (100k today) plus 400k for the swap
  (`compose.swapGas`); a two-hop V3 swap measures ~166k. It is paid inside the messaging fee,
  so Ethereum-bound compose quotes cost more than plain Taxi.

Tracking states:

| State | Evidence |
|---|---|
| `completed` | Finalized `ComposeDelivered` plus the executor's swap and an actual final-token payment ≥ the reviewed minimum |
| `partial` | The receiver's `LiFiTransferRecovered`: the swap did not run and the bridged USDC/USDT was paid to the recipient on Ethereum |
| `action-required` | Bridge delivered, the Endpoint `composeQueue` still holds the exact message hash, and `composeRetryAfterS` (default 600 s) has passed since delivery. The client's own setting decides: a backend offering the retry earlier is refused at `verifyRecovery` |
| `pending` | Otherwise, including a consumed queue whose outcome receipt is not yet indexed or finalized |

The `compose` recovery offer calls `EndpointV2.lzCompose` with the original message, zero
value and an explicit `gasLimit` (compose gas or `recoverGas` + 250k, whichever is larger,
plus 250k overhead): wallet gas estimation would otherwise settle on the receiver's cheaper
fallback path. A consumed queue is never offered again. `lzCompose` is permissionless, and
LI.FI documents that anyone can call it first with too little gas and force the fallback
([ReceiverStargateV2 v1.1.0](https://etherscan.io/address/0xB539B40793171211DCA8834da044fC14bCe64BDC#code));
the user then holds the bridged token and the route reports `partial`. The receiver does not
check `composeFrom`, so a user-sent compose is accepted like LI.FI's own.

`scripts/verify-fork-compose.mjs` (Anvil forks of Arbitrum and Ethereum, `RPC_42161`/`RPC_1`)
sends Arbitrum USDC → Ethereum DAI through the HTTP backend and client pins, relays the packet
locally, then covers two cases: the executor never runs `lzCompose` (a client on the default
window reports `pending` and refuses to sign the backend's early offer; with the window at 0
the retry executes and delivers DAI ≥ the minimum),
and an underfunded third-party `lzCompose` (receiver fallback → `partial`, USDC paid, no
further offers). Report: `tests/fixtures/fork-compose.json`.

## Compose evidence adapter

The `./compose` entry point provides a **read-only** adapter for the Ethereum LI.FI
`ReceiverStargateV2` and its Executor. Receiver and Executor runtime bytecode hashes
are pinned against fully verified non-proxy contracts. Official deployment/source
URLs, explorer verification digests, historical identity reads and both code snapshots
are recorded in `tests/fixtures/compose.json`.

`proveLifiStargateCompose` binds the source pool event and Endpoint packet to the exact
compose sender/payload, bridge asset, composer, final recipient and expected output
asset. It checks the composer received the bridged tokens and the exact `ComposeSent`
message. Inputs must come from independently verified canonical finalized blocks;
passing an API's receipt JSON is not independent chain verification.

`lifiStargateComposeOutcome` returns:

| Outcome | Required evidence |
| --- | --- |
| `completed` | Matching Endpoint delivery, executor swap/completion events and actual final ERC20 payment meeting the caller's minimum |
| `intermediate-refunded` | Matching Endpoint delivery, pinned receiver recovery event and payment of the bridged asset to the final recipient |
| `unverified` | Missing/mismatched evidence, ambiguous batches or final native-coin output without independent payment proof |

The recorded success is Arbitrum USDC → Ethereum → WLFI via a LI.FI/1inch call. The
second case returns bridged USDT after the destination swap fails, even though Scan
reports compose `SUCCEEDED`. This is a destination fallback, not a refund on the source
chain. Executor `LiFiTransferCompleted` names the input asset and can report a gross
balance: the adapter counts final-token transfers instead.

`stargateComposeQueueState` distinguishes absent (`0`), pending (exact message hash),
consumed (`1`) and foreign commitments. Consumed messages cannot be replayed. Successful
fallback consumes the queue too; it cannot be fixed by replaying `lzCompose`.
`stargateComposeOptions` encodes positive uint128 gas for index zero with no native value.

The separate `./compose-dex` entry point exports `validateLifiUnoswap2Compose` for one
narrow operation: Ethereum 1inch V6 `unoswap2`, two canonical Uniswap V3 pools, ERC20
input/output. It checks pinned router/factory/composer code at one block, exact input,
encoded minimum, spender, recipient, pool directions and factory `getPool` identities,
then rechecks the block hash. Permit2, native unwrap, unknown flags, other selectors
and arbitrary trailing bytes are refused. The only accepted suffix is the observed
four bytes `2a94d114` (or no suffix); the pinned router's reviewed `unoswap2` path does
not read trailing calldata. No ownership or authorization is inferred from that marker.

The fixture records raw pool reads and exact runtime hashes. The router is fully
verified on Blockscout. The factory has **partial** source verification there; its
runtime hash is pinned separately, and its address matches the
[official Uniswap Ethereum deployment](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments).
This is not a claim of a reproducible factory source build. The success fixture passes
the DEX validator; the opaque aggregator call in the fallback fixture is refused.

Historical proofs and DEX validation results have `executionSupported: false`: they
establish observed payment and one call's constraints, not execution authorization. Only
proofs built by `stargateComposeProof` for an SDK-encoded intent report `true`. Arbitrary
DEX calldata stays refused, and read-only proof support must not be used as a spender or
contract allowlist. API access is not needed to refresh these
historical fixtures. The receiver may return the intermediate asset on insufficient
compose gas or swap failure; successful queue consumption does not guarantee a swap.

## Server and mobile examples

Workspace examples: `examples/server/src/stargate.ts`
and `examples/swap/src/stargate.ts`. The backend
holds RPC credentials and quote sealing secrets. The mobile client uses its own pins
and independent/public or application-proxied RPCs, requires execution review and a
durable operation store. No LayerZero API key is needed for direct Taxi. React Native
must install the normal Hermes polyfills before importing wallet/protocol packages.
`stargatePins` also supplies independent client tracking and recovery validation:
backend status cannot substitute for verified payout, and each recovery offer is
checked against the client's current on-chain commitment before signing.

`module.json` registers this package in the module registry. The separate LayerZero
discovery transport is not an executable protocol module and stays private.

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
with separately paid wallet gas. Token retries and plain Taxi message retries attach
zero value; Bus message retries fund native drops for the entire batch. Client validation rereads
the commitment after review. They integrate with the durable `recoverSwap2` flow,
whose operation ID and transaction hash are separate from the original source.
Taxi native drops require a successful `NativeDropApplied` from a reviewed Executor,
matching source/destination EIDs, TokenMessaging peers, message nonce, recipient and
successfully paid amount. The built-in executor pin currently covers Base; other chains
remain `partial` unless the app supplies explicitly reviewed `taxiExecutors` pins.
The pinned Base address is backed by official metadata, historical endpoint/EID reads,
code hash and immutable upstream Executor/IExecutor sources in `fixtures/recovery.json`.
Native drop and token payout may occur in different transactions; each receipt is
verified independently. Scan supplies hashes only, never payout authority.
Bus native drops require matching TokenMessaging drop events
and one authenticated Endpoint `PacketDelivered` in the destination receipt. Ambiguous
batch attribution or failed drops remain `partial` even when the token was paid.
`fixtures/recovery.json` includes a real Arbitrum → Ethereum cached native-token
delivery and its later `retryReceiveToken` payout, with historical commitment reads
before/after the retry. It also includes an Arbitrum → Base Taxi transfer whose token
and native-drop payouts are independently checked. Synthetic mutations are labelled.

Bus tracking replays four historical batches containing twelve passengers: three
Base → Arbitrum batches (mixed ETH/USDC and one native drop), plus a Base → Ethereum
batch delivered by a direct permissionless `Endpoint.lzReceive` call. The latter records
the pending payload commitment before execution and its clearing afterwards, and replays
the actual recovery calldata through both passengers' tracker/recovery paths. It proves
manual execution of a verified pending message; it does not claim an earlier reverted
execution attempt. These records are in `fixtures/bus-receipts.json`.
`fixtures:bus` refreshes these fixed GUIDs with read-only receipt, block and log queries.
The runtime links the source `BusRode` ticket to its exact seat in the driven packet.
Because `OFTReceived` omits the seat, it checks the complete ordered payout/cache sequence
for that asset; two identical passengers cannot claim each other's payment. Later cached
token retries must also match the exact pool calldata and seat.

Default Bus discovery scans at most eight pages of 2,000 blocks. Apps can configure
`busLogPageSize`/`busLogPages` or supply `findBusDrive` and `queuedBusPassengers` indexer
callbacks for older queues. Hints never replace receipt verification or the current
on-chain queue hash-chain commitment. Queue wait time remains unknown.

`stargatePins(config)` requires the client's own source/destination RPCs and reviewed
registry. It verifies the entire canonical `sendToken` calldata, including mode,
recipient, amount, minimum, refund address, options, native value and spender.
Remote builds additionally recheck current chain state and fees on the client,
including after the backend's preflight. A backend cannot substitute that check.
`getQuotes` enumerates Taxi only for previews; an explicit retired Bus selector is refused without fallback.

Bus acceleration assembles the valid current queue prefix through the user's ticket,
checks its hash chain and obtains `quoteDriveBus`. It reviews a separate source-chain
payment for the entire prefix, with gas additional. The current queue and exact fee are
revalidated after review, including competing drives. No offer is returned if the ticket
cannot fit in the next permitted batch or indexed passenger bytes are incomplete.
See [TokenMessaging](https://github.com/stargate-protocol/stargate-v2/blob/414f47412123d7737520c6ba331c1376ec874a88/packages/stg-evm-v2/src/messaging/TokenMessaging.sol)
and [Bus events](https://github.com/stargate-protocol/stargate-v2/blob/414f47412123d7737520c6ba331c1376ec874a88/packages/stg-evm-v2/src/libs/Bus.sol).

## Gas estimate

Quotes carry no `gasEstimate`: a quote is read on-chain (`quoteOFT` / `quoteSend`), which names no source-transaction
gas (`sourceGas: null`, `approvalGas: null`), and no Stargate or LayerZero API answer is read for one. The quote has no
`txRequest.gasLimit`; the wallet estimates the transaction.

## Integration boundaries and remaining work

### Wallet history

The provider's `describeActivity` hook is used by both the standalone protocol and
the router. Confirmed local legs require the original receipt in
`ChainTx.raw.tx.receipt`, as supplied by history-evm RPC/Alchemy enrichment. It checks
receipt/log identity and reads `OFTSent` / `OFTReceived` only from the reviewed pool.
Bus deposits are labelled queued; incoming payouts are labelled received. A separate
owned `BusDriven` transaction is shown as a queue payment. These are local history
items, not an assertion that the full cross-chain intent is complete.

Assets use actual event amounts, excluding messaging fees from the bridged principal.
The history fee contains the owner's transaction gas when available (plus the attached
payment for a Bus drive); it does not reconstruct messaging refunds or native drops.
The destination executor's gas is never charged to the recipient in history. Ordinary
token movements, cached-token events and confirmed transactions without receipt
enrichment are left to generic history. Pending/failed direct `sendToken` calls can
be labelled without fabricating successful asset movements.

### Remaining stages

- SDK-323: implemented reviewed registry and evidence collection for the current
  supported intersection; coverage and explicit exclusions are listed above.
- SDK-324: core/router now support optional display candidates, stable `routeId`,
  `using(provider, routeId)`, sealed remote candidates and pinned requotes. Existing
  `getQuote`, `using(provider)` and tracking IDs remain compatible. Stargate's
  provider now implements these hooks.
- SDK-325: core now provides application-owned atomic journals, read-only reconciliation
  and a separate reviewed/value-bounded EVM recovery path. Stargate supplies the
  on-chain validators and recovery offers described under SDK-328/329. Old `awk1` IDs and zero-value
  claims retain their existing contracts.
- SDK-326/327: direct quoting, execution and client pins are implemented and tested.
  SDK-328: Taxi payout tracking, cached-token recovery and native-drop evidence are
  implemented, with recorded recovery and Base native-drop receipts/state.
- SDK-329: Bus ticket/batch/passenger tracking, native-drop evidence and paid queue
  recovery are implemented. Historical batches and manual endpoint execution are replayed;
  queue races and duplicate-passenger/cache cases also use labelled synthetic evidence.
- SDK-330/SDK-331: API discovery and resumable steps, key held server-side. Include only
  routes for which every wallet operation has a validator. EVM multicall, signatures
  and fresh Solana transactions need separate adapters. Unknown VM steps fail closed.
- SDK-332: executable compose route (opt-in) built on the Ethereum LI.FI composer evidence
  adapter: SDK-encoded intent, client preflight, router candidate, journalled execution,
  `completed` / `partial` tracking and a gas-bounded `lzCompose` retry, verified on mainnet
  forks and one funded mainnet transfer (Arbitrum USDC → Ethereum DAI). Other DEX variants
  and composers remain out of scope.
- SDK-333: history, documentation, exports, module registry entry, changeset and conformance
  are in place. Funded Taxi transfers passed in both directions (Arbitrum ⇄ Base USDC) with a
  fresh-process resume. Published as 0.1.0 on 2026-11-17; a funded native ETH transfer and
  validation of the persistent journal on a mobile device are still owed.

The shared `pnpm test:hermes` smoke includes Stargate bigint/dust and uint72 ticket
handling, recorded cached-token recovery receipts, native-drop tuple decoding and
LayerZero public discovery, compose success/fallback and canonical DEX pool validation.
It passed 370 checks in the React Native 0.81.5 Hermes VM.
This offline VM check does not replace a mobile end-to-end transfer.

Stage 1 remains open for authenticated API contract fixtures. Taxi native-drop executor
coverage beyond Base requires separately reviewed pins. The collection commands above
never send transactions; only `verify-mainnet.mjs --send` does.

Protocol documentation: [Stargate integration](https://docs.layerzero.network/v2/developers/evm/stargate/overview),
[Value Transfer API](https://docs.layerzero.network/v2/developers/value-transfer-api/overview).
