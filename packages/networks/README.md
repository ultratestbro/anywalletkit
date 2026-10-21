# @forgewallet/networks

One table of networks for every wallet build: the catalog mainnets with their public RPC failover lists, the default testnets for every chain family, the networks and RPCs the user adds, and a verifier that proves an endpoint serves the network it claims. The mobile app and the extension kit read the same table.

Pure TypeScript, no runtime dependencies beyond `@forgewallet/swap2-assets` (for `isCatalogChain`). Runs under Hermes (no `URL`, no `atob`, no `structuredClone`).

```ts
import { NetworksTable, verifyNetwork, parseAddChainParams, checkRpcUrl } from '@forgewallet/networks'

const table = new NetworksTable(myJsonStorage)          // AsyncStorage / chrome.storage / memoryJsonStorage()
await table.load()                                      // once at cold start; sync readers answer builtin-only before this

await table.addRpc('eip155:8453', 'https://my.base.rpc')
await table.rpcUrlsFor('eip155:8453')                   // ['https://my.base.rpc', 'https://base-rpc.publicnode.com', …]
await table.setOnlyOwnRpc('eip155:8453', true)          // → ['https://my.base.rpc'] (no public fallback)
table.rpcUrlsForSync('eip155:8453')                     // same, from memory — for a sync client factory
table.usesUserRpcSync('eip155:8453')                    // true → label the review sheet "Custom RPC — simulation not trusted"

const r = await verifyNetwork(await table.get('eip155:8453')!, { rpc: 'https://my.base.rpc' })
// { ok: true, latencyMs: 212, tip: 52896400, reported: '8453' }  |  { ok: false, error: 'chain-id-mismatch: Endpoint serves chain 1, not 8453.', reported: '1', … }
await table.markRpc('eip155:8453', 'https://my.base.rpc', r)   // a failure parks the URL (skipped by rpcUrlsFor) with the reason
```

## Model

```ts
interface Network {
  caip2: string            // eip155:11155111, solana:EtWT…, bip122:<genesis>, ton:-3, tron:nile, near:testnet, zcash:testnet
  family: 'evm' | 'solana' | 'ton' | 'tron' | 'btc' | 'near' | 'zcash'
  name: string; symbol: string; decimals: number
  kind: 'catalog' | 'testnet' | 'custom'
  rpcs: string[]           // tried in order
  explorer?: string
  source: 'builtin' | 'user' | { origin: string; addedAt: number }   // a site-added network carries its origin
  onlyOwnRpc?: boolean     // drop the public fallback
  balancesViaOwnRpc?: boolean
  enabled: boolean         // testnets ship off
}
```

Rules the table enforces:

