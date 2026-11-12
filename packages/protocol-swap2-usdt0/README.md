# @anywalletkit/protocol-swap2-usdt0

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-swap2-usdt0?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-usdt0)

[USDT0](https://docs.usdt0.to) — Tether's USDT as a LayerZero OFT — as a swap2
provider: USDT / USDT0 between 16 EVM chains in **one source transaction**, and
USDT from Ethereum / Arbitrum / Celo into **TON** — and into **Tron**, opt-in —
through the USDT0 Legacy Mesh (see below).
`send(SendParam, MessagingFee, refund)` on the chain's OFT with the LayerZero
messaging fee as `msg.value`; LayerZero's DVNs verify the packet and the
executor delivers on the destination (USDT0 minted, or USDT released from the
Ethereum adapter). No spread, no protocol fee today — the only cost is the
LayerZero fee in the source chain's native coin (≈ 0.0000024 ETH for
Arbitrum → HyperEVM on 2026-10-20). It is the only direct USDT path into
HyperEVM.

## Install

```sh
npm install @anywalletkit/protocol-swap2-usdt0 @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-swap2-usdt0 @anywalletkit/core  ·  yarn add @anywalletkit/protocol-swap2-usdt0 @anywalletkit/core
```

On npm: [@anywalletkit/protocol-swap2-usdt0](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-usdt0), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

```ts
import {usdt0Provider} from "@anywalletkit/protocol-swap2-usdt0/provider";
import {RouterSwap2Protocol} from "@anywalletkit/protocol-swap2-router/swap2/router";

const swap2 = new RouterSwap2Protocol(arbitrumAccount, {fromChain: "eip155:42161", providers: [usdt0Provider({rpcUrls})]});
const res = await swap2.swap2({fromToken: "USDT0", toToken: "USDT0", toChain: 999, fromTokenAmount: 10_000_000n, minAmountOut: 10_000_000n});
// … poll …
const status = await swap2.getSwap2Status(res.id);   // "pending" → "completed" with the HyperEVM delivery hash
```

`rpcUrls` (CAIP-2 → URL or URLs) is required for every chain the provider
quotes **from**: the fee and the received amount come from the OFT itself,
not from an API.

## What the provider does

- **Quote** = two `eth_call`s on the source OFT. `quoteOFT(SendParam)` gives
  the limits, any OFT fee rows and `amountReceivedLD` — what really arrives
  after dust removal (shared decimals = 6 on every deployment, so nothing is
  removed today). That amount becomes `minAmountLD`, and `quoteSend` prices
  the message with it. The contract reverts rather than deliver less.
- **Calldata is sealed in the quote**: `send(SendParam{dstEid, to, amountLD,
  minAmountLD, extraOptions: 0x, composeMsg: 0x, oftCmd: 0x}, {nativeFee, 0},
  refundAddress)`, `value` = `nativeFee` = the quoted LayerZero fee **+ 25 %
  headroom** — the fee is paid at send time and moves with gas (live: +1.7 % in
  a minute on Ethereum); OAppSender needs `msg.value == nativeFee` and the
  endpoint refunds the unused part to `refundAddress` in the same transaction
  (declared as `txRequest.nativeFee`
  so the engine caps it per chain and the router prices it). `extraOptions`
  stays empty: every deployment's `enforcedOptions` already carry the
  executor gas (type-3, `lzReceive` gas 80 000, read on-chain 2026-10-20).
- **Approvals**: Ethereum locks USDT in an OFT *adapter* (`approvalRequired()`
  = true) → `approvalAddress` is the adapter, exact amount. Every other chain's
  OFT burns the caller's USDT0 through the token's mint/burn role
  (`approvalRequired()` = false) → no approval at all.
- **Bound on-chain**: before the first quote on a chain the OFT's `token()`
  and `approvalRequired()` must match `config.ts`; per pair, `peers(dstEid)`
  must be the destination OFT. A mismatch refuses the route with its reason.
- **Preflight** (right before signing): target is the source OFT, peer still
  wired, and the *current* `quoteSend` fee still fits the sealed `value` —
  the endpoint reverts an underpaid send, so a fee past the headroom means re-quote.
- **Tracking**: LayerZero Scan `GET /v1/messages/tx/{sourceTxHash}`, matched
  to the route's eids and the source OFT. `INFLIGHT` / `CONFIRMING` /
  `BLOCKED` → pending; `DELIVERED` → completed with the destination hash;
  `PAYLOAD_STORED` → action-required; `FAILED` and the burned / skipped /
  malformed statuses → failed; a hash whose message belongs to another
  pathway → failed.
