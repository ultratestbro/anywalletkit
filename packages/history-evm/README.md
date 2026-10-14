# @forgewallet/history-evm

`HistorySource` for every EVM chain the SDK supports. One source per chain
(`chain = "eip155:<id>"`), backed by Etherscan v2 when you have an API key,
with keyless fallbacks (Blockscout `/api/v2`, Routescan's Etherscan-format
mirror) where a public instance exists. Explorer rows are merged into one
`ChainTx` per hash: top-level transaction, ERC-20 transfers and internal
native transfers, with fee, status, call selector and a documented spam flag.

```ts
import { createEvmHistory } from '@forgewallet/history-evm'

const history = createEvmHistory({ chainId: 8453, etherscanApiKey: process.env.ETHERSCAN_API_KEY })
const page = await history.listActivity('0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA', { limit: 50 })
for (const tx of page.items) console.log(tx.hash, tx.status, tx.transfers.length, tx.spam ? 'spam' : '')
const older = await history.listActivity(address, { cursor: page.cursor })
const one = await history.getTransaction(page.items[0].hash, address)
history.explorerTxUrl(one.hash) // https://basescan.org/tx/0x…
```

## Options

| option | default | notes |
|---|---|---|
| `chainId` | — | 1, 8453, 42161, 10, 137, 56, 43114, 100, 130, 143, 999, 146, 80094, 59144, 534352, 324, 42220, 9745, 4326, 4663, 480, 1329, 57073, 98866, 196 |
| `etherscanApiKey` | none | Without it Etherscan is never called: since 2026 `api.etherscan.io/v2` answers `Missing/Invalid API Key` to keyless requests. |
| `etherscanUrl` | `https://api.etherscan.io/v2/api` | Point at a proxy that adds the key server-side. |
| `blockscoutUrl` | built-in table | Any Blockscout `/api/v2` root; adds or overrides the chain's entry. |
| `etherscanCompatUrl` | built-in table (Routescan) | Keyless Etherscan-format endpoint. |
| `fetch` | `globalThis.fetch` | Inject for tests / custom transports. |
| `rateLimit` | 5 rps with a key | Etherscan requests per second. One token bucket per key is shared by every source in the process (25 chains do not multiply the quota). Blockscout: 5 rps per host, Routescan: 2 rps. |
| `prefer` | `'etherscan'` | `'blockscout'` tries Blockscout first to save Etherscan quota. |
| `timeoutMs` | 15 000 | Per request (`AbortSignal.timeout` when the runtime has it). |

Backend order: Etherscan v2 (key + chain in the v2 chainlist) → Routescan → Blockscout.
A failing backend is retried once on rate limiting (HTTP 429/5xx, `Max rate
limit reached`), then the next backend is tried. Plan / key refusals (`Free
API access is not supported for this chain`, `Missing/Invalid API Key`,
`Community Free API Limit reached`, unsupported chainid) skip straight to the
fallback. When nothing is left the source throws `HistoryUnavailableError`
with `chain`, `reason` and one line per `attempts`. Chains in
`NO_EXPLORER_CHAIN_IDS` return an empty page with a `note` instead.

The Etherscan v2 chainlist (`/v2/chainlist`) is fetched once per process and
cached; when it cannot be fetched the table verified on 2026-10-14 is used.

## Chain coverage (verified with curl on 2026-10-14)

Probe used for Blockscout: `GET <root>/api/v2/addresses/0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA/transactions`
and `/api/v2/transactions`, kept only when both answer `200` JSON.

| chain | id | Etherscan v2 | keyless fallback | notes |
|---|---|---|---|---|
| Ethereum | 1 | yes (free plan ok) | Blockscout `eth.blockscout.com`, Routescan | |
| Base | 8453 | yes, **paid plan only** | none | `base.blockscout.com` is behind a Cloudflare JS challenge (403) |
| Arbitrum One | 42161 | yes (free plan ok) | none | `arbitrum.blockscout.com` 403 (Cloudflare) |
| OP Mainnet | 10 | yes, **paid plan only** | Blockscout `explorer.optimism.io` | |
| Polygon | 137 | yes (free plan ok) | none | `polygon.blockscout.com` 403 (Cloudflare) |
| BNB Smart Chain | 56 | yes, **paid plan only** | none | no public Blockscout found |
| Avalanche C-Chain | 43114 | yes, **paid plan only** | Routescan | |
| Gnosis | 100 | yes, **paid plan only** | Blockscout-compatible `gnosisscan.io` | `gnosis.blockscout.com` redirects there |
| Unichain | 130 | yes | Blockscout `unichain.blockscout.com` | |
| Monad | 143 | yes | none | |
| HyperEVM | 999 | yes (free plan ok) | none | |
| Sonic | 146 | yes | none | |
| Berachain | 80094 | yes | none | `beratrail.io` (Routescan UI) answers 202, no JSON |
| Linea | 59144 | yes | none | `explorer.linea.build` has no `/api/v2` |
| Scroll | 534352 | **no** (not in chainlist) | Blockscout-compatible `scrollscan.com` | `scroll.blockscout.com` redirects there |
| zkSync Era | 324 | **no** | Blockscout `zksync.blockscout.com` | |
| Celo | 42220 | yes, community quota | Blockscout `celo.blockscout.com` | |
| Plasma | 9745 | yes | Routescan | |
| MegaETH | 4326 | yes | Blockscout `megaeth.blockscout.com` | |
| Robinhood Chain | 4663 | yes (free plan ok) | none | |
| World Chain | 480 | yes | Blockscout `worldchain-mainnet.explorer.alchemy.com` | |
| Sei | 1329 | yes | none | `seitrace.com` has its own API |
| Ink | 57073 | **no** | Blockscout `explorer.inkonchain.com` | |
| Plume | 98866 | **no** | Blockscout `explorer.plume.org` | |
| X Layer | 196 | **no** | **none** | only OKLink (own API, key); empty page + `note` |

