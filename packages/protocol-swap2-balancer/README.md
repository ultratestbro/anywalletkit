# @forgewallet/protocol-swap2-balancer

Balancer v2 same-chain swaps as a swap2 module: Smart Order Router paths from
the Balancer API, `queryBatchSwap` on the Vault for the on-chain quote,
`batchSwap` execution, on the chains in `BALANCER_V2_CHAINS` (Vault `WETH()`
verified before use). Standalone through `BalancerSwap2Protocol`, or as one
provider of the router.

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
