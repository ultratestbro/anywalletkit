# @anywalletkit/protocol-swap2-omniston

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-swap2-omniston?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-omniston)

STON.fi Omniston as a swap2 module: TON ↔ TON swaps settled on the STON.fi DEX,
and TON ↔ EVM and EVM ↔ EVM stable orders settled through HTLC escrows
(resolver Arbiter), over the Omniston WebSocket RFQ. Standalone through
`OmnistonSwap2Protocol`, or as one provider of the router.

## Install

```sh
npm install @anywalletkit/protocol-swap2-omniston @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-swap2-omniston @anywalletkit/core  ·  yarn add @anywalletkit/protocol-swap2-omniston @anywalletkit/core
```

On npm: [@anywalletkit/protocol-swap2-omniston](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-omniston), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

EVM chains: Ethereum, BNB, Polygon, X Layer, HyperEVM, Robinhood, Base, Plasma,
Arbitrum, Avalanche. ARC (in Omniston's matrix) waits for the asset catalog;
TRON needs its own order path and is not wired yet.

## Routes and their gates

Every route is fail-closed until its allowlists and validators are configured:

- **TON → TON** (DEX swap): `trustedSettlementContracts["ton:-239"]`,
  `validateTonJettonWallet`, `validateTonSwapTarget`, `validateTonSwapLeg`. The built message's DEX
  call is decoded in the package (STON.fi v1/v2 incl. pTON and cross-swap,
  DeDust v1, DeDust CPMM v2): receiver = destination, refunds/excess = trader,
  on-chain minimum ≥ the quote's, no foreign referral; unknown layouts and
  split/multi-route quotes are refused by name. `validateTonSwapLeg`
  (supplied by `createOmnistonTonValidators`) confirms the routers' ask
  wallets, pTON wallet ownership and DeDust pool pairs on chain.
  Without it the decoder cannot tell which token the DEX pays out, so the
  route is not advertised. `tonSwapPayloadCheck: "report"` traces
  `ton-swap-payload <reason>` (incl. `legs-unverified`) instead of refusing
  (default `"enforce"`) — an explicit rollout opt-in.
  Behind `remoteProvider`, the app checks the built body itself:
  `remoteProvider({name: "omniston", baseUrl, verifyBuild: omnistonVerifyBuild({...createOmnistonTonValidators()})})`.
  A TON → TON swap body is opened with `checkTonSwapPayload` against the app's own request (receiver,
  refund, on-chain minimum, input; the quote carries `routeSteps`) and the DEX it pays is confirmed with
  the app's validators — `validateTonSwapTarget` and `validateTonSwapLeg`; without the leg check a TON swap body
  is refused. A TON → EVM escrow body goes to `verifyTonEscrowBuild`: the jetton amount, the
  trader as owner, the destination chain, address and token and the quote's minimum delivery come from
  the app, the protocol contract from `trustedProtocolAddresses`, and the escrow code, authority key and
  timelocks are the audited ones. Without `verifyBuild` the engine refuses remote cell bodies.
- **TON → EVM** (HTLC order, the wallet pays a jetton escrow): factory
  allowlisted on both chains, `validateTonJettonWallet`,
  `validateTonEscrowPayload`, `validateEvmOutputPosition`.
