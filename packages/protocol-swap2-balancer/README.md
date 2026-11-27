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

## Quoting at one block (`blockNumber`)

`QuoteParams.blockNumber` (0.4.0; a decimal block of the source chain, read by the app once per comparison
round): the Vault's `queryBatchSwap`, which is the quote's price, runs at that block, and the quote names it
(`Quote.blockNumber`; the provider declares `honorsBlockNumber: true`). The SOR's paths come from the Balancer API as
before (it has no block); the Vault prices them at the block. At "latest" whatever it says: the Vault's `WETH()`
check and `preflightDeposit`, which re-prices the signed batch right before signing.

A node that does not have the block ("header not found", "block not found", a null result, an HTTP 400 "block is out
of range") or no longer keeps its state ("missing trie node", "No state available for block …", publicnode's HTTP 403
for archive state) fails its endpoint and the next one is asked; with none left the quote is refused as `stale_node`,
the block named: "balancer: no RPC answered on chain 1 (block 26510020 is not served by the node (header not
found))". It is never priced at "latest" instead. A revert of the batch is still the Vault's answer
(`simulation_failed`). Every chain of `BALANCER_V2_CHAINS` takes a block number (2026-11-28). Pass it in the
comparison round only (latest, or latest − 1 on fast chains whose nodes trail), not on the execution re-quote. Without
it every request is 0.3.13's, byte for byte (`tests/block-number.test.ts` against `fixtures/unpinned-0.3.13.json`).

## Live check

`pnpm verify:live [chainId …]` (after `pnpm build`; `RPC_<chainId>=url[,url]` replaces the public RPCs): per chain
of `BALANCER_V2_CHAINS`, the chain id and the Vault's `WETH()` against the pin; on every endpoint, an `eth_call` at
head − 2 must answer that block's own number and one at head + 100,000 must be refused (a node that ignores the tag
answers both); and 0.1 of the native coin → USDC at head − 1 must come back naming that block (required on Ethereum
and Base; elsewhere the SOR having no route is reported). Read-only: `eth_call`, `eth_blockNumber` and the SOR query.

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
