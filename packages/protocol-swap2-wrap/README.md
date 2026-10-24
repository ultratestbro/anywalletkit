# @anywalletkit/protocol-swap2-wrap

Wrap / unwrap the native coin as a swap2 module: WETH9 `deposit()` and
`withdraw(uint256)` on the wrapper in `WRAPPED_NATIVE` for each chain (WETH,
WBNB, WPOL, WAVAX, …), verified on-chain before use. Standalone through
`WrapSwap2Protocol`, or as one provider of the router.

## Activity

`describeActivity(tx, ctx)` recognizes calls to the chain's wrapper (the
table, or the `wrapped` override you passed):

| Selector | Kind | Title |
| --- | --- | --- |
| `deposit()` `0xd0e30db0` | `wrap` | "Wrapped ETH" (the chain's native symbol) |
| `withdraw(uint256)` `0x2e1a7d4d` | `unwrap` | "Unwrapped WETH" (the wrapper's symbol) |

Assets are the owner's net transfers (native out + WETH mint in, or WETH burn
out + native in), subtitle = the wrapper symbol, counterparty = the wrapper.
A swap that unwraps inside a DEX router is that router's activity, not this
module's.

Fixtures (`fixtures/activity/`, public Ethereum WETH9 transactions,
2026-10-14 — the test wallet's wrap runs were quote-only on the matrix): two
`deposit()`, two `withdraw()`; negatives: a Uniswap `multicall` ending in
`unwrapWETH9`, a Balancer Vault swap.