- **Claim** (`buildClaim`, through the engine's `claimSwap2`): a delivery that
  reverted on the destination is stored by the endpoint and can be retried
  by anyone — `EndpointV2.lzReceive(origin, receiver, guid, message, 0x)` with
  the exact packet Scan recorded, on the destination chain. Null otherwise.
- **Deployments** (docs.usdt0.to, every address re-read on-chain 2026-10-20):
  Ethereum (eid 30101, adapter), Arbitrum 30110, OP Mainnet 30111, Polygon
  30109, HyperEVM 30367, Ink 30339, Berachain 30362, Unichain 30320, Sei
  30280, Plasma 30383, Monad 30390, MegaETH 30398, X Layer 30274, Mantle 30181, Morph 30322, Flare 30295. USDT0 is also live on
  Conflux eSpace, Hedera, Rootstock, Stable, Tempo, HyperCore, IOTA and Stellar —
  not wallet chains here yet.
  OP's catalog `USDT` is the legacy bridged token (not the OFT); `USDT0` is.

## Legacy Mesh: USDT into Tron and TON

The [USDT0 Legacy Mesh](https://docs.usdt0.to/overview/the-legacy-mesh) moves Tether's USDT between pools where it was
never replaced by an OFT. This package sends **from EVM only**: Ethereum USDT, Arbitrum USDT0 and Celo USD₮ into
**TON** (`ton:-239`, eid 30343) and **Tron** (`tron:728126428`, eid 30420). Tron and TON are destinations only: no pair
starts there.

```ts
const q = await usdt0Provider({rpcUrls}).getQuote({
  sourceChain: "eip155:42161", sourceToken: "USDT0", destChain: "ton:-239", destToken: "USDT",
  amountIn: "10000000", destAddress: "UQ…", refundAddress: "0x…", dry: false,
});
```

- **`meshDestinations`** (provider option, also on `Usdt0Swap2Protocol` and the `usdt0.supports*` helpers): which
  destinations are offered. Default `["ton"]`; `["tron", "ton"]` adds Tron; `[]` leaves the mesh out. **Tron is opt-in**
  because the LayerZero fee into Tron is above the swap2 engine's native-fee ceiling (0.005 ETH on Ethereum / Arbitrum,
  100 CELO on Celo; live 2026-11-12 the fee is ≈ 0.0053 ETH / ≈ 170 CELO before the 25 % headroom), so `swap2` refuses
  to execute it (`quoted native fee … exceeds the cap …`) and a router would list a route that cannot run. Turn it on
  only where that send can be executed (the ceiling raised in `protocol-swap2-core`, or a signer outside the engine).
  A destination left out is not routed (`supportsChain` / `supportsRoute` false) and `getQuote` answers it as before
  the mesh: "USDT0 is not deployed on this chain" — as it does for a Tron / TON source and for an EVM source without a
  mesh OFT (BNB Chain, OP, HyperEVM …); `usdt0VerifyQuote` keeps "not a USDT0 route between two deployments" for those.
- **Celo** sends Tether's USD₮ `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` (the mesh OFT's `token()`), which the swap2
  catalog does not list (its Celo `USDT` is a bridged token, refused). `getQuote` takes it by contract; through the
  engine (`Usdt0Swap2Protocol` or the router) name it as `fromToken` with `allowUnlistedTokens: true` and either an
  account with `getTokenInfo` or `fromTokenDecimals: 6`. Catalog-driven token pickers will not offer it.
- **Contracts** (docs.usdt0.to deployments API `usdt0.legacyMesh`, Sourcify source `UsdtOFT`, re-read on-chain
  2026-11-12): the `UsdtOFT` on Ethereum `0x1F74…dFB0`, Arbitrum `0x7765…9B92`, Celo `0xf10E…b243` (not proxies); each
  peers the Tron OFT `TFG4wB…zevLPt` and the TON OFT `EQAd31…jX6Gq`. Before the first quote the OFT's `token()` and
  `approvalRequired()` (= true: it pulls the token, so the send approves that OFT), per pair `peers(eid)` = the pinned
  destination OFT; a mismatch refuses the route.
- **Quote**: `quoteOFT` — `maxAmountLD` is the pool's credit toward the destination (what it can pay out there now),
  received = amount − `feeBps` (3 → 0.03 %), listed as a `protocol` fee "USDT0 Legacy Mesh fee" — then `quoteSend` for
  the LayerZero fee (+ 25 % headroom, refunded). Nothing is hard-coded. Live 2026-11-12: into TON ≈ 0.000056 ETH
  (1.74 CELO), into Tron ≈ 0.00534 ETH (170 CELO) — the Tron executor is expensive.
