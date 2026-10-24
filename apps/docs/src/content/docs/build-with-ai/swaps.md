---
title: "Swaps and bridges"
description: "Add a swap screen on the swap router: streaming routes from every provider, auto slippage, a review sheet, execution and status tracking."
sidebar:
  order: 3
---

## What you get

A Swap screen on `@anywalletkit/protocol-swap2-router`, running the key-free providers (LI.FI, NEAR Intents, Chainflip, CCTP, USDT0, Uniswap, Wrap, Jupiter).

- **Routes:** they stream in as each provider answers and carry best / fastest tags.
- **Slippage:** Auto, with manual overrides.
- **Review:** a sheet before the first approval or signature.
- **Execution:** the exact route the user picked, with the guaranteed minimum enforced.
- **Tracking:** status runs until a final state, including the claim step for CCTP.

## Before you start

- The wallet from [Minimal wallet](/build-with-ai/minimal-wallet/) (or your own app on the kit).
- Optional keys: a LI.FI `apiKey` raises its rate limit, a 1Click `jwt` removes its fee.

## The prompt

Paste it into your agent as is, in the project folder of the app the earlier prompts built. The raw file is [`prompts/02-swaps.md`](https://github.com/ultratestbro/anywalletkit/blob/main/prompts/02-swaps.md).

```text
Add a Swap screen to this Any Wallet Kit wallet, using the swap router `@anywalletkit/protocol-swap2-router`.

Read the "Swaps and bridges" part of https://docs.anywallet.tech/llms-small.txt (or AGENTS.md in github.com/ultratestbro/anywalletkit) first, and use only APIs that appear there.

- Source: the active account on any chain the wallet supports; destination: any chain and token from `@anywalletkit/swap2-assets` (same-chain and cross-chain).
- Providers that need no API key: LI.FI, NEAR Intents, Chainflip, CCTP, USDT0, Uniswap, Wrap, Jupiter. Put RPC URLs in the existing config.
- Routes stream in as each provider answers (`quoteSwap2Routes` with `onUpdate`), tagged best / fastest; the user picks one. Show "you receive at least" (`toTokenAmountMin`), fees and ETA.
- Slippage: Auto by default (`suggestSlippage`), with 0.1 / 0.5 / 1 / 3 % overrides; the same slippage for quoting and execution.
- Execute exactly the picked route with `minAmountOut = route.quote.toTokenAmountMin`, behind a review sheet in `reviewExecution` (amounts, minimum, recipient, approvals) and the execution phases as progress.
- Track the swap by its id until it reaches a final status; when the status is `action-required`, claim on the destination chain.
- Map the swap errors to user messages. `Swap2MaybeSentError` means the swap may already be on chain: show it as pending and never retry.

Done when `npx tsc --noEmit` passes and `npx expo export --platform ios` bundles.
```

## What the result looks like

```text
src/swap/providers.ts   # provider list + RPCs from the config
src/swap/useSwap.ts     # quoteSwap2Routes(onUpdate), suggestSlippage, using(route.provider).swap2(...), getSwap2Status polling
src/app/swap/           # token pickers, route list, slippage chips, review sheet, progress, status
```

## Check it works

Check that it builds with `npx tsc --noEmit` and `npx expo export --platform ios`. Then on a phone build:

1. Quote 5 USDC from Base to Arbitrum. Routes should appear one by one.
2. Execute the cheapest one and watch the phases.
3. Wait for `completed`.

## Common failures

| Symptom | Fix |
|---|---|
| `swap2: no route available` from a Solana / Tron / Bitcoin account | Update `protocol-swap2-core`: older versions did not accept the genesis-hash chain id (`account.chain`) as `fromChain` |
| Execution refuses with "requires caller-supplied minAmountOut" | Pass `minAmountOut: route.quote.toTokenAmountMin` |
| `rejected by validation` at execution | Quote and execute with the same `slippage` |
| A swap "failed" and the user retries, then pays twice | `Swap2MaybeSentError`: the swap may be on chain. Show it as pending and track `e.id` |

:::caution[Security]
Never paste a real recovery phrase into an agent chat, a prompt or a test. Use the public test phrase (`abandon abandon … about`) while building, then small amounts on a phone build. Read the diff the agent wrote around keys and signing: nothing should log, store or send the phrase, and every write should pass through a review step. Show the guaranteed minimum (`toTokenAmountMin`), never only the expected amount.
:::

## Eval

Passed on the first run: 9 min, 44 turns, $2.77, on top of the Minimal wallet result. The screen uses `quoteSwap2Routes` with streaming, `suggestSlippage` for both quote and execution, `using(route.provider).swap2({ …, minAmountOut: route.quote.toTokenAmountMin })`, the `reviewExecution` sheet, status polling with a claim, and a pending state for `Swap2MaybeSentError`.

Building this cookbook also surfaced an SDK bug: `fromChain: account.chain` found no route from Solana, Tron or Bitcoin accounts. It is fixed in `protocol-swap2-core`.