- a builtin entry (catalog mainnet or default testnet) cannot be removed; the user can only **prepend** RPCs and flip toggles — the shipped list stays as the fallback unless `onlyOwnRpc`;
- a custom network has no fallback by definition and needs at least one RPC; a stored custom entry for a builtin chain id is ignored (a site must not replace Ethereum's endpoints);
- `rpcUrlsFor(caip2)` = healthy user RPCs, then the builtin list (unless `onlyOwnRpc` and at least one user RPC is healthy);
- `markRpc(caip2, url, result)` parks a failed user RPC with its error until it passes again or is removed — an endpoint that changes chain id under us is treated as poisoning, not as an outage;
- only the deltas are persisted (`NetworksState`: overrides per builtin, custom networks, issues, the http opt-in), so a shipped list update reaches every install.

## URL policy (owner decision 2)

`checkRpcUrl(url, { allowHttpLocal })`: `https://` anywhere; `http://` only for private addresses — `localhost`, `127/8`, `10/8`, `172.16/12`, `192.168/16`, `*.local`, IPv6 loopback / ULA / link-local — **and** only with `allowHttpLocal` (the Advanced toggle, stored in the table). No credentials in the URL. `parseAddChainParams` never grants the local exception to a site.

## `verifyNetwork(network, { rpc?, fetch?, allowHttpLocal?, timeoutMs? })`

| family | identity (must match the CAIP-2 id) | tip |
|---|---|---|
| evm | `eth_chainId` | `eth_blockNumber` |
| solana | `getGenesisHash` starts with the reference (`solana:mainnet` / `devnet` / `testnet` aliases resolve) | `getSlot` |
| ton | config param 19 (global id, parsed from the BOC) = `-239` / `-3` | `getMasterchainInfo` seqno |
| tron | genesis block id (`wallet/getblockbynum 0`) ends with the chain reference (`728126428` ≙ `0x2b6653dc`, `nile` ≙ `0xcd8690dc`, `shasta` ≙ `0x94a9059e`) | `wallet/getnowblock` |
| btc | Esplora `/block-height/0`, Blockbook `/api/v2/block-index/0` | `/blocks/tip/height` / `bestHeight` |
| zcash | same, plus Blockchair `dashboards/block/0` | `/stats` blocks |
| near | `status.chain_id` | `latest_block_height` |

Returns `{ ok, latencyMs, tip?, error?, reported? }` and never throws. Errors are prefixed with a code: `chain-id-mismatch`, `url-policy`, `http-<status>`, `rpc-error`, `bad-json`, `timeout`, `unreachable`, `no-rpc`, `bad-network`. `verifyRpcs(network)` checks every endpoint. `scripts/verify-live.mjs` runs the real thing against every builtin endpoint.

## Builtin table

`CATALOG_NETWORKS` — the 30 EVM mainnets of the asset catalog (Ethereum, Base, BNB, Arbitrum, Optimism, Polygon, Avalanche, HyperEVM, Robinhood, zkSync, Celo, MegaETH, Unichain, Monad, Plasma, Linea, Gnosis, Sonic, World Chain, Sei, Ink, Plume, X Layer, Scroll, Berachain, Arc, Mantle, Katana, Morph, Flare) with the public failover lists, plus Solana, TON, Tron, Bitcoin, NEAR and Zcash with public endpoints (the mobile app prepends its keyed proxies through the table).

`DEFAULT_TESTNETS` (shipped `enabled: false`; endpoints and identities called on 2026-10-21):

| Network | caip2 | endpoints |
|---|---|---|
| Sepolia | `eip155:11155111` | ethereum-sepolia-rpc.publicnode.com, sepolia.drpc.org (rpc.sepolia.org no longer answers) |
| Base Sepolia | `eip155:84532` | sepolia.base.org, base-sepolia-rpc.publicnode.com |
| Arbitrum Sepolia | `eip155:421614` | sepolia-rollup.arbitrum.io/rpc, arbitrum-sepolia-rpc.publicnode.com |
| OP Sepolia | `eip155:11155420` | sepolia.optimism.io, optimism-sepolia-rpc.publicnode.com |
| Polygon Amoy | `eip155:80002` | polygon-amoy-bor-rpc.publicnode.com, polygon-amoy.drpc.org (rpc-amoy.polygon.technology no longer answers) |
| BSC testnet | `eip155:97` | bsc-testnet-rpc.publicnode.com, data-seed-prebsc-1-s1.bnbchain.org:8545 |
| Monad testnet | `eip155:10143` | testnet-rpc.monad.xyz |
| Solana devnet | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (`wallet-solana` `CAIP2_GENESIS.devnet`) | api.devnet.solana.com |
| Bitcoin testnet4 | `bip122:00000000da84f2bafbbc53dee25a72ae` (genesis from mempool.space/testnet4) | mempool.space/testnet4/api — `wallet-btc`'s `testnet` option (tb1…, coin type 1') serves it; the package's `CAIP2_GENESIS.testnet` is testnet3 |
| TON testnet | `ton:-3` | testnet.toncenter.com/api/v2/jsonRPC (global id -3 confirmed from config param 19) |
| Tron Nile | `tron:nile` (`wallet-tron` also takes `nile` / `tron:0xcd8690dc`) | nile.trongrid.io |
| NEAR testnet | `near:testnet` | rpc.testnet.near.org, test.rpc.fastnear.com |
| Zcash testnet | `zcash:testnet` | **none — unverified.** Blockchair has no zcash/testnet route and no other public API answered; the user supplies a Blockbook |

## EIP-3085

`parseAddChainParams(params, { known?, origin? })` turns a `wallet_addEthereumChain` request into a `Network` (`kind: 'custom'`, `source: { origin, addedAt }`) or the EIP-1193 error to answer with (`-32602` bad params, `4902` chain not in the catalog). https RPCs only; `nativeCurrency.decimals` must be 18. Pass `known` to accept chains outside the asset catalog.
