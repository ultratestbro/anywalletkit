# @anywalletkit/protocol-swap2-near-intents

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-swap2-near-intents?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-near-intents)

NEAR Intents (1Click) cross-chain swaps as a swap2 module: the wallet sends the
source asset to a one-time deposit address, the solver network settles on
NEAR and delivers on the destination chain. Standalone through
`NearIntentsSwap2Protocol`, or as one provider of the router.

## Install

```sh
npm install @anywalletkit/protocol-swap2-near-intents @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-swap2-near-intents @anywalletkit/core  ·  yarn add @anywalletkit/protocol-swap2-near-intents @anywalletkit/core
```

On npm: [@anywalletkit/protocol-swap2-near-intents](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-near-intents), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

## Credit a NEAR Intents (near.com) account

By default 1Click withdraws the output to `destAddress` on `destChain`. With `recipientType: "INTENTS"` it credits the
NEAR Intents account `destAddress` inside `intents.near` instead, the account a near.com user holds (`nearcom:0x…`
in near.com is the `0x…` account here). Nothing is withdrawn: the asset stays in that account as the intents token,
so `destChain` must be `near:mainnet` (another chain is refused, so a review never names a chain the output does not
reach) and `destToken` may be the token id itself, e.g. `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near`
for Base USDC held in intents.

```ts
const toNearCom = nearIntentsProvider({recipientType: "INTENTS"});
await toNearCom.getQuote({
  sourceChain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", sourceToken: "USDC",
  destChain: "near:mainnet", destToken: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  destAddress: "0x63428e70a8016d10e8e2f7da440c898063afa299", amountIn: "5000000", refundAddress, dry: false,
});
```

near.com keeps user funds in the Confidential Intents balance. `recipientType: "CONFIDENTIAL_INTENTS"` credits that
balance directly (1Click settles it with a signed transfer intent). 1Click serves it to partners only, so the provider
requires `jwt` in this mode and throws at construction without it.

`destAddress` must be a NEAR Intents account id: a named account (`alice.near`), an implicit id (64 lowercase hex) or
an implicit `0x` id (40 lowercase hex); anything else, a top-level name or a chain address such as `bc1q…` included,
is refused before a request is sent. Because the output never reaches the destination chain, a corridor paused for that chain does not block an
intents token id.

## Behind `remoteProvider`

When the provider runs on your server, spread its pins into the app's stub:
`remoteProvider({name: "near_intents", baseUrl, ...nearIntentsPins})`. Every 1Click route pays a deposit address
minted per quote, which nothing can pin ahead: `nearIntentsPins` call no contract, approve no spender, and open the
stub to deposit-address routes (`depositAddressRoutes`). Without it the engine refuses them. The deposit address is
your server's word, so run the server you trust.

## Activity

Most 1Click legs leave no stable on-chain marker: the source leg is a plain
transfer to a deposit address that exists for one swap, and the destination
leg is a plain transfer from a solver / bridge account that changes per swap
(on Ethereum the wallet's arrivals came from Relay's router or solver EOAs; on
TON from fresh addresses). `describeActivity(tx, ctx)` therefore returns null
for EVM / TON / Solana / Tron / BTC — the kit's intent journal (the `intentId`
returned by `swap2()`) ties those transfers back to the swap, and the generic
fallback shows them as send / receive.

What it does recognize is the NEAR side, where the settlement contract is
fixed: a NEP-141 transfer between the owner and `intents.near` →

- owner → `intents.near` (`ft_transfer_call` deposit): `bridge`, "Bridged wNEAR";
- `intents.near` → owner (`execute_intents` / `ft_withdraw`): `bridge`,
  "Received JAMBO via NEAR Intents".

Subtitle "NEAR Intents", counterparty `intents.near`.

Fixtures (`fixtures/activity/`): two public NEAR transactions from nearblocks
(a 20.5 wNEAR deposit through the `bridge-mng.near` relayer, a 231 JAMBO
withdrawal — the test wallet has no NEAR account); negatives: the LI.FI
Diamond's NEARIntents facet on Ethereum (LI.FI's transaction, not this
module's) and the test wallet's own 13.9 USD₮ 1Click deposit on TON, which must
stay unrecognized.
