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
| `evm-call` | the decoded answer of one read-only `eth_call` (a registry entry, `version()`, a pause flag, a role): the digest names old → new. `decode` is `uint256` / `int256` (decimal strings, bigint-exact), `address`, `bool`, `string`, `bytes32`, a tuple such as `(address,string,uint256,uint256)`, a list of those for a multi-value return, or `raw` (default; a long raw answer is compared by hash). A revert is a reading ("reverted") and compared like any answer; any other RPC failure keeps the previous value. A revert is a JSON-RPC error with code 3 or a message that starts with "execution reverted" (`isRevert` in evm-call.mjs; `evm-proxy`'s `implementation()` probe uses the same rule), so a gateway error that only mentions the word ("request reverted by gateway") is a failure, not a reading. Arguments are static only (`uint*`, `int*`, `address`, `bool`, `bytesN`; integers beyond 2^53 as strings) | `chainId`, `to`, `signature` + `args` or `data` (0x calldata), optional `decode` |
| `solana-program` | programdata `slot` (last deploy) + upgrade `authority` | `programId` |
| `ton-code` | sha256 of the account code cell | `address` |
| `github-releases` | latest release tag + date (tags when the repo has no releases) | `repo`, optional `tagPrefix` (string or list: in a monorepo, only releases whose tag starts with one of them count) |
| `github-file` | blob sha of one file | `repo`, `path`, optional `ref` |
| `http-json` | sha256 of canonical JSON; with `path` + `itemKey` the diff names added / removed items | `url`, optional `path` (dot path to an array), `itemKey`, `headers` |
| `http-text` | sha256 of the visible text (scripts / styles / tags stripped), optionally only `between` two markers | `url`, optional `between` |
| `rss` | the newest item titles + links | `url` |
| `zcash-branch` | the consensus branch id in the header of a v5 / v6 transaction mined two to five blocks below the tip (Blockchair, optional `BLOCKCHAIR_KEY`) against `branchIdForHeight` of the module's **built** entry: a new id is a diff, a mismatch is reported **on every run** until the upgrade table is fixed (NU7 refused every send on 2026-11-06) | `from` |
| `json-pins` | every address the module pins, loaded from its **built** entry (`pins.from`, inside the package: the watch job runs `pnpm build` first), looked up in the official list `format` reads from `url` (`uniswap-deployments`: deployments.json; `aave-docs-markets`: the market tables embedded in aave.com/docs/reference/addresses; `curve-deployments`: docs.curve.finance/deployments.json — routers as "router" (ids `ethereum.router-v2`, `arbitrum.router`, …), "address-provider", "meta-registry", "stableswap-factory" / "twocrypto-factory" / "tricrypto-factory" / "fxswap-factory", the tokens "crvUSD" / "scrvUSD" / "CRV" (`<chain>.tokens.<symbol>`) and "scrvUSD vault", grouped by chain id for the chains the SDK carries): listed in its group, under the contract name `roles` gives it, with `status` when set. A listing / name / status change is a diff; a failing pin is reported **on every run** until fixed | `url`, `format`, `pins` (`from`, `export`, optional `call`, `group` = a field or `$key`, `roles` = field → contract name), optional `status` |
| `evm-initialize` | **stateful**: a Uniswap v4 PoolManager's `Initialize` log from the stored `lastBlock + 1` to the head (pair-filtered on the pinned list's `tokens`, `window`-block `eth_getLogs` steps — a window the node refuses is cut to the limit its error names (World Chain / X Layer "block range greater than 100 max", sent with HTTP 400 and read as the node's answer), else halved — at most `maxCalls` per run — a run that stops short says so on every run until it catches up), and the liveness (StateView slot0 + liquidity through Multicall3, one block) of every pool in the module's **built** pin list plus the unlisted ones it has seen. Compared: the unlisted hookless pools between list tokens under the fee cap (each with its live flag: a new one is a diff, and again when it turns live — rebuild the list and release) and the listed pools that read dead three runs in a row (removal candidates, never removed automatically: the lists only grow, so a server on an older list never routes through a pool a newer app's list dropped). The first run — and a run whose stored reading was discarded (the source re-pointed or its type changed) — scans from the block the pinned list was built at (`list.block + 1`; `maxCalls` and the "behind" problem bound and report a long catch-up) and is compared against the empty reading there, so a pool initialized between the list build and the first watch run is reported like any later one (a `--baseline` run prints it and sends nothing; a list without `block` starts at the head). Positive control: every run that scans also asks the same logs endpoint, with the scan's own filter, for the one block of `canary` — the known `Initialize` log of a pool in the pinned list, at or before the list's block — and fails the source when that log is not in the answer, so an endpoint that answers `[]` for a range it does not index (a pruned log index, a gateway dropping results: `bsc-rpc.publicnode.com` did, 2026-11-26) never moves `lastBlock` past blocks it did not read. Any failed read fails the source and nothing advances | `chainId`, `poolManager`, `stateView`, `pools` (`from`, `export`: the per-chain list), `canary` (`block`, `poolId`: required), optional `logsRpc` (a public https endpoint with wide log windows), `window` (default 10000), `feeCap` (default 100000), `maxCalls` (default 300), `confirm` (default 20) |
| `evm-selectors` | what each selector the module accepts resolves to on a Diamond (DiamondLoupe `facets()`, one call); the selectors are read from the module's source on every run (`selectors.file`, keys of `selectors.consts`), so they never drift. A selector whose facet is removed or replaced, or that the source starts / stops listing, is a diff | `chainId`, `address`, `selectors` |

TON contract state has no decoded type: `ton-code` sees an upgrade only once it ran. For a contract whose data never changes in normal operation (an admin-upgradable factory such as Omniston's TON Escrow Minters: admin, pending admin / code and upgrade time live in its data), add an `http-json` source on `https://tonapi.io/v2/blockchain/accounts/<address>` with `path: "data"`: any change to the data cell is a diff, so a scheduled upgrade is reported when it is scheduled, not when it runs. The digest only says the data changed; decode it by hand. Never point it at the whole account: balance and last transaction change every block.

A source whose `type` changed in the manifest, and an `evm-proxy` whose first-ever `implementation()` reading is its only change, take a new baseline without a diff (the old value came from another fetcher; nothing changed upstream). That second exemption is one-time: every reading that asked `implementation()` is stored with `implProbe: true`, and on a probed proxy an `implementation()` that starts answering is reported like any upgrade.

Each stored value also records its `target` (`chainId`, `address`, `programId`, `url`, `repo`, `path`, `ref` from the manifest, and for `evm-call` its `to`, `data` / `signature` + `args` and `decode`; EVM addresses lowercased). When the manifest points an existing id somewhere else, the old value belongs to the old target: the source takes a new baseline and the digest lists it under **Re-pointed (new baseline, not a change)** instead of reporting a code change. Entries stored before targets existed are compared as before and get their target on the next run.

A source may carry `"severity": "high" | "medium" | "low"`: how much a change of it matters to the module (0x's `settler-in-force-*`, `ownerOf(2)`: a new Settler in force refuses native-coin sales from that day, so `high`). It is copied into the diff entry (`changes[].severity`), the change leads its module in the digest and in Telegram, and the header counts it (`3 changed (1 severity high)`). Any other value fails the run. It is not part of the source's target: adding or changing it is no re-point.

Rules for manifests: addresses and program ids must be the ones the module's source actually calls (copy them from `src/`), one entry per chain the module supports where the address differs; repos must be the protocol's official org; API URLs the ones the provider code requests. `label` is what people read in the digest — name the contract and the chain.

RPC per chain comes from the same env names the matrix uses (`EVM_RPC_URL`, `BASE_RPC_URL`, … `SOLANA_RPC_URL`, `TON_RPC_URL`) with public fallbacks in `watch.mjs`.

## Module canary (`scripts/watch/canary.mjs`)

Each module's own read-only `verify:live`, daily after the watch (the "run canary" step of `watch.yml`); state in `watch/canary/state.json`, the day's rows in `watch/canary/<date>.json`, Telegram on transitions and failures. A job's note (state, day file, Telegram) is cut for length. A job the canary declares with `summaryLines: true` (only the 0x job: it prints these lines last, from its own verdicts) has its `Reason: …` line lead the note, kept whole (canary-status.mjs: `Reason: NEW on 1, 10; unreachable on 143` names every chain that is not ok; before, one NEW line filled the whole note), and its `Severity: high | medium | low` line kept on the row as `severity` and shown in Telegram; a failing job whose severity changes is a transition. A job that fails its one retry too keeps the higher severity of the two runs, and the first run's `Reason:` lines the retry does not repeat lead the note (`Reason: NEW on 8453 | Reason: unreachable on 8453`): a retry on a rate-limited RPC does not wipe out a first run's new deployment. Warning notes, and every failure note of a job without `summaryLines`, are what the canary stored before 2026-11-26, byte for byte, so an unchanged warning is not posted as changed. In every other job's output those lines may be upstream text, so there `Reason:` is one more cause line and `Severity:` is ignored. With a `Reason:` line and no cause line, the note fills what room is left with the job's own failing lines (`BAD quote … (HTTP 429)`, a BAD chain's failing checks), and the retry wait is chosen from all of them, so a rate limit on any corridor waits the 60 s. The 0x job gets `RPC_<chainId>` for every `*_RPC_URL` variable that is set, followed by the chain's public endpoint as the retry (its own public endpoints otherwise), and fails on a chain no RPC answered; a read the RPC did not answer (a rate limit returned as a JSON-RPC error, an answer for another chain) moves to the next endpoint and is never read as a refused sale.

**Known gap:** triage is not fired from the watch commit job yet, so a change the watch commits (a new 0x Settler in force, `settler-in-force-*`, severity high) is ticketed from the next day's diff, up to ~32 h after the deployment. Firing it from the commit step needs `TRIAGE_FIRE_URL` and its token as CI secrets; it is a follow-up on the SDK board. Until then the canary's `Severity: high` row and its Telegram line are the same-day signal.

## Routes canary (`scripts/watch/routes.mjs`)

One dry quote per corridor in `watch/routes.json`, straight from the provider packages (nothing built, signed or sent), every 6 hours (`routes.yml`) and after the daily watch. State in `watch/routes/state.json`; Telegram only on transitions: a corridor that **stopped quoting** (🔴) or is **quoting again** (🟢). Corridors flagged `suspended` are ones the app pauses today through the Vercel env `NEAR_INTENTS_SUSPENDED_CHAINS`; the canary builds the providers *without* that pause, so when the venue recovers the digest says "paused in the app, lift it" — drop the entry from the env and redeploy. Add a corridor = add a line to `routes.json` (`provider`, `src` / `dst` as `caip2:SYMBOL`, `amount` in source units, optional `note`).
