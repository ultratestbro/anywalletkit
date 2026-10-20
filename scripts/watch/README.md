# Module watch

Daily upstream watch for every protocol module: on-chain code, official repos,
the API endpoints we call and the docs pages we rely on. Deterministic: fetch →
compare with the stored snapshot → diff. Nothing here decides anything; the diff
goes to Telegram (and `watch/digest/`) for a human or an agent to triage.

```
node scripts/watch/watch.mjs --baseline [--env ../vaultyvault/app/.env.local]   # first snapshot, no digest
node scripts/watch/watch.mjs [--only aave,morpho] [--send] [--dry]               # daily run
```

- `--env FILE` loads `KEY=value` lines into the environment (RPC URLs, bot token) without printing them.
- `--send` posts the digest to Telegram (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_WATCH_CHAT`, falling back to `TELEGRAM_ALERTS_CHAT`).
- `--dry` fetches and prints the diff but does not touch `watch/state`.
- State lives in `watch/state/<module>.json` (committed by the workflow), diffs in `watch/diff/<date>.json`, digests in `watch/digest/<date>.md`.

## `packages/<pkg>/watch.json`

```json
{
  "module": "@forgewallet/protocol-lending-aave-evm",
  "sources": [
    {"id": "pool-eth-core", "type": "evm-proxy", "chainId": 1, "address": "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", "label": "Aave v3 Pool · Ethereum core"},
    {"id": "quoter-base", "type": "evm-code", "chainId": 8453, "address": "0x…", "label": "QuoterV2 · Base"},
    {"id": "klend", "type": "solana-program", "programId": "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", "label": "Kamino Lend program"},
    {"id": "pool", "type": "ton-code", "address": "EQ…", "label": "Tonstakers pool"},
    {"id": "address-book", "type": "github-releases", "repo": "bgd-labs/aave-address-book"},
    {"id": "deployments", "type": "github-file", "repo": "owner/repo", "path": "deployments/mainnet.json", "ref": "main"},
    {"id": "chains", "type": "http-json", "url": "https://li.quest/v1/chains", "path": "chains", "itemKey": "id", "label": "LI.FI chains"},
    {"id": "docs-fees", "type": "http-text", "url": "https://developers.circle.com/cctp/…", "between": ["<main", "</main>"], "label": "CCTP fee docs"},
    {"id": "blog", "type": "rss", "url": "https://blog.example.com/rss.xml"}
  ]
}
```

| type | what is compared | needs |
|---|---|---|
| `evm-proxy` | EIP-1967 implementation / admin / beacon slots + code hash of the address | `chainId`, `address` |
| `evm-code` | keccak256 of `eth_getCode` | `chainId`, `address` |
| `solana-program` | programdata `slot` (last deploy) + upgrade `authority` | `programId` |
| `ton-code` | sha256 of the account code cell | `address` |
| `github-releases` | latest release tag + date (tags when the repo has no releases) | `repo` |
| `github-file` | blob sha of one file | `repo`, `path`, optional `ref` |
| `http-json` | sha256 of canonical JSON; with `path` + `itemKey` the diff names added / removed items | `url`, optional `path` (dot path to an array), `itemKey`, `headers` |
| `http-text` | sha256 of the visible text (scripts / styles / tags stripped), optionally only `between` two markers | `url`, optional `between` |
| `rss` | the newest item titles + links | `url` |

Rules for manifests: addresses and program ids must be the ones the module's source actually calls (copy them from `src/`), one entry per chain the module supports where the address differs; repos must be the protocol's official org; API URLs the ones the provider code requests. `label` is what people read in the digest — name the contract and the chain.

RPC per chain comes from the same env names the matrix uses (`EVM_RPC_URL`, `BASE_RPC_URL`, … `SOLANA_RPC_URL`, `TON_RPC_URL`) with public fallbacks in `watch.mjs`.

## Routes canary (`scripts/watch/routes.mjs`)

One dry quote per corridor in `watch/routes.json`, straight from the provider packages (nothing built, signed or sent), every 6 hours (`routes.yml`) and after the daily watch. State in `watch/routes/state.json`; Telegram only on transitions: a corridor that **stopped quoting** (🔴) or is **quoting again** (🟢). Corridors flagged `suspended` are ones the app pauses today through the Vercel env `NEAR_INTENTS_SUSPENDED_CHAINS`; the canary builds the providers *without* that pause, so when the venue recovers the digest says "paused in the app, lift it" — drop the entry from the env and redeploy. Add a corridor = add a line to `routes.json` (`provider`, `src` / `dst` as `caip2:SYMBOL`, `amount` in source units, optional `note`).