- **Recipient**: Tron base58check `T…` → its 20 account bytes left-padded to bytes32 (the Tron OFT pays
  `address(uint160(uint256(to)))`); TON raw `0:…` or user-friendly `EQ…` / `UQ…` → the 32-byte account hash. The bytes32
  holds no workchain: the TON OFT pays on workchain 0, so `-1:…` and testnet-flagged addresses are refused. Both were
  reproduced from real delivered packets (LayerZero Scan) and the address the destination paid (TronGrid, toncenter).
  The built `send` is decoded back and compared with the request before it is returned (`usdt0VerifyMeshSend`).
- **Preflight**: target, the sealed send in the calldata, chain + peer, and the current `quoteSend` (which reverts with
  `InsufficientCredits` when the pool can no longer pay) within the sealed value.
- **Status**: the LayerZero Scan message (intent `usdt0-mesh:<srcEid>:<dstEid>`). Tron pays inside `lzReceive`, so
  `DELIVERED` is completed. TON pays with a jetton transfer later in the trace: `DELIVERED` completes only when
  `GET {tonApiUrl}/v2/events/{destination hash}` (default `https://tonapi.io`, no query string) shows the TON OFT's USDT
  transfer of the packet's amount to the packet's recipient; a failed one is `failed`, anything else stays `pending`.
  A stored payload stays `pending` (its retry is on Tron / TON, which this package does not sign); no `buildClaim`.
- **Engine fee ceiling**: into TON fits (≈ 0.00007 ETH / 2.2 CELO sealed); into Tron the LayerZero fee alone is above
  it today — hence `meshDestinations`. With Tron turned on the provider quotes it with the real fee.
- **Sending from Tron / TON** (not built): it needs the Tron OFT's `send` signed by `wallet-tron` (a TRC-20 approval +
  a contract call with TRX for the fee) and the TON OFT's message built and signed by `wallet-ton`, plus an EVM / Tron /
  TON recipient encoder on the way back.

`pnpm verify:live:mesh` re-reads the mesh pins on-chain, quotes 10 and 1000 USDT from every source into Tron and TON
(decoded back, with the preflight), follows four real delivered transfers to `completed`, and checks the default
provider (Tron not offered, no RPC call; TON quoted) and each sealed fee against the engine's ceiling.

## Tests

`pnpm test` — provider tests over a fake JSON-RPC + fake LayerZero Scan
(route gating, quote maths incl. dust and OFT fee rows, calldata binding,
every named refusal, on-chain binding failures, preflight, the whole
pending → completed / action-required / failed lifecycle, the `lzReceive`
claim, the router snapshot) and the conformance suite incl. the behaviour
fixture (the engine executes exactly the reviewed plan, no approval).
`USDT0_LIVE=1 pnpm test` adds a live read-only quote on Arbitrum.
`pnpm verify:live` re-reads all 13 deployments on-chain and quotes
10 USDT0 Arbitrum → HyperEVM with the preflight.

## Status

2026-10-20: built, tests green, all 13 deployments verified on-chain, live
quote + preflight verified. No funded transfer yet (plan: 10 USDT Arbitrum →
HyperEVM from the phone, then the status through LayerZero Scan).

## Behind `remoteProvider`

When the provider runs on your server, spread its pins into the app's stub:
`remoteProvider({name: "usdt0", baseUrl, ...usdt0Pins})`. The engine then lets the EVM route call and
approve only the USDT0 OFT (and, on Ethereum, the adapter as spender) or, on Ethereum / Arbitrum / Celo, the Legacy
Mesh OFT (call target and spender), never an address the backend names, and
`usdt0VerifyQuote` decodes the server's `send` on the device: the destination eid, the recipient, the input, a
`minAmountLD` that keeps the quoted minimum, no options or compose message, the trader as refund and the declared
native fee as value; a route into Tron / TON is held to `usdt0VerifyMeshSend` (the mesh OFT of that chain, the
destination eid, the recipient read back as the Tron / TON OFT reads it). Without the pins the stub gets no EVM
calldata route (fail closed).

## Activity

`describeActivity`: `send` on the OFT → "Bridged USDT0" ("Bridged USDT" on
Ethereum); the executor's delivery (USDT0 minted to the owner, or USDT
released by the adapter, in a transaction the owner did not send) → "Received
USDT0 via LayerZero"; the owner's own `lzReceive` retry → the same; `send` on a
Legacy Mesh OFT → "Bridged USDT0 → USDT" with "USDT0 Legacy Mesh · Arbitrum →
Tron" (the destination from the calldata's eid). Fixtures
are recorded mainnet transactions (`fixtures/activity`).
