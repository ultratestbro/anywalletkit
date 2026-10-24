# @anywalletkit/protocol-swap2-usdt0

[USDT0](https://docs.usdt0.to) — Tether's USDT as a LayerZero OFT — as a swap2
provider: USDT / USDT0 between 16 EVM chains in **one source transaction**.
`send(SendParam, MessagingFee, refund)` on the chain's OFT with the LayerZero
messaging fee as `msg.value`; LayerZero's DVNs verify the packet and the
executor delivers on the destination (USDT0 minted, or USDT released from the
Ethereum adapter). No spread, no protocol fee today — the only cost is the
LayerZero fee in the source chain's native coin (≈ 0.0000024 ETH for
Arbitrum → HyperEVM on 2026-10-20). It is the only direct USDT path into
HyperEVM.

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

## Activity

`describeActivity`: `send` on the OFT → "Bridged USDT0" ("Bridged USDT" on
Ethereum); the executor's delivery (USDT0 minted to the owner, or USDT
released by the adapter, in a transaction the owner did not send) → "Received
USDT0 via LayerZero"; the owner's own `lzReceive` retry → the same. Fixtures
are recorded mainnet transactions (`fixtures/activity`).
