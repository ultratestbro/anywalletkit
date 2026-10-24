# Eval — 2026-10-24

## Setup

- **Agent:** each prompt ran once in a fresh headless Claude Code session (`claude -p`, Opus 5.5),
  in an empty folder: no project settings, no MCP servers.
- **Packages:** all 44 `@anywalletkit` packages were packed from the repository and served by a
  local Verdaccio registry. Everything else came from npmjs.
- **Docs:** docs.anywallet.tech and the GitHub repository were not reachable, so the agent got the
  same `AGENTS.md` and `llms*.txt` files on disk.
- **Order:** prompts 2–5 started from the app prompt 1 produced, so prompt 3 had no swap screen to
  hook into yet.

## How the results were checked

- **Expo prompts:** `npx tsc --noEmit`, plus `npx expo export --platform ios`, which builds the
  Hermes bundle Metro would ship.
- **Node prompts:** tsc, the tests, and a real run.
- **Every result:** the key spots were read by hand — `minAmountOut`, the slippage, the check
  codes, the Lido two-phase flow — and no output may log the phrase.

## Results

| # | Prompt | Result | Time | Turns | Cost | Checks we ran |
|---|---|---|---|---|---|---|
| 1 | Minimal wallet | pass, first run | 13.2 min | 68 | $3.63 | tsc ✓; iOS Hermes bundle ✓ (1 967 modules, 7.2 MB) |
| 2 | Swaps and bridges | pass, first run | 8.7 min | 44 | $2.77 | tsc ✓; bundle ✓ (2 023 modules) |
| 3 | Transaction review | pass, first run | 8.0 min | 50 | $2.46 | tsc ✓; bundle ✓ |
| 4 | Earn | pass, first run | 9.4 min | 64 | $2.83 | tsc ✓; bundle ✓; read-only mainnet check by the agent (Lido APR, Aave 4.10 %, Morpho vault) |
| 5 | Accounts and imports | pass, first run | 8.7 min | 46 | $2.83 | tsc ✓; bundle ✓ |
| 6 | Payout bot | pass, first run | 6.9 min | 38 | $1.88 | tsc ✓; 17/17 tests ✓; dry run on Base mainnet with the test phrase ✓ |
| 7 | Own module | pass, first run | 10.6 min | 57 | $2.95 | tsc ✓; 47/47 tests incl. `describeProtocolModule` ✓; tsup build ✓ |

No prompt needed a second run. The total was 65 minutes of agent time and $19.35.

## What broke, and what changed

| Found in | Problem | Change |
|---|---|---|
| 1 | Metro could not resolve `react-native-fast-pbkdf2`, a native module pulled in by `@ton/crypto-primitives` under `wallet-ton`. The agent wrote a throwing stub, which would break TON 24-word imports. | SDK: `@anywalletkit/runtime-hermes/fast-pbkdf2`, a noble-based drop-in. Tested against node:crypto and in the RN Hermes VM. Installation docs and AGENTS.md now show the Metro line. |
| 1 | `keyring` takes one EVM config, so signing on Base needed a pattern. | AGENTS.md: a second keyring over the same secrets. |
| 1 | A TON balance needs the public key, which `AccountMeta` does not keep. | AGENTS.md: read it once with `withAccount`, then use read-only accounts for prompt-free balances. |
| 1 | `builtinNetwork(account.chain)` returns nothing for Solana, Tron and Bitcoin, because the catalogs use short ids. | AGENTS.md: both id forms, and `swap2ChainId()`. |
| 2 (prep) | A Solana account could not swap: `fromChain: account.chain` found no route, and `'solana:mainnet'` failed the account-chain check. | SDK: `protocol-swap2-core` maps genesis-hash ids (`swap2ChainId`, `SWAP2_CHAIN_ALIASES`). |
| 4 | `new LidoProtocolEvm(account)` with a real `WalletAccountEvm` failed tsc (a public `_config` in the module's account type). The same applied to SSV, Mellow and Approvals. | SDK: the field is dropped from the four interfaces, and `examples/earn` keeps a typed construction compiling. |
| 4 | The keyring has no `registerProtocol`. | AGENTS.md: construct modules directly over keyring accounts. |
| 6 | `BroadcastUnknownError` appeared only in the API reference. | AGENTS.md: account errors. |
| 7 | How a module reads chain state, and what `ChainTx` carries, were not in AGENTS.md. | AGENTS.md: module reads and `describeActivity` matching. |
| docs | Keys and storage said "mobile: nothing yet"; Installation lacked the URL polyfill that `installHermesRuntime()` requires. | Both docs pages updated, and the Packages page lists `secure-storage-react-native`, `seed-vault` and `backup-cloud`. |

## Not covered

- Nothing ran on a device or simulator, and no transaction was broadcast.
- Face ID prompts, screenshot blocking and the swap / Earn write paths are compiled and reviewed,
  not exercised.
- Only one agent was used. Running the same prompts with Cursor and Codex is the next step.