- **EVM → TON** (gasless order): the wallet approves the Omniston order
  protocol (a 1inch Limit Order Protocol v4 fork, `trustedEvmOrderProtocols`
  per chain — a different table from the factories, since one address plays
  different roles on different chains) and signs an EIP-712 `Order`;
  `buildDeposit` returns a `typedData` `UnsignedTx` only after the order, the
  pinned v1beta8 extension and the serialized order details are verified
  against the quote, `registerSignedOrder` hands the signature to Omniston,
  and `trackIntent` discloses the HTLC secret only when
  `validateEvmInputPosition` (finalized `SrcEscrowCreated` + escrow state)
  AND `validateTonOutputPosition` (factory-deployed TON position with bound
  state, inside its completion window) both pass.
  Behind `remoteProvider` the order is built on your server, so the app pins
  the order protocols itself: `remoteProvider({name: "omniston", baseUrl,
  ...omnistonPins(trustedEvmOrderProtocols)})` — the same audited table. The
  engine then signs only an `Order` whose verifying contract is a pinned
  spender, whose maker is this account and that sells exactly the swap's input
  of the source token; a `Permit` or any other typed message is refused.
  The rest of the order is the app's to check, and the engine signs a remote
  typed order only with `verifyBuild`: `remoteProvider({name: "omniston",
  baseUrl, ...omnistonPins(AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS), verifyBuild:
  omnistonVerifyBuild({...createOmnistonTonValidators()})})`. The build carries
  the `orderExtension` the order's salt commits to, and `omnistonVerifyBuild`
  opens both: the v4 domain on a trusted order protocol, the exact Order schema,
  `takingAmount` at least the quote's minimum, a single-fill order with no
  allowed sender and an expiry minutes away, the pinned v1beta8 auction and fee
  terms, one trusted escrow factory (`trustedSettlementContracts`, default the
  audited table) as the extension target, the whitelisted resolver as the
  order's receiver, the destination chain and token, the audited timelocks, the
  TON token and recipient and the quote id. The hashlock is the server's: the
  server holds the HTLC secret. The same applies to EVM → EVM.
  `validateEvmTypedOrder` is exported for apps that hold the settlement data.
