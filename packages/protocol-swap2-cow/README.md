# @anywalletkit/protocol-swap2-cow

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-swap2-cow?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-cow)

[CoW Protocol](https://docs.cow.fi) as a same-chain swap2 provider for Any Wallet Kit. The wallet signs an order, solvers compete to fill it, and the network cost is taken from the sold token — a token swap needs no gas coin. Exact-input sell orders on Ethereum, Base and Arbitrum.

## Install

```sh
npm install @anywalletkit/protocol-swap2-cow @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-swap2-cow @anywalletkit/core  ·  yarn add @anywalletkit/protocol-swap2-cow @anywalletkit/core
```

On npm: [@anywalletkit/protocol-swap2-cow](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-cow), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

The module talks to the public orderbook at `api.cow.fi` straight from the device: no key, no server of yours in between. It is built from CoW's contracts and API reference and has no CoW SDK dependency.

## What a swap looks like

| Selling | What the account does | Gas |
|---|---|---|
| A token with EIP-2612 `permit` | signs the permit, then the order (two EIP-712 signatures) | none |
| Any other token | sends one exact `approve` to the vault relayer, then signs the order | the approval only |
| A token already approved | signs the order | none |
| The native coin | sends one `createOrder` transaction to eth-flow with the input as its value | that transaction |

- **Orders are signed as EIP-712 typed data only.** The module never asks for `eth_sign` / `personal_sign` over an order digest, so a wallet policy that forbids blind signing stays as it is.
- **The permit** rides in the order's appData as a single pre-hook that calls `permit` on the sold token; the solver that fills the order executes it. It grants the vault relayer exactly the swap's input and expires with the order. It is offered only with `rpcUrls` set, on a token whose `DOMAIN_SEPARATOR` the module can reproduce, and only while the account has no other open order selling the same token (a second permit would replace the first order's allowance).
- **The approval** is exact: the input plus what the account's other open orders on that token still need. Never unlimited.
- **An order lives 20 minutes** by default, then it can no longer trade. Nothing has to be cancelled or refunded for a token order: the tokens never left the account.
- **A native-coin order** holds the coin in the eth-flow contract until it fills. If it expires unfilled, CoW's refund service returns it; `claimSwap2` on the swap's id builds the refund (`invalidateOrder`) for the creator to send when that does not happen.

## What the module checks

Nothing the orderbook answers is signed as is. The order is rebuilt on the device from the request, and the quote only supplies numbers that are then bounded:

- sell token, buy token, receiver (this account unless the caller named another), `kind: sell`, no partial fill, plain ERC-20 balances — written by the module, compared with the quote's echo;
- `sellAmount` is the whole input and `feeAmount` is `0`: the network cost comes out of the price, not out of a signed fee;
- `buyAmount` is the quoted output less the caller's slippage, and never below the caller's `minAmountOut`;
- `validTo` is set from the configured lifetime; the server's clock may move it by at most 5 minutes;
- `appData` is the keccak-256 of the document this module wrote (appCode, slippage, and the permit hook when there is one) — no partner fee, no other hooks;
- the EIP-712 domain, the settlement contract, the vault relayer and eth-flow are constants per chain, never read from the API;
- the order UID the orderbook returns must equal the one computed locally from the signed order.

The engine in `@anywalletkit/protocol-swap2-core` repeats the order, permit and cancellation checks at its own gate, field by field, so the same holds when this provider runs behind a router or a remote stub.

## Configure

```ts
import { cowProvider } from '@anywalletkit/protocol-swap2-cow'

const cow = cowProvider({
  enabled: true,                                    // default off — the app's COW_ENABLED flag
  enabledChains: [8453],                            // roll out chain by chain
  rpcUrls: { 8453: ['https://base.example/rpc'] },  // optional: permit, eth-flow reads, receiver check
})
```

Standalone, on one account:

```ts
import { CowSwap2Protocol } from '@anywalletkit/protocol-swap2-cow'

const swaps = new CowSwap2Protocol(account, { fromChain: 'eip155:8453', enabled: true })
const result = await swaps.swap2({ fromToken: 'USDC', toToken: 'WETH', toChain: 8453, fromTokenAmount: 5_000_000n, minAmountOut })
await swaps.getSwap2Status(result.id)                      // pending → success / expired / refunded
await swaps.cancelSwap2(result.id, account)                // free: a signed cancellation to the orderbook
await swaps.cancelSwap2(result.id, account, { onchain: true })  // binding: Settlement.invalidateOrder
```

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. Cancelling and tracking an order placed earlier work while it is off. |
| `enabledChains` | every chain in the table | EVM chain ids offered. |
| `rpcUrls` | none | `{ chainId: [url…] }`. Without them the module quotes, signs and tracks through the orderbook; with them it also offers the permit, reads eth-flow orders from the contract and checks a native payout's receiver. |
| `defaultSlippageBps` | `50` | Used when the caller passes none. |
| `validForSeconds` | `1200` | How long an order trades (120–1500). |
| `permit` | `true` | `false` always takes the approval transaction. |
| `appCode` | `"AnyWalletKit"` | How CoW's explorer names the app. |
| `baseUrl` | `https://api.cow.fi` | The orderbook. |
| `chains` | none | Chains CoW added after this release (see below). |

## Contracts

The same addresses on every supported chain, from [`cowprotocol/contracts`](https://github.com/cowprotocol/contracts/blob/main/networks.json) and [`cowprotocol/ethflowcontract`](https://github.com/cowprotocol/ethflowcontract):

| Contract | Address |
|---|---|
| GPv2Settlement | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` |
| GPv2VaultRelayer | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| CoWSwapEthFlow | `0xbA3cB449bD2B4ADddBc894D8697F5170800EAdeC` |

`pnpm verify:live` reads each one on chain (code present, the settlement's domain separator and vault relayer, eth-flow's settlement and wrapped native) and runs read-only quotes through the provider. Another chain is one entry in `config.chains` — its network name at the orderbook, eth-flow and wrapped native; the settlement and vault relayer must be the canonical ones.

## Cancelling

- **Off-chain** (default): the account signs `OrderCancellations` and the orderbook stops offering the order. Free; a solver that already holds the order may still fill it.
- **On-chain** (`{ onchain: true }`): `GPv2Settlement.invalidateOrder(uid)` for a signed order, `CoWSwapEthFlow.invalidateOrder(order)` for a native-coin order (which also returns the coin). Binding, costs gas.

## Checked on mainnet

Read-only on Ethereum, Base and Arbitrum (`scripts/verify-live.mjs`: pinned contracts, quotes, signed order and permit
verified locally, the permit hook and eth-flow `createOrder` simulated). With funds, on Base (2026-11-23,
`scripts/verify-mainnet.mjs`, every case capped, report in `mainnet-report.json`):

| Case | Sold | Received | Gas paid | Filled |
|---|---|---|---|---|
| eth-flow (native in) | 0.0002 ETH | 0.356052 USDC (quoted 0.348044) | 0.0000023 ETH, the `createOrder` | 21 s |
| permit (USDC, no gas) | 1 USDC | 0.000561057 WETH (quoted 0.000555203) | none | 21 s |
| approve (WETH) | 0.0003 WETH | 0.535899 USDC (quoted 0.526894) | 0.0000016 ETH, the exact approval | 21 s |
| cancel off-chain | 1 USDC order | — | none | cancelled at once, `executedSellAmount` 0 |
| cancel on-chain | 1 USDC order | — | 0.0000016 ETH, `invalidateOrder` | `filledAmount` = max |

After the fills the vault relayer's allowance was 0 on both tokens: the permit and the approval were exactly the
order's input. Not covered with funds: the refund of an expired eth-flow order (an order cannot be made to stay
unfilled: its minimum may not exceed the quote).

## Not supported (yet)

- Buy (exact-output) orders, limit and TWAP orders, partial fills.
- Smart-contract accounts (EIP-1271 and pre-sign orders): the owner is an EOA.
- CoW's cross-chain bridging and any hook other than the module's own permit.
- Partner fees.
- Tokens whose permit is not EIP-2612 (DAI's original form, Permit2) take the approval path.
- Running behind `remoteProvider`: the module is meant to run on the device; the remote stub does not carry the permit and cancel steps.

Apache-2.0.
