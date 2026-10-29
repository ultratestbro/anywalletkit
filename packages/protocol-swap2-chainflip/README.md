# @anywalletkit/protocol-swap2-chainflip

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-swap2-chainflip?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-chainflip)

[Chainflip](https://docs.chainflip.io) vault swaps as a swap2 provider: native
BTC / ETH / SOL / TRX and USDC / USDT between Ethereum, Arbitrum, Solana, Tron
and Bitcoin, priced by Chainflip's JIT AMM. Quotes and encoding come from
Chainflip's public backend (`chainflip-swap.chainflip.io`). You need no broker
account, there is no API key, and the commission is 0 bps.

## Install

```sh
npm install @anywalletkit/protocol-swap2-chainflip @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-swap2-chainflip @anywalletkit/core  ·  yarn add @anywalletkit/protocol-swap2-chainflip @anywalletkit/core
```

On npm: [@anywalletkit/protocol-swap2-chainflip](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-chainflip), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

```ts
import {chainflipProvider} from "@anywalletkit/protocol-swap2-chainflip/provider";
import {RouterSwap2Protocol} from "@anywalletkit/protocol-swap2-router/swap2/router";

const swap2 = new RouterSwap2Protocol(tronAccount, {fromChain: "tron:728126428", providers: [chainflipProvider()]});
const res = await swap2.swap2({fromToken: "USDT", toToken: "USDC", toChain: 42161, fromTokenAmount: 20_000_000n});
const status = await swap2.getSwap2Status(res.id); // pending → depositReceived → completed (+ egress tx) | refunded
```

| From (sources)  | How the swap is sent |
|---|---|
| Ethereum, Arbitrum | `xSwapNative` / `xSwapToken` on the Chainflip Vault; tokens get an exact approval to the Vault first |
| Tron | TRC-20 USDT (or TRX) **to the Vault**, with the swap as a binary note in `raw_data.data` (`memoEncoding: "hex"`) |

Destinations: Ethereum (ETH, USDC, USDT, WBTC), Arbitrum (ETH, USDC, USDT),
Solana (SOL, USDC, USDT), Tron (TRX, USDT) and Bitcoin (BTC). Solana and
Bitcoin as **sources** are not wired yet.

## Why vault swaps and not deposit channels

A deposit channel is an address that Chainflip's broker opens for you. The
client cannot prove where that address forwards the funds: the backend has no
lookup by deposit address. With a vault swap, the swap parameters are in the
transaction itself — calldata on EVM, the note on Tron — so the wallet can
decode and check them before signing. A Tron vault swap also skips the
channel's ingress cost (live 2026-10-20: $20 USDT → 19.48 USDC through the
Vault vs −19.5 % through a channel).

## What is checked before signing

The provider never forwards the encoder's output blindly. `getQuote` decodes it
(SCALE `VersionedCfParameters` V1, the Tron note, or the EVM Vault ABI) and
refuses the quote unless all of the following hold:

- the target is the known Vault for the source chain (`CF_VAULTS`). On Tron it
  must be a TRC-20 `transfer(Vault, amountIn)` of the quoted token;
- the destination chain id, output asset id and destination address bytes
  match the request (EVM hex, Tron 20 B, Solana 32 B, BTC as ASCII);
- the refund address is the sender, and the swap is fill-or-kill:
  `minPriceX128 ≥ ceil(minOut · 2^128 / amountIn)`, retry ≤ 600 blocks, and the
  oracle slippage guard is what we asked for;
- there is no DCA, no boost, no broker commission and no affiliates.

The minimum output is either the caller's `minAmountOut` or the expected
amount less the slippage (`slippageBps`, or the backend's recommendation when
none is given). If the price can't be met within the retry window, Chainflip
refunds the input to the sender.

## Minimums

These are Chainflip's per-asset ingress minimums. A smaller amount gets no quote.
Ethereum USDC/USDT: $20. Arbitrum, Solana and Tron stables: $10. BTC: 40 000 sat.
TRX: 30.

## Status

`trackIntent` reads `GET /v2/swaps/{sourceTxHash}`:

- 404 means the swap is not seen yet (pending);
- RECEIVING, SWAPPING and SENDING mean the deposit was received;
- COMPLETED returns the destination tx (`swapEgress.txRef`);
- FAILED returns `refunded` if a refund egress exists, otherwise `failed`.

The endpoint rate-limits (429); the provider retries once.

## Behind `remoteProvider`

When the provider runs on your server, spread its pins into the app's stub:
`remoteProvider({name: "chainflip", baseUrl, ...chainflipPins})`. The engine then lets the EVM route call and
approve only the Chainflip Vault in `CF_VAULTS`, never an address the backend names; without the pins the stub gets no
EVM calldata route (fail closed). The pins carry `verifyQuote: chainflipVerifyQuote`, the provider's own decode run
on the device: the EVM vault call, or the Tron note, must name the app's destination, refund address and a minimum
price that guarantees the quoted minimum. A Tron vault swap is a send to the Tron Vault, so the pins also open the
stub to that deposit route (`depositAddressRoutes`); the verifier pins the Vault it pays.

## Config

```ts
chainflipProvider({
  enabled: true,                    // default
  apiUrl: "https://chainflip-swap.chainflip.io",
  maxOraclePriceSlippageBps: 100,   // oracle guard in the fill-or-kill params; default = the quote's recommendation, null = off
})
```
