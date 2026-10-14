# @forgewallet/protocol-swap2-omniston

STON.fi Omniston as a swap2 module: TON ↔ TON swaps settled on the STON.fi DEX
and TON ↔ EVM stable orders settled through HTLC escrows (resolver Arbiter),
over the Omniston WebSocket RFQ. Standalone through `OmnistonSwap2Protocol`,
or as one provider of the router.

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

Not recognized: the EVM → TON direction (a 1inch-style order the wallet signs
off-chain) and anything on EVM.

Fixtures (`fixtures/activity/`, test wallet `UQCbXJ1-…fQaq`, tonapi events):
two STON.fi swaps (GRAM → USD₮, USD₮ → GRAM) and one escrow order (1.6 USD₮);
negatives: a 1Click deposit on TON (a plain jetton transfer to a one-time
address — must stay null) and an EVM LI.FI swap.
