# @anywalletkit/history-evm

`HistorySource` for every EVM chain the SDK supports. One source per chain
(`chain = "eip155:<id>"`), backed by Etherscan v2 when you have an API key,
Blockscout PRO and Alchemy (Transfers API) with theirs, and keyless fallbacks
(Blockscout `/api/v2`, Routescan's Etherscan-format mirror) where a public
instance exists. Explorer rows are merged into one
`ChainTx` per hash: top-level transaction, ERC-20 transfers and internal
native transfers, with fee, status, call selector and a documented spam flag.

```ts
import { createEvmHistory } from '@anywalletkit/history-evm'

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
| `blockscoutProApiKey` | none | Blockscout PRO multichain key (`proapi_…`; free tier 100K credits/day, 5 rps, one key for every Blockscout chain). Etherscan-format with `chain_id=`; tried after Etherscan, so a free Etherscan key + a free PRO key together cover Base, Arbitrum, Polygon, Optimism, Gnosis, Robinhood, Arc, Scroll, zkSync, Ink, Plume without a paid plan. Register at docs.blockscout.com/devs/pro-api. |
| `blockscoutProUrl` / `blockscoutProRateLimit` | `https://api.blockscout.com/v2/api` / 5 | Override the endpoint (proxy) / the per-key limiter. |
| `alchemyApiKey` | none | Alchemy key (free tier: 30M CU/month, no card). Enables the `alchemy` backend: `alchemy_getAssetTransfers` lists + one JSON-RPC batch of `eth_getTransactionByHash`/`eth_getTransactionReceipt` per page. The only free source on **Base** and **BSC**; also a second source for Monad, Berachain, Linea, HyperEVM and Robinhood, which otherwise depend on Etherscan alone. Tried after Etherscan and Blockscout PRO. **Every network must be enabled for the app in the Alchemy dashboard** (see below). |
| `alchemyNetwork` | `ALCHEMY_NETWORKS[chainId]` when the Transfers API is documented for the chain | Slug override (`base-mainnet`). Passing it also forces the backend on for a chain the table lists as undocumented (Sonic, Plasma, MegaETH, Sei, Plume, X Layer). |
| `alchemyUrl` | `https://{network}.g.alchemy.com/v2/{key}` | Host template for a proxy; `{network}` / `{key}` substituted. |
| `alchemyComputeUnitsPerSecond` | 300 | Alchemy compute units per second, shared per key across chains. Each call is charged its published cost (Transfers 120, receipt 20, tx 17, block 16, else 26) and a JSON-RPC batch the sum of its members, so concurrent chains on one key stay under the free tier's 500 CU/s. A rate-limit answer is retried up to three times with backoff. |
| `blockscoutUrl` | built-in table | Any Blockscout `/api/v2` root; adds or overrides the chain's entry. |
| `etherscanCompatUrl` | built-in table (Routescan) | Keyless Etherscan-format endpoint. |
| `fetch` | `globalThis.fetch` | Inject for tests / custom transports. |
| `rateLimit` | 3 rps with a key | Etherscan requests per second (free tier 3, Lite 5, Standard 10). One token bucket per key is shared by every source in the process (25 chains do not multiply the quota). Blockscout: 5 rps per host, Routescan: 2 rps. |
| `prefer` | `'etherscan'` | `'blockscout'` tries Blockscout first to save Etherscan quota; `'alchemy'` tries Alchemy first (Base, where it is the only free one, or to spend Alchemy CU instead of Etherscan calls). |
| `timeoutMs` | 15 000 | Per request (`AbortSignal.timeout` when the runtime has it). |

Backend order: Etherscan v2 (key + chain in the v2 chainlist) → Blockscout PRO
(key) → Alchemy (key + documented Transfers API, or `alchemyNetwork`) →
Routescan → Blockscout. `prefer` moves Blockscout or Alchemy first.
A failing backend is retried once on rate limiting (HTTP 429/5xx, `Max rate
limit reached`), then the next backend is tried. Plan / key refusals (`Free
API access is not supported for this chain`, `Missing/Invalid API Key`,
`Community Free API Limit reached`, unsupported chainid, Blockscout PRO
`Unauthorized` / `Featured chain`, Alchemy `<NETWORK> is not enabled for this
app` / HTTP 401 / 403 / `Unsupported method`) skip straight to the fallback. When nothing is left the source throws `HistoryUnavailableError`
with `chain`, `reason` and one line per `attempts`. Chains in
`NO_EXPLORER_CHAIN_IDS` return an empty page with a `note` instead.

The Etherscan v2 chainlist (`/v2/chainlist`) is fetched once per process and
cached; when it cannot be fetched the table verified on 2026-10-14 is used.

## Chain coverage (verified with curl on 2026-10-14)

With a **Blockscout PRO** key (verified live with a free-tier key on 2026-10-14): served on 1, 10, 100, 130, 534352, 42220, 4326, 4663, 480, 57073, 98866, 5042 and **42161 (Arbitrum)**. "Featured" chains need the Builder plan ($49/mo): **8453 Base, 137 Polygon, 324 zkSync** (`{"error":"Featured chain … requires one of the following plans: Builder, Business, Pro"}` → classified unavailable, falls through). "Network not supported": 56, 43114, 143, 999, 146, 80094, 59144, 9745, 1329, 196, 5000, 747474, 2818, 14. Net effect with a free Etherscan key + a free PRO key: everything has a free source except **Base** (paid Etherscan or Blockscout Builder), **BSC**, **X Layer** and **Morph** — add a free **Alchemy** key (section below) and Base and BSC are covered too; only X Layer (and Sonic / Plasma / MegaETH / Sei / Plume, where Alchemy has no Transfers API) stay on Etherscan alone.

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

## Alchemy backend (`backend: 'alchemy'`)

`alchemy_getAssetTransfers` is called twice per page — `fromAddress` and
`toAddress` — with `category: ['external', 'erc20']` (+ `'internal'` on the
chains in `ALCHEMY_INTERNAL_CHAIN_IDS`), `order: 'desc'`, `withMetadata: true`
(block timestamps), `excludeZeroValue: false` (zero-value address-poisoning
transfers are what the spam rule flags; Alchemy hides them by default) and
`maxCount = limit`. Transfers are de-duplicated by `uniqueId`, grouped by hash,
and the Transfers API's gaps are filled from the same endpoint: every unique
hash of the page gets `eth_getTransactionByHash` + `eth_getTransactionReceipt`
in **one JSON-RPC batch** (≤ 20 requests per HTTP call, one retry) → `from`,
`to`, `value`, `input` → `call.selector`, `status`, `fee = gasUsed ×
effectiveGasPrice`. Blocks whose transfers carried no `metadata.blockTimestamp`
get an `eth_getBlockByNumber` in that batch.

Merge rules (mirroring the Etherscan `txlist` + `tokentx` + `txlistinternal`
merge): `erc20` rows → token transfers (symbol = `asset`, decimals =
`rawContract.decimal`, amount = `rawContract.value`); `internal` rows → native
transfers; `external` rows are the transaction's own value and are already the
tx row's `nativeValue` — they add no second native transfer. Only when the node
has no such tx any more (dropped / reorged, `null` from the batch) is the
external row turned into a bare tx row (`status: confirmed`, no fee) so the
item still renders. ERC-721 / 1155 / special-NFT rows are skipped (v1).
`getTransaction(hash)` = the same batch for one hash + ERC-20 `Transfer` logs of
the receipt + `eth_getBlockByNumber` for the time.

**Pagination is by block, not by `pageKey`.** Measured on base-mainnet on
2026-10-14: a request that carries a `pageKey` ignores `toBlock`; an unknown or
expired `pageKey` (TTL 10 minutes) silently restarts from the first page; a
malformed one is HTTP 400 `Invalid pageKey format`. None of that fits a
cursor that is resumed hours later or re-fetched with a narrower window, so the
Alchemy lists page exactly like the Etherscan ones — `toBlock = w − 1` from the
window cursor, `next` is a marker — and an Alchemy cursor never expires.

**Budget.** 120 CU per Transfers call, 15 CU per `eth_getTransactionByHash`,
15 CU per `eth_getTransactionReceipt`: a 50-item page ≈ 2 × 120 + 50 × 30 ≈
1 740 CU, so the free 30M CU/month is ≈ 17 000 pages (≈ 570 a day); a
`getTransaction` ≈ 45–60 CU. Throughput on the free tier is 500 CU/s, hence the
4 rps advice above.

**Gotcha: enable the network in the Alchemy app.** A new app has only the
networks you tick in the dashboard (Apps → your app → Networks). Every other
slug answers HTTP 403 `{"error":{"code":-32600,"message":"BNB_MAINNET is not
enabled for this app. Visit this page to enable the network: …"}}` — classified
`unavailable`, no retry, next backend. Verified 2026-10-14 with a free key:
`eth-mainnet` and `base-mainnet` answered (including the `internal` category
on both); every other slug below answered "not enabled" until ticked.

Slug table (`ALCHEMY_NETWORKS`; verified 2026-10-14 by `eth_chainId` on every
slug — an existing slug answers the chain id or "not enabled", a non-existent
one does not resolve). "Transfers API" = the chain's docs page
`https://www.alchemy.com/rpc/<chain>.md` lists it under "Supported on …"
(`ALCHEMY_TRANSFERS_CHAIN_IDS`); "internal" = the `internal` category per
docs ("available only on Ethereum Mainnet, Polygon Mainnet, Base Mainnet, Arc
Mainnet, and Arc Testnet"; `ALCHEMY_INTERNAL_CHAIN_IDS`).

| chain | id | slug | Transfers API documented | `internal` category |
|---|---|---|---|---|
| Ethereum | 1 | `eth-mainnet` | yes | yes (verified live) |
| Base | 8453 | `base-mainnet` | yes | yes (verified live) |
| Arbitrum One | 42161 | `arb-mainnet` | yes | no |
| OP Mainnet | 10 | `opt-mainnet` | yes | no |
| Polygon PoS | 137 | `polygon-mainnet` | yes (`/rpc/matic.md`) | yes (docs) |
| BNB Smart Chain | 56 | `bnb-mainnet` | yes | no |
| Avalanche C-Chain | 43114 | `avax-mainnet` | yes | no |
| Gnosis | 100 | `gnosis-mainnet` | yes | no |
| Unichain | 130 | `unichain-mainnet` | yes | no |
| Monad | 143 | `monad-mainnet` | yes | no |
| HyperEVM | 999 | `hyperliquid-mainnet` | yes | no |
| Sonic | 146 | `sonic-mainnet` | **no** ("Not currently supported") | no |
| Berachain | 80094 | `berachain-mainnet` | yes | no |
| Linea | 59144 | `linea-mainnet` | yes | no |
| Scroll | 534352 | `scroll-mainnet` | yes | no |
| zkSync Era | 324 | `zksync-mainnet` | yes | no |
| Celo | 42220 | `celo-mainnet` | yes | no |
| Plasma | 9745 | `plasma-mainnet` | **no** | no |
| MegaETH | 4326 | `megaeth-mainnet` | **no** | no |
| Robinhood Chain | 4663 | `robinhood-mainnet` | yes | no |
| World Chain | 480 | `worldchain-mainnet` | yes | no |
| Sei | 1329 | `sei-mainnet` | **no** | no |
| Ink | 57073 | `ink-mainnet` | yes | no |
| Plume | 98866 | `plume-mainnet` | **no** (no Alchemy docs page) | no |
| X Layer | 196 | `xlayer-mainnet` | **no** | no |
| Arc | 5042 | `arc-mainnet` | yes | yes (docs) |

Only Ethereum and Base were exercised end to end (the test key had only those
two networks enabled); the other rows are slug + documentation checks. Chains
marked "no" are not tried unless `alchemyNetwork` is passed.

## What a `ChainTx` contains

* `time` from `timeStamp` (Etherscan) / ISO `timestamp` (Blockscout) / `metadata.blockTimestamp` (Alchemy, else `eth_getBlockByNumber`).
* `status`: `failed` when `isError = 1` or `txreceipt_status = 0` (Blockscout `status = error`, receipt `status = 0x0`), else `confirmed`.
* `from` / `to` / `nativeValue` from the transaction row. A hash the explorer only lists as a token transfer to the address (incoming ERC-20) has no transaction row: `from`/`to` are then the transfer's, `raw.tx` is absent.
* `fee` = `gasUsed × gasPrice` (Blockscout `fee.value`; Alchemy and the Etherscan proxy path: receipt `gasUsed × effectiveGasPrice`).
* `call` = `{ to, selector (4 bytes, lowercase), data }` when the input is not `0x`.
* `transfers`: the native value (when > 0), every ERC-20 row (`standard: 'erc20'`, symbol/decimals from the explorer or the swap2 asset catalog), every internal native transfer with value > 0. ERC-721 / ERC-1155 rows are skipped in v1.
* `block` as bigint, `raw = { source, tx, tokens, internal, spam?, spamReason? }` with the untouched explorer rows (Alchemy: `raw.tx = { tx, receipt }` JSON-RPC objects, `raw.tokens` / `raw.internal` the Transfers API rows).
* `EvmChainTx.spam` mirrors `raw.spam`.

`getTransaction(hash, address)` uses Etherscan's `proxy` module or Alchemy's
JSON-RPC (`eth_getTransactionByHash` + `eth_getTransactionReceipt`; ERC-20
`Transfer` logs become transfers; no internal transfers, neither has traces) or
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
`endblock = w - 1`, Alchemy lists with `toBlock = w - 1`. A cursor from one backend resumes on another by block when
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

"Catalog" = `@anywalletkit/swap2-assets` (`ccChain('eip155:<id>').assets`).

## Adding a chain

1. Add the id to `SUPPORTED_CHAIN_IDS` and its explorer to `EXPLORER_TX_BASE` in `src/chains.ts`.
2. `curl https://api.etherscan.io/v2/chainlist` — if listed, add to `ETHERSCAN_V2_CHAIN_IDS_FALLBACK`.
3. Probe a Blockscout root (`/api/v2/transactions` must be `200` JSON) → `BLOCKSCOUT_URLS`; Routescan (`https://api.routescan.io/v2/network/mainnet/evm/<id>/etherscan/api?module=account&action=txlist&address=…`) → `ETHERSCAN_COMPAT_URLS`.
4. Alchemy: `curl -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' https://<slug>.g.alchemy.com/v2/<key>` → `ALCHEMY_NETWORKS`; `https://www.alchemy.com/rpc/<chain>.md` lists "Transfers API" → `ALCHEMY_TRANSFERS_CHAIN_IDS` (and `ALCHEMY_INTERNAL_CHAIN_IDS` when the `internal` category is documented).
5. Nothing answers → `NO_EXPLORER_CHAIN_IDS`.
6. Update the tables above with the date, run `pnpm --filter @anywalletkit/history-evm test` (the chain-table tests enforce that every id is covered and has an Alchemy slug).

## Tests

`pnpm --filter @anywalletkit/history-evm test` — no network: fixtures in
`tests/fixtures/` are real Etherscan v2 (`chainid=1`, captured with a key —
keyless capture is no longer possible) and `eth.blockscout.com` responses for
the public test wallet `0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA`, plus a
Routescan sample for Avalanche and synthetic rows for a 3-leg swap, a failed
tx, a 20-row airdrop and a fake-USDT dust transfer. Alchemy fixtures
(`alchemy-base-*.json`, base-mainnet, same wallet, captured with a free key on
2026-10-14): the `fromAddress` / `toAddress` Transfers pages (incl. `internal`
rows, an Aave supply and withdraw, inbound-via-internal payments and
non-ASCII spoofed tokens), the tx + receipt batch for every hash in them
(calldata longer than 2 KB and receipts with many logs trimmed, marked
`_inputTrimmed` / `_logsTrimmed`), and the `is not enabled for this app`
envelope. `LIVE_HISTORY=1` (and optionally `ETHERSCAN_API_KEY` /
`ALCHEMY_API_KEY`) enables the live checks.

Hermes-safe: `fetch` only, guarded `AbortSignal.timeout`, own base64 (no
`Buffer`/`btoa`), no `URL` in `src/`.