"free plan ok" = a free-tier key returned rows (or `No transactions found`)
that day; "paid plan only" = `Free API access is not supported for this
chain`. Chains marked "yes" without a qualifier were served but the test
wallet has no history there, so the plan tier could not be told apart.
Without a key, the chains with "none" in the fallback column throw
`HistoryUnavailableError` (`no keyless explorer; pass etherscanApiKey`).

## What a `ChainTx` contains

* `time` from `timeStamp` (Etherscan) / ISO `timestamp` (Blockscout).
* `status`: `failed` when `isError = 1` or `txreceipt_status = 0` (Blockscout `status = error`), else `confirmed`.
* `from` / `to` / `nativeValue` from the transaction row. A hash the explorer only lists as a token transfer to the address (incoming ERC-20) has no transaction row: `from`/`to` are then the transfer's, `raw.tx` is absent.
* `fee` = `gasUsed × gasPrice` (Blockscout `fee.value`, receipts `gasUsed × effectiveGasPrice`).
* `call` = `{ to, selector (4 bytes, lowercase), data }` when the input is not `0x`.
* `transfers`: the native value (when > 0), every ERC-20 row (`standard: 'erc20'`, symbol/decimals from the explorer or the swap2 asset catalog), every internal native transfer with value > 0. ERC-721 / ERC-1155 rows are skipped in v1.
* `block` as bigint, `raw = { source, tx, tokens, internal, spam?, spamReason? }` with the untouched explorer rows.
* `EvmChainTx.spam` mirrors `raw.spam`.

`getTransaction(hash, address)` uses Etherscan's `proxy` module
(`eth_getTransactionByHash` + `eth_getTransactionReceipt`; ERC-20 `Transfer`
logs become transfers; no internal transfers, the proxy has no traces) or
Blockscout `/api/v2/transactions/<hash>` + `/token-transfers` +
`/internal-transactions`. Returns `undefined` for an unknown hash.

## Pagination

Explorer lists (transactions, token transfers, internal transfers) paginate
independently, so the source pages by **block window**: each page fetches one
explorer page of every list and emits only rows above the highest cut block
among the lists that still have more rows. Everything emitted is complete
across all three lists, so the merge by hash is exact. The cursor
(base64 JSON: `{ v, b: backend, w: exclusive upper block, lists }`) carries
Blockscout's `next_page_params` per list; Etherscan lists simply re-query with
`endblock = w - 1`. A cursor from one backend resumes on another by block when
the first one fails. `limit` (default 50, max 100) is the explorer page size,
so a page can hold more hashes than `limit` when token/internal rows add
hashes of their own. Degenerate case: when one list has more than `limit` rows
in a single block, that block is emitted once and the remainder skipped.

`since` is applied client-side on `time` (explorers page by block, not time):
rows older than `since` are dropped and the page has no cursor.

## Spam rule

Never applied to a transaction the address itself sent. A tx with at least one
token row is flagged (`raw.spamReason`) when:

1. `zero-value` — every movement in the tx is zero (zero-value `transferFrom`
   address poisoning, even with a catalog token such as USDT);
2. `zero-value-unknown-token` — a token the catalog does not know moved 0;
3. `bulk-airdrop` — 20 or more token rows in one tx and at least one unknown token;
4. `symbol-impersonation` — an unknown token whose symbol contains non-ASCII
   characters (`U⁯S⁯DΤ`) or whose ASCII form equals a catalog symbol on this
   chain (fake "USDT" at another contract).

"Catalog" = `@forgewallet/swap2-assets` (`ccChain('eip155:<id>').assets`).

## Adding a chain

1. Add the id to `SUPPORTED_CHAIN_IDS` and its explorer to `EXPLORER_TX_BASE` in `src/chains.ts`.
2. `curl https://api.etherscan.io/v2/chainlist` — if listed, add to `ETHERSCAN_V2_CHAIN_IDS_FALLBACK`.
3. Probe a Blockscout root (`/api/v2/transactions` must be `200` JSON) → `BLOCKSCOUT_URLS`; Routescan (`https://api.routescan.io/v2/network/mainnet/evm/<id>/etherscan/api?module=account&action=txlist&address=…`) → `ETHERSCAN_COMPAT_URLS`.
4. Nothing answers → `NO_EXPLORER_CHAIN_IDS`.
5. Update the table above with the date, run `pnpm --filter @forgewallet/history-evm test` (the chain-table test enforces that every id is covered).

## Tests

`pnpm --filter @forgewallet/history-evm test` — no network: fixtures in
`tests/fixtures/` are real Etherscan v2 (`chainid=1`, captured with a key —
keyless capture is no longer possible) and `eth.blockscout.com` responses for
the public test wallet `0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA`, plus a
Routescan sample for Avalanche and synthetic rows for a 3-leg swap, a failed
tx, a 20-row airdrop and a fake-USDT dust transfer.
`LIVE_HISTORY=1` (and optionally `ETHERSCAN_API_KEY`) enables the live checks.

Hermes-safe: `fetch` only, guarded `AbortSignal.timeout`, own base64 (no
`Buffer`/`btoa`), no `URL` in `src/`.
