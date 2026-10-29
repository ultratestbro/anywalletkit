# @anywalletkit/protocol-swap2-uniswap

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-swap2-uniswap?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-uniswap)

Uniswap v3 same-chain swaps as a swap2 module: QuoterV2 quotes, SwapRouter02
`multicall(deadline, …)` execution, on the deployments in `src/addresses.ts`
(each verified on-chain before use). Standalone through `UniswapSwap2Protocol`,
or as one provider of the router.

## Install

```sh
npm install @anywalletkit/protocol-swap2-uniswap @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-swap2-uniswap @anywalletkit/core  ·  yarn add @anywalletkit/protocol-swap2-uniswap @anywalletkit/core
```

On npm: [@anywalletkit/protocol-swap2-uniswap](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-uniswap), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

## Behind `remoteProvider`

When the provider runs on your server, spread its pins into the app's stub:
`remoteProvider({name: "uniswap", baseUrl, ...uniswapPins})`. The engine then lets the EVM route call and
approve only the SwapRouter in `UNISWAP_V3`, never an address the backend names; without the pins the stub gets no
EVM calldata route (fail closed). The pins carry `verifyQuote: uniswapVerifyQuote`, which opens the router call on the
device: one `multicall(deadline, legs)` whose legs are exactly one `exactInputSingle` / `exactInput` (at most two
pools), then `unwrapWETH9` for a native output, selling exactly the input of the source token for the destination
token with the quote's minimum, paid to the recipient. `pull`, `sweepToken` and every other router call are refused.

## Activity

`describeActivity(tx, ctx)` recognizes a call into the chain's SwapRouter02
(the deployment table, or the `deployments` override you passed) with one of
its swap entry points — `multicall(uint256,bytes[])` `0x5ae401dc`,
`multicall(bytes[])` `0xac9650d8`, `multicall(bytes32,bytes[])` `0x1f0464d1`,
`exactInputSingle` `0x04e45aaf`, `exactInput` `0xb858183f`,
`exactOutputSingle` `0x5023b4df`, `exactOutput` `0x09b81346` — as `swap`,
"Swapped A → B" from the owner's net transfers (native legs via
`unwrapWETH9` / `value` included). Subtitle `Uniswap v3 · <chain>`,
counterparty = the router. Symbols come from the transfers or the swap2-assets
catalog; unknown tokens show as a shortened address.

Fixtures (`fixtures/activity/`, public Ethereum transactions, 2026-10-14 — the
test wallet's Uniswap runs were quote-only on the matrix): `exactInputSingle`
USDC → SHFL, `multicall(deadline)` USDC → USDT (the shape this module builds),
`multicall(bytes[])` KEKIUS → ETH, `exactInput` USDC → AGRS; negatives: a
Balancer Vault swap, a WETH9 deposit.
