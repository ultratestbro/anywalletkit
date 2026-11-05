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
  "module": "@anywalletkit/protocol-lending-aave-evm",
  "sources": [
    {"id": "pool-eth-core", "type": "evm-proxy", "chainId": 1, "address": "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", "label": "Aave v3 Pool · Ethereum core"},
    {"id": "quoter-base", "type": "evm-code", "chainId": 8453, "address": "0x…", "label": "QuoterV2 · Base"},
    {"id": "ap-router-eth", "type": "evm-call", "chainId": 1, "to": "0x5ffe7FB82894076ECB99A30D6A32e969e6e35E98",
     "signature": "get_id_info(uint256)", "args": [2], "decode": "(address,string,uint256,uint256)", "label": "Curve AddressProvider id 2 (router) · Ethereum"},
    {"id": "scrvusd-shutdown", "type": "evm-call", "chainId": 1, "to": "0x0655…4367", "signature": "isShutdown()", "decode": "bool", "label": "scrvUSD isShutdown · Ethereum"},
    {"id": "klend", "type": "solana-program", "programId": "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", "label": "Kamino Lend program"},
    {"id": "pool", "type": "ton-code", "address": "EQ…", "label": "Tonstakers pool"},
    {"id": "address-book", "type": "github-releases", "repo": "bgd-labs/aave-address-book"},
    {"id": "deployments", "type": "github-file", "repo": "owner/repo", "path": "deployments/mainnet.json", "ref": "main"},
    {"id": "chains", "type": "http-json", "url": "https://li.quest/v1/chains", "path": "chains", "itemKey": "id", "label": "LI.FI chains"},
    {"id": "docs-fees", "type": "http-text", "url": "https://developers.circle.com/cctp/…", "between": ["<main", "</main>"], "label": "CCTP fee docs"},
    {"id": "blog", "type": "rss", "url": "https://blog.example.com/rss.xml"},
    {"id": "deployments-status", "type": "json-pins", "url": "https://developers.uniswap.org/deployments.json", "format": "uniswap-deployments",
     "pins": {"from": "dist/index.js", "export": "UNISWAP_V3", "group": "$key", "roles": {"quoter": "QuoterV2"}}, "status": "active"},
    {"id": "diamond-selectors-base", "type": "evm-selectors", "chainId": 8453, "address": "0x1231…4EaE",
     "selectors": {"file": "src/calldata.ts", "consts": ["BRIDGE_CALLS", "GENERIC_SWAPS"]}}
  ]
}
```

| type | what is compared | needs |
|---|---|---|
| `evm-proxy` | EIP-1967 implementation / admin / beacon slots + code hash of the address; with no EIP-1967 slot, the address's own `implementation()` (AragonProxy stETH, FiatTokenProxy USDC) — only a revert reads as "none", any other RPC failure keeps the previous value | `chainId`, `address` |
| `evm-code` | keccak256 of `eth_getCode` | `chainId`, `address` |
| `evm-call` | the decoded answer of one read-only `eth_call` (a registry entry, `version()`, a pause flag, a role): the digest names old → new. `decode` is `uint256` / `int256` (decimal strings, bigint-exact), `address`, `bool`, `string`, `bytes32`, a tuple such as `(address,string,uint256,uint256)`, a list of those for a multi-value return, or `raw` (default; a long raw answer is compared by hash). A revert is a reading ("reverted") and compared like any answer; any other RPC failure keeps the previous value. Arguments are static only (`uint*`, `int*`, `address`, `bool`, `bytesN`; integers beyond 2^53 as strings) | `chainId`, `to`, `signature` + `args` or `data` (0x calldata), optional `decode` |
| `solana-program` | programdata `slot` (last deploy) + upgrade `authority` | `programId` |
| `ton-code` | sha256 of the account code cell | `address` |
| `github-releases` | latest release tag + date (tags when the repo has no releases) | `repo`, optional `tagPrefix` (string or list: in a monorepo, only releases whose tag starts with one of them count) |
| `github-file` | blob sha of one file | `repo`, `path`, optional `ref` |
| `http-json` | sha256 of canonical JSON; with `path` + `itemKey` the diff names added / removed items | `url`, optional `path` (dot path to an array), `itemKey`, `headers` |
| `http-text` | sha256 of the visible text (scripts / styles / tags stripped), optionally only `between` two markers | `url`, optional `between` |
| `rss` | the newest item titles + links | `url` |
| `json-pins` | every address the module pins, loaded from its **built** entry (`pins.from`, inside the package: the watch job runs `pnpm build` first), looked up in the official list `format` reads from `url` (`uniswap-deployments`: deployments.json; `aave-docs-markets`: the market tables embedded in aave.com/docs/reference/addresses; `curve-deployments`: docs.curve.finance/deployments.json — routers as "router" (ids `ethereum.router-v2`, `arbitrum.router`, …), "address-provider", "meta-registry", "stableswap-factory" / "twocrypto-factory" / "tricrypto-factory" / "fxswap-factory", the tokens "crvUSD" / "scrvUSD" / "CRV" (`<chain>.tokens.<symbol>`) and "scrvUSD vault", grouped by chain id for the chains the SDK carries): listed in its group, under the contract name `roles` gives it, with `status` when set. A listing / name / status change is a diff; a failing pin is reported **on every run** until fixed | `url`, `format`, `pins` (`from`, `export`, optional `call`, `group` = a field or `$key`, `roles` = field → contract name), optional `status` |
| `evm-selectors` | what each selector the module accepts resolves to on a Diamond (DiamondLoupe `facets()`, one call); the selectors are read from the module's source on every run (`selectors.file`, keys of `selectors.consts`), so they never drift. A selector whose facet is removed or replaced, or that the source starts / stops listing, is a diff | `chainId`, `address`, `selectors` |

A source whose `type` changed in the manifest, and an `evm-proxy` whose first-ever `implementation()` reading is its only change, take a new baseline without a diff (the old value came from another fetcher; nothing changed upstream). That second exemption is one-time: every reading that asked `implementation()` is stored with `implProbe: true`, and on a probed proxy an `implementation()` that starts answering is reported like any upgrade.

Each stored value also records its `target` (`chainId`, `address`, `programId`, `url`, `repo`, `path`, `ref` from the manifest, and for `evm-call` its `to`, `data` / `signature` + `args` and `decode`; EVM addresses lowercased). When the manifest points an existing id somewhere else, the old value belongs to the old target: the source takes a new baseline and the digest lists it under **Re-pointed (new baseline, not a change)** instead of reporting a code change. Entries stored before targets existed are compared as before and get their target on the next run.

Rules for manifests: addresses and program ids must be the ones the module's source actually calls (copy them from `src/`), one entry per chain the module supports where the address differs; repos must be the protocol's official org; API URLs the ones the provider code requests. `label` is what people read in the digest — name the contract and the chain.

RPC per chain comes from the same env names the matrix uses (`EVM_RPC_URL`, `BASE_RPC_URL`, … `SOLANA_RPC_URL`, `TON_RPC_URL`) with public fallbacks in `watch.mjs`.

## Routes canary (`scripts/watch/routes.mjs`)

One dry quote per corridor in `watch/routes.json`, straight from the provider packages (nothing built, signed or sent), every 6 hours (`routes.yml`) and after the daily watch. State in `watch/routes/state.json`; Telegram only on transitions: a corridor that **stopped quoting** (🔴) or is **quoting again** (🟢). Corridors flagged `suspended` are ones the app pauses today through the Vercel env `NEAR_INTENTS_SUSPENDED_CHAINS`; the canary builds the providers *without* that pause, so when the venue recovers the digest says "paused in the app, lift it" — drop the entry from the env and redeploy. Add a corridor = add a line to `routes.json` (`provider`, `src` / `dst` as `caip2:SYMBOL`, `amount` in source units, optional `note`).
