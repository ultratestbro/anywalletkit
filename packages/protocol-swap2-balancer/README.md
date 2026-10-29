# @anywalletkit/protocol-swap2-balancer

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-swap2-balancer?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-balancer)

Balancer v2 same-chain swaps as a swap2 module: Smart Order Router paths from
the Balancer API, `queryBatchSwap` on the Vault for the on-chain quote,
`batchSwap` execution, on the chains in `BALANCER_V2_CHAINS` (Vault `WETH()`
verified before use). Standalone through `BalancerSwap2Protocol`, or as one
provider of the router.

## Install

```sh
npm install @anywalletkit/protocol-swap2-balancer @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-swap2-balancer @anywalletkit/core  ·  yarn add @anywalletkit/protocol-swap2-balancer @anywalletkit/core
```

On npm: [@anywalletkit/protocol-swap2-balancer](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-balancer), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

## Behind `remoteProvider`

When the provider runs on your server, spread its pins into the app's stub:
`remoteProvider({name: "balancer", baseUrl, ...balancerPins})`. The engine then lets the EVM route call and
approve only the Balancer V2 Vault, never an address the backend names; without the pins the stub gets no
EVM calldata route (fail closed). The pins carry `verifyQuote: balancerVerifyQuote`, which opens the Vault call on
the device: only `batchSwap` of kind GIVEN_IN, no internal balances or pool `userData`, at most
`BALANCER_MAX_SWAPS` hops, funds from this account to the recipient, the hops selling exactly the input of the
source token, and limits of exactly the input in and the quote's minimum out. `manageUserBalance`,
`setRelayerApproval`, `swap` and every other Vault call are refused.

## Activity

`describeActivity(tx, ctx)` recognizes `batchSwap` `0x945bcec9` and `swap`
`0x52bbbe29` on the Vault (`0xBA12…2C8`, the same address on every chain) on a
chain this module serves, as `swap`, "Swapped A → B" from the owner's net
transfers (a native `value` leg included). Subtitle `Balancer v2 · <chain>`,
counterparty = the Vault.

Fixtures (`fixtures/activity/`, public Ethereum transactions — the test
wallet's Balancer runs were quote-only on the matrix): Vault `swap` COW → GNO,
`batchSwap` BAL → USDT (the call this module builds), `batchSwap` ETH → WNCG
with native input; negatives: a Uniswap `exactInputSingle`, a LI.FI swap.
