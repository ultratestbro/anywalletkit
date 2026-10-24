---
title: "Transaction review"
description: "Simulate every EVM write before it is signed: balance changes, approvals, recipient, a verdict from the preview's check codes."
sidebar:
  order: 4
---

## What you get

A review sheet that runs `@anywalletkit/tx-preview-evm` before every EVM write. Plain sends go through `policies.confirm`, swaps through `reviewExecution`. The sheet shows:

- the simulated balance changes;
- every approval;
- the recipient and the fee;
- an ok / warn / danger verdict. Danger asks for a second, explicit confirmation.

## Before you start

The wallet from the earlier prompts, ideally with swaps. An RPC that supports `eth_simulateV1` gives full simulations; others fall back to `simulation-unavailable`.

## The prompt

Paste it into your agent as is, in the project folder of the app the earlier prompts built. The raw file is [`prompts/03-tx-review.md`](https://github.com/ultratestbro/anywalletkit/blob/main/prompts/03-tx-review.md).

```text
Add a transaction review sheet to this Any Wallet Kit wallet with `@anywalletkit/tx-preview-evm`.

Read the "Transaction preview" and "Policies" parts of https://docs.anywallet.tech/llms-small.txt (or AGENTS.md in github.com/ultratestbro/anywalletkit) first, and use only APIs that appear there.

- Every EVM write is simulated before the user confirms: plain sends and contract calls through the kit's `policies.confirm`, swaps through the router's `reviewExecution` (preview the approvals and the source call as one sequence).
- The sheet shows the simulated balance changes ("-0.01 ETH", "+25.1 USDC"), every approval with its spender and amount, the recipient, and the network fee.
- A verdict from the preview's check codes: ok, warn or danger, each with one plain-language line. Danger (a revert, an unlimited approval) needs a second, explicit confirmation. "Simulation unavailable" is a warning, not a block.
- Non-EVM writes and signed messages still get a confirmation sheet, without a simulation.
- The user's own addresses count as "own" so moves between them aren't flagged as foreign.

Done when `npx tsc --noEmit` passes and `npx expo export --platform ios` bundles.
```

## What the result looks like

```text
src/review/preview.ts   # JSON-RPC transport, previewEvmTx, check codes → verdict + lines
src/review/Sheet.tsx    # changes, approvals, recipient, fee, verdict, second confirm on danger
src/wallet/policies.ts  # confirm → preview for eip155 writes, plain sheet otherwise
```

## Check it works

Check that it builds with `npx tsc --noEmit` and `npx expo export --platform ios`. On a phone build:

1. Send to one of your own addresses. It must not be flagged as foreign.
2. Start a swap and confirm the approval amount equals the input.

## Common failures

| Symptom | Fix |
|---|---|
| Everything shows "simulation unavailable" | Your RPC has no `eth_simulateV1`; the module falls back to `eth_call` where it can, otherwise it is a warning by design |
| The RPC transport loses error details | Throw `Object.assign(new Error(message), body.error)` so `code` and `data` reach the module |
| Sends to your other accounts are flagged as foreign | Pass all of the user's addresses in `own` |

:::caution[Security]
Never paste a real recovery phrase into an agent chat, a prompt or a test. Use the public test phrase (`abandon abandon … about`) while building, then small amounts on a phone build. Read the diff the agent wrote around keys and signing: nothing should log, store or send the phrase, and every write should pass through a review step. Treat `simulation-reverted` and `approval-unlimited` as danger.
:::

## Eval

Passed on the first run: 8 min, 50 turns, $2.46, on top of the Minimal wallet result (without the swap screen, so the swap review was wired but had no caller yet). The agent tested its verdict logic in Node against a fake RPC: own-address sends, an unlimited approval, a revert, and no `eth_simulateV1`.
