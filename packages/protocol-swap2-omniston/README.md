# @forgewallet/protocol-swap2-omniston

STON.fi Omniston as a swap2 module: TON ↔ TON swaps settled on the STON.fi DEX,
and TON ↔ EVM and EVM ↔ EVM stable orders settled through HTLC escrows
(resolver Arbiter), over the Omniston WebSocket RFQ. Standalone through
`OmnistonSwap2Protocol`, or as one provider of the router.

EVM chains: Ethereum, BNB, Polygon, X Layer, HyperEVM, Robinhood, Base, Plasma,
Arbitrum, Avalanche. ARC (in Omniston's matrix) waits for the asset catalog;
TRON needs its own order path and is not wired yet.

## Routes and their gates

Every route is fail-closed until its allowlists and validators are configured:

- **TON → TON** (DEX swap): `trustedSettlementContracts["ton:-239"]`,
  `validateTonJettonWallet`, `validateTonSwapTarget`. The built message's DEX
  call is decoded in the package (STON.fi v1/v2 incl. pTON and cross-swap,
  DeDust v1, DeDust CPMM v2): receiver = destination, refunds/excess = trader,
  on-chain minimum ≥ the quote's, no foreign referral; unknown layouts and
  split/multi-route quotes are refused by name. `validateTonSwapLeg`
  (supplied by `createOmnistonTonValidators`) confirms the routers' ask
  wallets, pTON wallet ownership and DeDust pool pairs on chain.
  `tonSwapPayloadCheck: "report"` traces `ton-swap-payload <reason>` instead
  of refusing (default `"enforce"`).
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

`@forgewallet/protocol-swap2-omniston/validators` ships the RPC/indexer-backed
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
discloses it.

The destination-escrow proof requires the escrow immutables to be found in the
resolver's calldata AND to derive, through the trusted factory's
`addressOfEscrowDst` (deployedAt stamped with the block timestamp), to the
escrow address the factory announced; a decoy tuple or hidden immutables fail
closed.

## Activity

`describeActivity(tx, ctx)` recognizes TON-side transactions by their
counterparty (compared in raw form, so `EQ…`, `UQ…` and `0:…` all match), looking
at the destination contract and both sides of every transfer:

- STON.fi DEX router (`STONFI_ROUTERS` in `src/activity.ts`; v2.2
  `EQCS4UEa…cN3` is what the wallet's swaps hit, v1 kept for older history) →
  `swap`, "Swapped GRAM → USD₮" / "Swapped USD₮ → GRAM", subtitle "STON.fi · TON".
- Omniston HTLC escrow (`OMNISTON_ESCROWS`, the Escrow Minter
  `EQAbWJ3Y…mrZ` that every live quote names as `srcProtocolContractAddress`) →
  `bridge`, "Bridged USD₮", subtitle "Omniston · STON.fi". The EVM leg is paid by
  the resolver and is not recognizable offline.

EVM → TON: the EVM leg is an off-chain signature (no transaction to
recognize); the delivery is a jetton transfer from the same escrow contract and
shows up as `bridge`. Nothing on EVM is recognized.

Fixtures (`fixtures/activity/`, test wallet `UQCbXJ1-…fQaq`, tonapi events):
two STON.fi swaps (GRAM → USD₮, USD₮ → GRAM) and one escrow order (1.6 USD₮);
negatives: a 1Click deposit on TON (a plain jetton transfer to a one-time
address — must stay null) and an EVM LI.FI swap.