- **EVM → EVM** (gasless order, same order protocol as EVM → TON): the signed
  extension's ExtraDataArgs name the destination chain, token and deposit and
  are checked against the quote. The EVM recipient is NOT in anything the
  wallet signs (it rides in the unsigned order details), so the secret is
  disclosed only when `validateEvmInputPosition` (source fill, including the
  destination complement) AND `validateEvmOutputPosition` (an escrow the
  trusted factory derives from immutables that pay the recipient) both pass.
  The destination escrow's fee split must be exactly the quoted protocol and
  integrator fees, paid only to the quote's `protocolFeeRecipientAddress` /
  integrator, its destination stages must be 1/120/180 s, and the secret is
  not released within 45 s of its cancellation stage (refusal reasons go to
  the validator's `onRefusal`).

## Validators

`@anywalletkit/protocol-swap2-omniston/validators` ships the RPC/indexer-backed
validators every route above needs, plus the audited contract tables:
`createOmnistonEvmOutputValidator`, `createOmnistonEvmInputValidator`,
`createOmnistonTonValidators` (TonAPI), `createOmnistonEvmDeliveryLocator`
(feeds `locateEvmDelivery`: a completed EVM-destination order then carries
`destTxHash`, the escrow's payout to the recipient — Omniston's feed names the
escrow, not that transaction), `AUDITED_OMNISTON_SETTLEMENT_CONTRACTS`,
`AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS`. No deployment env is read: pass your
own endpoints as `rpcUrls` (CAIP-2 → URLs, tried before the public fallbacks)
and `tonApiUrl` / `tonApiKey`. On serverless also inject durable
`secretStore` / `quoteStore` — the HTLC secret must survive to the poll that
discloses it. Give the quote store a `claim` (an atomic create-if-absent: Redis
`SET NX`, a conditional KV put): the platform picks quote ids, and a context is
never rebound to another user's quote under the same id. A secret is disclosed
only against the exact order it was locked to (its stored binding), so even a
rebound context gets nothing.

The destination-escrow proof requires the escrow immutables to be found in the
resolver's calldata AND to derive, through the trusted factory's
`addressOfEscrowDst` (deployedAt stamped with the block timestamp), to the
escrow address the factory announced; a decoy tuple or hidden immutables fail
closed.

### Trusted TON contracts

TON ↔ EVM orders settle through Omniston's TON Escrow Minter. The audited
table (`AUDITED_OMNISTON_SETTLEMENT_CONTRACTS["ton:-239"]`) and the position
pin (`DEFAULT_OMNISTON_TON_CODE_HASHES.position`) trust rev2 only:

| Minter | Code | Positions it deploys (EVM → TON) | Quoted | Trusted by default |
|---|---|---|---|---|
| `EQDybO88l2lrrAmALRUqpmgEE_tuxk510F4Yd4xjbQZxC9IA` (rev2) | `9737943f…` | `eb503578…` | since 2026-11-10 | yes |
| `EQAbWJ3Y1HgIIvcMq1prG1anlDC0T3cZlAU7luPT6LmTpmrZ` (rev1) | `f91c43d3…` | `e4d5115a…` | until 2026-11-10 | no, since 2026-11-12 |

Omniston's resolvers moved to rev2 on 2026-11-10. rev2 checks the escrow and
execution code of every order against a whitelist built into the contract;
rev1 has no such whitelist. So a quote, a build or an output position on rev1
is refused by default ("untrusted TON settlement contract EQAbWJ3Y…",
"the escrow transfer pays EQAbWJ3Y…, not an Omniston protocol contract this
app trusts", `position-code-hash`). Both minters stay in `OMNISTON_ESCROWS`,
which recognizes history and grants no trust (see Activity).

An app that still has to settle an order on rev1 passes rev1 explicitly, and
takes it out again once that order is closed:

```ts
const REV2 = "EQDybO88l2lrrAmALRUqpmgEE_tuxk510F4Yd4xjbQZxC9IA";
const REV1 = "EQAbWJ3Y1HgIIvcMq1prG1anlDC0T3cZlAU7luPT6LmTpmrZ";
const ton = createOmnistonTonValidators({
  trustedProtocolAddresses: [REV2, REV1], // TON → EVM builds (verifyTonEscrowBuild)
  positionCodeHashes: [
    "eb503578b4d9cd791c9c0ecd0da6da4064aae2bcb19d3c924d4001c493386bc5", // rev2 positions
    "e4d5115a321ade7b827e38fb522c20d2f2cd46e4c6b0b5f7dd8b6b096792d77b", // rev1 positions
  ],
});
omnistonProvider({
  ...ton,
  trustedSettlementContracts: {...AUDITED_OMNISTON_SETTLEMENT_CONTRACTS, "ton:-239": [REV2, REV1]},
  // …
});
```

The provider compares TON addresses as strings, so a table of your own must
spell them exactly as above; it replaces the built-in table, so it must list
every network. A new minter is a new trust decision: its address goes into the
settlement table and the code of its positions into
`DEFAULT_OMNISTON_TON_CODE_HASHES.position` (`positionCodeHashes`), in the same
release. With the address alone, EVM → TON orders fill and then fail the check
before the secret is disclosed. The minters are admin-upgradable after a 7-day
delay; the module watch reads the code and data of every trusted minter daily.

## Activity

`describeActivity(tx, ctx)` recognizes TON-side transactions by their
counterparty (compared in raw form, so `EQ…`, `UQ…` and `0:…` all match), looking
at the destination contract and both sides of every transfer:

- STON.fi DEX router (`STONFI_ROUTERS` in `src/activity.ts`; v2.2
  `EQCS4UEa…cN3` is what the wallet's swaps hit, v1 kept for older history) →
  `swap`, "Swapped GRAM → USD₮" / "Swapped USD₮ → GRAM", subtitle "STON.fi · TON".
- Omniston HTLC escrow (`OMNISTON_ESCROWS`, the Escrow Minters a quote names as
  `srcProtocolContractAddress`: `EQAbWJ3Y…mrZ` until 2026-11-10, `EQDybO88…9IA`
  since; both stay listed for history, though only rev2 is trusted for new
  orders) → `bridge`, "Bridged USD₮", subtitle "Omniston · STON.fi". The EVM
  leg is paid by the resolver and is not recognizable offline. A refund
  backstop that looks for the input coming back from a minter should read this
  list too, not only the trusted table.

EVM → TON: the EVM leg is an off-chain signature (no transaction to
recognize); the delivery is a jetton transfer from the same escrow contract and
shows up as `bridge`. Nothing on EVM is recognized.

Fixtures (`fixtures/activity/`, test wallet `UQCbXJ1-…fQaq`, tonapi events):
two STON.fi swaps (GRAM → USD₮, USD₮ → GRAM) and one escrow order (1.6 USD₮);
negatives: a 1Click deposit on TON (a plain jetton transfer to a one-time
address — must stay null) and an EVM LI.FI swap.
