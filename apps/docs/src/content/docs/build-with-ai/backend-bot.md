---
title: "Payout bot (Node)"
description: "A Node service that pays USDC on Base from a CSV: dry run by default, policies with an exact allowlist, an idempotent journal and strict key handling."
sidebar:
  order: 7
---

## What you get

A TypeScript CLI on Node 22.

- **Input:** a CSV of payouts; the seed phrase comes from an env var.
- **Safety rails:** kit policies (an allowlist of exactly the CSV's recipients, plus a fee cap), checksummed addresses, per-row limits and balance checks.
- **Dry run:** by default it quotes every fee and prints the plan; `--send` pays.
- **Journal:** written before and after each send, so a restart never pays twice and an unknown outcome waits for a human.

## Before you start

- Node 22.
- For a real run, a funded hot wallet that holds only what the run pays out. Use a separate phrase, never your main one.

## The prompt

Paste it into your agent as is, in the project folder. The raw file is [`prompts/06-backend-bot.md`](https://github.com/ultratestbro/anywalletkit/blob/main/prompts/06-backend-bot.md).

```text
Create a Node.js (TypeScript, Node 22, ESM) payout bot on Any Wallet Kit, the `@anywalletkit/*` packages.

Read https://docs.anywallet.tech/llms-small.txt (or AGENTS.md in github.com/ultratestbro/anywalletkit) first, and use only APIs that appear there.

- Input: a CSV of `address,amount` rows, with amounts in USDC (6 decimals). Payouts go out in USDC on Base from account 0 of the seed phrase in the `WALLET_SEED_PHRASE` env var.
- Safety:
  - kit policies with an allowlist of exactly the CSV's recipients and a max-fee cap;
  - checksum-validate every address;
  - refuse duplicates and amounts above a configurable per-row limit;
  - check the USDC and ETH balances before starting.
- Dry run by default: quote each transfer's fee and print the plan and the total; nothing is signed. `--send` actually sends.
- Idempotent: a JSON journal records each row as pending, sent (with its hash) or failed, written before and after every send. A restart never pays a row twice, and a row whose outcome is unknown stays pending for a human. No automatic retries.
- Never print or write the seed phrase or keys. Log addresses, amounts and hashes only. Dispose the wallet on exit, including Ctrl-C.
- Add a README that covers setup, the env vars, a dry run, and the key-handling rules.

Done when `npx tsc --noEmit` passes, a unit test covers the CSV and journal logic, and the dry run works against a sample CSV. Use the public test phrase `test test test test test test test test test test test junk`, which has no funds, so the run shows the plan with zero balances.
```

## What the result looks like

```text
src/main.ts        # args, env, dry run vs --send, Ctrl-C → dispose
src/csv.ts         # parse + checksum + limits + duplicates
src/journal.ts     # pending / sent / failed, written around every send
src/wallet.ts      # Wallet + WalletManagerEvm on Base, policies (allowlist, maxFee, confirm)
test/              # CSV and journal unit tests
README.md          # setup, env vars, dry run, key handling
```

## Check it works

```sh
npx tsc --noEmit && npm test
WALLET_SEED_PHRASE="test test test test test test test test test test test junk" npm run payout -- examples/payouts.sample.csv
```

The test phrase has no funds, so the dry run shows zero balances and says why `--send` would refuse. Then run with a funded test wallet and one tiny row.

## Common failures

| Symptom | Fix |
|---|---|
| Every fee shows "unavailable" | An ERC-20 fee quote simulates the transfer: the wallet must hold the token |
| A crash after sending, then a double payment | Write the journal row as `pending` **before** sending; `BroadcastUnknownError` keeps it pending |
| `PolicyViolationError: allowlist` | Expected for any recipient outside the CSV: the allowlist is the point |

:::caution[Security]
The phrase comes from a secret manager or env var at start, never from the repo. Logs carry addresses, amounts and hashes only. Keep the hot wallet's balance to what one run needs.
:::

## Eval

Passed on the first run: 7 min, 38 turns, $1.88, from an empty folder. 17 unit tests pass. The dry run with the test phrase printed the plan, showed zero balances, and listed why `--send` would refuse. The phrase never appeared in the output.
