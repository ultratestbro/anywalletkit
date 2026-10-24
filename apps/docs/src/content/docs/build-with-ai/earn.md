---
title: "Earn"
description: "Add Lido staking, Aave v3 supply and the biggest Morpho USDC vault on Base, with APY, positions, deposits and withdrawals."
sidebar:
  order: 5
---

## What you get

An Earn tab with three products:

- Lido staking on Ethereum, with the two-phase withdrawal queue;
- Aave v3 USDC on Ethereum;
- the biggest Morpho USDC vault on Base.

Each shows its APR / APY and the user's position. Deposit and withdraw quote the fee first and go through the confirm flow.

## Before you start

The wallet from the earlier prompts. Earn writes cost mainnet gas, so test with small amounts.

## The prompt

Paste it into your agent as is, in the project folder of the app the earlier prompts built. The raw file is [`prompts/04-earn.md`](https://github.com/ultratestbro/anywalletkit/blob/main/prompts/04-earn.md).

```text
Add an Earn tab to this Any Wallet Kit wallet.

Read the "Earn" part of https://docs.anywallet.tech/llms-small.txt (or AGENTS.md in github.com/ultratestbro/anywalletkit) first, and use only APIs that appear there.

Three products:
- Lido staking on Ethereum (ETH → stETH).
- Aave v3 USDC supply on Ethereum.
- The biggest Morpho USDC vault on Base, found with `MorphoApi`.

For each product:
- Show the APR / APY and the user's position, with a refresh.
- Deposit and withdraw with an amount field, a fee quote, then confirmation through the existing confirm flow.
- Lido withdrawals are two-phase: request first, then claim once the request is claimable. Show pending and claimable amounts.

Put the protocol registrations next to the wallet setup. Amounts stay bigint end to end.

Done when `npx tsc --noEmit` passes and `npx expo export --platform ios` bundles.
```

## What the result looks like

```text
src/earn/protocols.ts   # registerProtocol('lido' | 'aave'), MorphoApi.listVaults → MorphoVaultProtocolEvm
src/earn/useEarn.ts     # APR/APY, positions, quote + deposit / withdraw, Lido request → claim
src/app/earn/           # one card per product, amount sheet, pending / claimable for Lido
```

## Check it works

Check that it builds with `npx tsc --noEmit` and `npx expo export --platform ios`. On a phone build, check the APYs against the protocols' own sites. Then deposit and withdraw a few dollars in the Morpho vault on Base, where gas is cheap.

## Common failures

| Symptom | Fix |
|---|---|
| Lido "withdraw" returns no ETH | Unstaking is two-phase: `requestWithdrawal`, then `claimWithdrawals({ ids: claimableIds })` once finalized |
| `withdraw` leaves dust | Use `amount: 'max'` for the whole position |
| The Morpho vault list is empty | `MorphoApi` filters by chain and asset address; pass the asset on that chain |

:::caution[Security]
Never paste a real recovery phrase into an agent chat, a prompt or a test. Use the public test phrase (`abandon abandon … about`) while building, then small amounts on a phone build. Read the diff the agent wrote around keys and signing: nothing should log, store or send the phrase, and every write should pass through a review step. Show the APY source and the protocol's risks; never imply a fixed return.
:::

## Eval

Passed on the first run: 9 min, 64 turns, $2.83, on top of the Minimal wallet result. A read-only check against mainnet returned the Lido APR and queue, Aave's USDC APY (4.10 %), and the biggest Morpho USDC vault on Base.

The run found a typing bug, now fixed: modules built directly over a keyring account, with no `registerProtocol`, could not take a real `wallet-evm` account in Lido / SSV / Mellow / Approvals.
