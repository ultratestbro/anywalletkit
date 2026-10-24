# @anywalletkit/protocol-swap2-thorchain

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-swap2-thorchain?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-thorchain)

THORChain native cross-chain swaps as a swap2 module: EVM sources (Ethereum,
Base, BSC, Avalanche) deposit into the THORChain router with
`depositWithExpiry(vault, asset, amount, memo, expiry)`; Tron executes as a
native send to the inbound vault with a memo. Standalone through
`ThorchainSwap2Protocol`, or as one provider of the router.

## Install

```sh
npm install @anywalletkit/protocol-swap2-thorchain @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-swap2-thorchain @anywalletkit/core  ·  yarn add @anywalletkit/protocol-swap2-thorchain @anywalletkit/core
```

On npm: [@anywalletkit/protocol-swap2-thorchain](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-thorchain), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

## Activity

Routers and Asgard vaults rotate, so `describeActivity(tx, ctx)` matches no
address — only the router's unique ABI, on the EVM chains this module serves:

| Selector | Meaning | Kind | Title |
| --- | --- | --- | --- |
| `depositWithExpiry(address,address,uint256,string,uint256)` `0x44bc937b`, sent by the owner | our source leg | `bridge` (`swap` when the output also landed here) | "Bridged USDC" |
| `transferOut(address,address,uint256,string)` `0x574da717` / `transferOutAndCall` `0xec341444`, with something arriving at the owner | THORChain paying a destination leg | `bridge` | "Received USDC via THORChain" |

Subtitle "THORChain", counterparty = the router called. Not recognizable
offline: the Tron / BTC vault deposits (plain sends with a memo, vault
addresses rotate) and the destination leg on non-EVM chains.

Fixtures (`fixtures/activity/`, test wallet on Ethereum, 2026-10-10): two
`depositWithExpiry` USDC deposits and one router `transferOut` that paid the
wallet; negatives: a LI.FI swap, a Uniswap `multicall`.
