---
title: Build with AI
description: Copy-paste prompts that build a wallet, swaps, a review sheet, Earn, accounts, a payout bot or your own module with an AI coding agent, each tested on a clean project.
sidebar:
  order: 1
  label: Overview
---

Any Wallet Kit is small enough for a coding agent to use correctly when it has the right
reference. This section gives you that reference and a set of prompts that build real things
on the SDK. We run every prompt on a clean project before publishing it.

## Give your agent the SDK

- **[AGENTS.md](https://github.com/ultratestbro/anywalletkit/blob/main/AGENTS.md)**: one file with
  the packages, chain ids, the canonical patterns (wallet, balances, send, swaps, review, Earn,
  keyring, policies, modules), the React Native setup, the pitfalls and the security rules. Every
  API name in it is checked against the packages.
- **[llms-small.txt](/llms-small.txt)**: these guides as plain text.
- **[llms-full.txt](/llms-full.txt)**: the guides plus the generated API reference. It is large,
  so let the agent search it.

Most agents read a URL when the prompt names it. The prompts below name both.

## The prompts

| Prompt | Builds | Starts from |
|---|---|---|
| [Minimal wallet](/build-with-ai/minimal-wallet/) | Expo wallet: phrase in Face ID storage, balances on 6 chains, send | empty folder |
| [Swaps and bridges](/build-with-ai/swaps/) | Swap screen on the router: streaming routes, auto slippage, review, status | the wallet |
| [Transaction review](/build-with-ai/tx-review/) | Simulated review sheet for every EVM write | the wallet |
| [Earn](/build-with-ai/earn/) | Lido, Aave v3 and Morpho with APY, positions, deposit / withdraw | the wallet |
| [Accounts and imports](/build-with-ai/accounts/) | Account switcher, phrase / key / Tonkeeper imports, gated export | the wallet |
| [Payout bot](/build-with-ai/backend-bot/) | Node CSV payouts: dry run, allowlist policy, idempotent journal | empty folder |
| [Your own module](/build-with-ai/own-module/) | ERC-4626 `LendingProtocol` package with conformance tests | empty folder |

Coming: a **Telegram Mini App wallet**, once the embedded-wallet kit ships.

## Eval results

Each prompt ran once in a fresh Claude Code session (Opus 5.5, headless, no project settings or
MCP servers) in a clean folder. The `@anywalletkit` packages were served from a local registry
built from the repository; nothing else differed from a normal setup. Prompts 2–5 started from
the app prompt 1 produced. We then checked every result ourselves:

- **Expo prompts:** `npx tsc --noEmit` and `npx expo export --platform ios` (the Hermes bundle).
- **Node prompts:** tsc, the tests, and a real run (the bot's dry run against Base mainnet with the
  public test phrase; the module's conformance suite).

| Prompt | Result | Time | Turns | Cost | Gate |
|---|---|---|---|---|---|
| Minimal wallet | pass, first run | 13 min | 68 | $3.63 | tsc ✓, iOS bundle ✓ (1 967 modules) |
| Swaps and bridges | pass, first run | 9 min | 44 | $2.77 | tsc ✓, iOS bundle ✓ (2 023 modules) |
| Transaction review | pass, first run | 8 min | 50 | $2.46 | tsc ✓, iOS bundle ✓ |
| Earn | pass, first run | 9 min | 64 | $2.83 | tsc ✓, iOS bundle ✓, mainnet reads ✓ |
| Accounts and imports | pass, first run | 9 min | 46 | $2.83 | tsc ✓, iOS bundle ✓ |
| Payout bot | pass, first run | 7 min | 38 | $1.88 | tsc ✓, 17 tests ✓, dry run ✓ |
| Your own module | pass, first run | 11 min | 57 | $2.95 | tsc ✓, 47 tests incl. conformance ✓, build ✓ |

**What the eval changed:**

- **Fixed in the SDK:**
  - `runtime-hermes/fast-pbkdf2`: `wallet-ton` no longer needs a native module or a stub on Metro.
  - `protocol-swap2-core`: Solana, Tron and Bitcoin accounts can swap with `fromChain: account.chain`.
  - Lido, SSV, Mellow and Approvals: these modules now accept real `wallet-evm` accounts in typed code.
- **Added to AGENTS.md:**
  - the two forms of chain id;
  - balances without a biometric prompt (read-only accounts; TON needs its public key);
  - one EVM network per keyring;
  - Earn modules over keyring accounts;
  - the account errors (`BroadcastUnknownError`);
  - how modules read chain state and recognize their transactions.
- **What the eval does not cover:** a bundle that builds is not an app that has been tapped through.
  None of the results ran on a device or sent a real transaction. Test on a Release build with small
  amounts.
