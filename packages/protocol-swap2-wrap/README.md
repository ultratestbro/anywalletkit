# @anywalletkit/protocol-swap2-wrap

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-swap2-wrap?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-wrap)

Wrap / unwrap the native coin as a swap2 module: WETH9 `deposit()` and
`withdraw(uint256)` on the wrapper in `WRAPPED_NATIVE` for each chain (WETH,
WBNB, WPOL, WAVAX, …), verified on-chain before use. Standalone through
`WrapSwap2Protocol`, or as one provider of the router.

## Install

```sh
npm install @anywalletkit/protocol-swap2-wrap @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-swap2-wrap @anywalletkit/core  ·  yarn add @anywalletkit/protocol-swap2-wrap @anywalletkit/core
```

On npm: [@anywalletkit/protocol-swap2-wrap](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-wrap), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

## Behind `remoteProvider`

When the provider runs on your server, spread its pins into the app's stub:
`remoteProvider({name: "wrap", baseUrl, ...wrapPins})`. The engine then lets the EVM route call and
approve only the wrapped-native contract (no spender), never an address the backend names, and `wrapVerifyQuote`
checks the call on the device: `deposit()` with the input as value, or `withdraw(input)` with no value, for the
sender. Without the pins the stub gets no EVM calldata route (fail closed).

## Gas estimate (`gasEstimate`)

A quote carries `gasEstimate` with `gasEstimateSource: "model"` from `WRAP_GAS`: the gas `deposit()` /
`withdraw(amount)` uses on that chain's pinned wrapper (an overridden `wrapped` contract gets none), without
headroom; `txRequest.gasLimit` is separate (next section). Measured 2026-11-28 (`fixtures/gas/measured-2026-11-28.json`):
`eth_simulateV1` of the module's own calls from an address that never held the wrapper, and receipts of public
wrap / unwrap transactions sent straight to the wrapper on the same chain. Each figure is the dearer of the two cases
the call can hit — a wrap into an empty wrapped balance, an unwrap of part of the balance:

| Chain | wrap | unwrap | receipts on the chain (gasUsed) |
| --- | ---: | ---: | --- |
| Ethereum | 45 038 | 35 192 | wrap 27 938 / 45 054–45 138, unwrap 30 404–35 204 |
| BSC | 45 038 | 35 192 | wrap 27 938 / 45 038, unwrap 30 416–35 204 |
| Linea | 45 038 | 35 192 | wrap 27 938 / 45 038–45 054, unwrap 30 404 |
| Plasma | 45 041 | 35 227 | wrap 27 941 / 45 041, unwrap 30 451–30 811 |
| Unichain, Ink | 44 932 | 35 211 | wrap 27 832 / 44 932 (Ink), unwrap 30 423–30 435 |
| OP, Base, World Chain | 44 866 | 35 116 | wrap 27 766 (OP) / 44 866 (Base), unwrap 30 316–35 140 |
| HyperEVM | 44 866 | 35 140 | receipts only: wrap 27 766 / 44 866, unwrap 30 340 / 35 140 |
| Sei | — | 35 140 | receipts only: wrap 27 766 (the cheaper case only), unwrap 30 340–35 140 |
| Scroll | — | 42 062 | receipts only: wrap 34 792 (one), unwrap 37 238–42 062 |
| Polygon | 48 401 | 37 747 | wrap 30 461–30 561 / 48 401, unwrap 33 811–37 783 |
| X Layer | 49 054 | 39 241 | unwrap 39 253–39 289 |
| Mantle | 51 977 | 42 329 | unwrap 37 565–42 389 |
| Arbitrum | 57 975 | 48 177 | unwrap 43 422 (aeWETH behind a proxy; Arbitrum's gas includes its L1 posting part) |
| Katana (vbETH) | 66 336 | 55 851 | unwrap 55 851 |

How far off it is: a wrap topping up a balance the sender already holds uses 17 100 less than the figure (17 940 on
Polygon), an unwrap of the whole balance 4 788 less (3 948 on Polygon). Receipts of the same case run 0–112 gas above
the simulated figure (the amount's calldata bytes, an occasional trailing byte; one World Chain unwrap 348 above). No estimate, by design: Monad (its receipts report the gas limit as
gasUsed: 80 000, 1 500 000), Sonic (its `eth_simulateV1` answers millions; receipts 36 852–42 458 without both cases),
MegaETH (a wrap into an empty balance uses 94 632; unwraps 82 123–87 055; its storage gas is not in this table), Morph (receipts
only, one case each), Gnosis and Berachain (simulated, no receipt found), zkSync (neither), Flare, Avalanche, Plume
and Elysium (not measured).

## Gas limit

`txRequest.gasLimit` — the limit the transaction is sent with — is 90 000, which covers every chain's wrapper in the
table above with room to spare, except on four chains (`WRAP_GAS_LIMIT`, `wrapGasLimit(chainId)`), where
`eth_estimateGas` on 2026-11-28 (`fixtures/gas/limits-2026-11-28.json`) found a wrap into an empty balance or an
unwrap needing more:

| Chain | Limit | Why | Estimated (deposit into an empty balance / withdraw of part) |
| --- | --- | --- | --- |
| Sei | 150 000 | a new storage slot costs 72 000 | 97 833 / — |
| MegaETH | 200 000 | storage gas | 98 470 (a receipt: 94 632) / 82 123–87 055 |
| Flare | 350 000 | WNat keeps vote-power checkpoints | 202 512 / 175 850–187 782 |
| zkSync | 500 000 | pubdata is priced in L2 gas and moves with L1 gas | 186 454 / 191 900–192 037 |

Before that every chain went out with 90 000, so those calls would run out of gas there. Each limit is at least
half again over the dearer figure; gas a transaction does not use is not charged on these chains. The other chains
of `WRAPPED_NATIVE` estimated 45 322–58 459 for a deposit into an empty balance.

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

## `blockNumber`

`QuoteParams.blockNumber` (one block for a comparison round) is not supported: a wrap or an unwrap is 1:1 and reads no price, so the quote names no block (`Quote.blockNumber` absent).
