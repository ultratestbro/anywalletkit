# Prompts

Copy-paste prompts for AI coding agents (Claude Code, Cursor, Codex…) that build on Any Wallet Kit.
Each file is the prompt and nothing else. The docs pages under
[Build with AI](https://docs.anywallet.tech/build-with-ai/) add what you get, prerequisites, how to
check the result, common failures and a security note. `scripts/check-prompts.mjs` keeps the two
identical.

| File | Builds | Starts from |
|---|---|---|
| [01-minimal-wallet.md](01-minimal-wallet.md) | Expo wallet: phrase in Face ID storage, balances on 6 chains, send | empty folder |
| [02-swaps.md](02-swaps.md) | Swap screen on the router | the wallet |
| [03-tx-review.md](03-tx-review.md) | Simulated review sheet for EVM writes | the wallet |
| [04-earn.md](04-earn.md) | Lido, Aave v3, Morpho | the wallet |
| [05-accounts.md](05-accounts.md) | Accounts, imports, gated export | the wallet |
| [06-backend-bot.md](06-backend-bot.md) | Node USDC payout bot | empty folder |
| [07-own-module.md](07-own-module.md) | Your own ERC-4626 lending module | empty folder |

Each prompt points the agent at [AGENTS.md](../AGENTS.md) and the plain-text docs. Results of the
last eval are in [EVAL.md](EVAL.md).
