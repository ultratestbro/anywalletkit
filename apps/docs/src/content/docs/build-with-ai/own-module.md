---
title: "Your own protocol module"
description: "Build a LendingProtocol for any ERC-4626 vault as a standalone package, with the SDK's conformance suite, activity recognition and a registry manifest."
sidebar:
  order: 8
---

## What you get

A standalone npm package, `@acme/protocol-lending-erc4626-evm`.

- **Protocol:** a `LendingProtocol` with supply (exact approve + deposit), withdraw (redeem everything for `'max'`), quote twins, position and vault reads.
- **Activity:** `describeActivity` recognizes the vault's deposits and withdrawals.
- **Tests:** Vitest, including `describeProtocolModule` from `@anywalletkit/conformance`.
- **Packaging:** tsup builds and a `module.json`.

## Before you start

Node 22+ and an empty folder. The module lives in **your own repository and npm scope**: the SDK repository does not accept pull requests yet. External modules are listed through the registry's `external.json`.

## The prompt

Paste it into your agent as is, in the project folder. The raw file is [`prompts/07-own-module.md`](https://github.com/ultratestbro/anywalletkit/blob/main/prompts/07-own-module.md).

```text
Create a new Any Wallet Kit protocol module as its own npm package in this directory: `@acme/protocol-lending-erc4626-evm`, a `LendingProtocol` for any ERC-4626 vault on an EVM chain.

Read the "Writing a protocol module" part of AGENTS.md in github.com/ultratestbro/anywalletkit, plus the guides at https://docs.anywallet.tech/llms-small.txt, first. Use only APIs that appear there. Use viem for ABI encoding and reads.

- Config: `{ vault, chainId }`, where `vault` is the vault's `0x…` address.
- `supply({ token, amount })`: `token` must be the vault's asset (refuse others). It sends an exact approve, then `deposit(assets, me)`.
- `withdraw({ token, amount })`: `amount` also accepts `'max'`. It calls `withdraw`, or `redeem` of every share for `'max'`.
- Each write has a `quote*` twin that signs nothing. `borrow` / `repay` (and their quotes) are unsupported and say so.
- Reads: `getPosition()` returns `{ shares, assets }`, and `getVault()` returns the asset address, its decimals, and the total assets.
- Writes refuse a read-only account. Amounts are bigint.
- `describeActivity` recognizes the vault's Deposit / Withdraw events ("Deposited 100 USDC · <vault name>") and returns null for anything else. Unit-test it with hand-built transactions.
- Run the SDK's conformance suite (`describeProtocolModule` from `@anywalletkit/conformance`) under Vitest.
- Package: ESM + CJS builds with types (tsup), a `module.json` registry manifest (tier `community`), and a README with usage.

Done when `npm test` passes, `npm run build` produces dist, and `npx tsc --noEmit` passes.
```

## What the result looks like

```text
src/protocol.ts          # class extends LendingProtocol, reads via viem, writes via the account
src/activity.ts          # describeActivity: Deposit / Withdraw → "Deposited 100 USDC · <vault>"
test/conformance.test.ts # describeProtocolModule('…', { type: 'lending', … })
test/*.test.ts           # supply / withdraw / quotes / activity with a mock account
module.json              # registry manifest, tier community
tsup.config.ts, README.md
```

## Check it works

```sh
npm test && npm run build && npx tsc --noEmit
```

Then supply and withdraw a few dollars in a real vault on Base from a script, with a funded test wallet.

## Common failures

| Symptom | Fix |
|---|---|
| Conformance: "a quote/read called sendTransaction" or "… called sign…" | `quote*` methods must estimate, never sign or send |
| Conformance: writes do not refuse a read-only account | Call `this.requireSigningAccount('supply')` first in every write |
| No way to read the vault from the account | Take an RPC in the config and read with your own viem client; `wallet-evm` accounts also have `simulateTransaction` |
| `describeActivity` sees no events | `ChainTx` has no logs field: match `call.to` / `call.selector` and `transfers` |

:::caution[Security]
A module never holds keys: it builds transactions and the account signs them, behind the wallet's policies. Approve exact amounts, check every address you call against the config, and refuse an account on another chain.
:::

## Eval

Passed on the first run: 11 min, 57 turns, $2.95, from an empty folder. 47 tests pass, including `describeProtocolModule`. ESM, CJS and type builds come out, and tsc is clean.
