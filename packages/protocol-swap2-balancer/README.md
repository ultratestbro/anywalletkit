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

## Gas estimate (`gasEstimate`)

The quote's `txRequest.gasLimit` stays 160,000 + 95,000 a hop. Next to it the quote says what the `batchSwap` is
expected to **use**, for ranking routes: protocol-swap2-core's `gasEstimate` with `gasEstimateSource: "model"` — gas
used, not a limit, no approval (whoever prices the route adds that). The Vault's `queryBatchSwap` measures no gas, so
the figure is a measured table (`src/gas.ts`, exported as `BALANCER_GAS_BASE` / `BALANCER_HOP_GAS`): a base for the
call — the intrinsic 21,000, the calldata, the Vault's entry and its net settlement (the input pulled from the sender,
the output paid to the recipient, WETH wrapped or unwrapped for the native coin) — plus one cost per hop by the
pool's specialization, which the pool id carries (bytes 20–21). No request more: the SOR query and the Vault calls
are unchanged. Nothing in execution reads it.

| Part | Gas |
|---|---|
| base (every batch) | 80,000 |
| hop through a two-token pool (specialization 2) | 36,400 |
| hop through a minimal-swap-info pool (1: weighted pools of three or more tokens, for example) | 40,500 |
| hop through a general pool (0: the Vault passes every balance — composable stable pools, for example) | 95,500 |

**How it was measured** (read-only, 2026-11-28; scripts and raw results kept outside the repo): the module's own
quotes — SOR paths priced by `queryBatchSwap` — on 29 pairs on Ethereum, Arbitrum, Base and OP Mainnet (one to four
hops, native in and out included), each simulated with `eth_simulateV1` from a fresh account funded by a state
override as `[approve(Vault, exactly the input), batchSwap]`, ERC-20 outputs twice: to a recipient holding none of the
token and to one holding some. The recipient's balance slot written from zero costs 17,100; the table sits halfway.
The table is a least-squares fit of those pairs (Huber-weighted). Real `batchSwap` transactions sent straight to the
Vault are rare — almost every Balancer swap comes through an aggregator, whose own gas its receipt includes: of the
8,000 Vault swap transactions looked up on six chains, two on the measured chains were a `batchSwap` sent straight to
the Vault (a few more were single `swap` calls, an entry point this module does not use); both are kept as the check.

**How far off** it is: on the 53 simulated quotes (`fixtures/gas/batchswap-2026-11-28.json`), median 5.0% of their
gasUsed, 9 in 10 within 18.2%, worst 25.1% (Ethereum WETH → wstETH over three pools, to a recipient holding no wstETH);
per chain, Ethereum (30) median 9.1%, Arbitrum (13) 4.5%, Base (7) 5.3%, OP (3) 5.0%. On the two real transactions
(also in the fixture): Arbitrum five hops over two paths, native out, 323,042 gas against an estimate of 333,400
(+3.2%); Base two hops, native out, 145,196 against 152,800 (+5.2%). `tests/gas-estimate.test.ts` holds the table to
both. The spread is each pool's own math within a specialization (weighted or stable invariants, rate providers),
which the pool id does not say.

**Where it is set:** Ethereum, Arbitrum, Base and OP Mainnet (`BALANCER_GAS_CHAINS`), on a batch whose every pool id
names one of the three specializations, and only at or under the quote's gas limit (every batch the provider builds
fits). Left out, never guessed: Polygon and Gnosis (their quotes used up to 59% and 42% more than the table says),
Sonic (its `eth_simulateV1` reports no usable gas), Plasma (no route to measure), Avalanche (no endpoint measured).

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
