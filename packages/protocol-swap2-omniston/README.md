# @forgewallet/protocol-swap2-omniston

STON.fi Omniston as a swap2 module: TON ↔ TON swaps settled on the STON.fi DEX
and TON ↔ EVM stable orders settled through HTLC escrows (resolver Arbiter),
over the Omniston WebSocket RFQ. Standalone through `OmnistonSwap2Protocol`,
or as one provider of the router.

## Routes and their gates

Every route is fail-closed until its allowlists and validators are configured:

- **TON → TON** (DEX swap): `trustedSettlementContracts["ton:-239"]`,
  `validateTonJettonWallet`, `validateTonSwapTarget`.
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
