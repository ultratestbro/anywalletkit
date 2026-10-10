// Morpho's public GraphQL API — discovery (which vaults / markets exist and
// are listed) and decoration (APY, TVL). Never on a money path: everything the
// contracts need is read on-chain. Schema as of 2026-10-10 (`listed`, not the
// older `whitelisted`; markets carry `marketId`).
import type { Address, Hex } from 'viem'
import { MORPHO_API } from './chains.js'

export interface ApiVault {
  address: Address
  chainId: number
  name: string
  symbol: string
  version: 'v1' | 'v2'
  listed: boolean
  factory: Address | null
  asset: { address: Address; symbol: string; decimals: number }
  /** Percent. `netApy` is after fees and including rewards; `apy` is the gross native rate. */
  apy: number | null
  netApy: number | null
  totalAssets: bigint | null
  totalAssetsUsd: number | null
  /** Fraction (0.1 = 10 % of yield). V2 reports the performance fee here. */
  fee: number | null
}

export interface ApiMarket {
  id: Hex
  chainId: number
  listed: boolean
  loanAsset: { address: Address; symbol: string; decimals: number }
  collateralAsset: { address: Address; symbol: string; decimals: number } | null
  oracle: Address | null
  irm: Address
  lltv: bigint
  supplyApy: number | null
  borrowApy: number | null
  utilization: number | null
  supplyAssetsUsd: number | null
  liquidityAssets: bigint | null
}

const VAULT_FIELDS = 'address name symbol listed factory { address } chain { id } asset { address symbol decimals } state { apy netApy totalAssets totalAssetsUsd fee }'
const VAULT_V2_FIELDS = 'address name symbol listed factory { address } chain { id } asset { address symbol decimals } apy netApy totalAssets totalAssetsUsd performanceFee'
const MARKET_FIELDS = 'marketId listed lltv irmAddress chain { id } oracle { address } loanAsset { address symbol decimals } collateralAsset { address symbol decimals } state { supplyApy borrowApy utilization supplyAssetsUsd liquidityAssets }'

const pct = (x: unknown): number | null => (typeof x === 'number' ? x * 100 : null)
const big = (x: unknown): bigint | null => (x === null || x === undefined ? null : BigInt(String(x).split('.')[0]!))

export class MorphoApi {
  constructor(private readonly endpoint: string = MORPHO_API, private readonly fetchImpl: typeof fetch = fetch) {}

  private async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchImpl(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) })
    if (!res.ok) throw new Error(`Morpho API ${res.status}`)
    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
    if (json.errors?.length) throw new Error(`Morpho API: ${json.errors.map((e) => e.message).join('; ')}`)
    return json.data as T
  }

  private v1(item: Record<string, never>): ApiVault {
    const i = item as unknown as { address: Address; name: string; symbol: string; listed: boolean; factory: { address: Address } | null; chain: { id: number }; asset: ApiVault['asset']; state: Record<string, unknown> | null }
    return {
      address: i.address, chainId: i.chain.id, name: i.name, symbol: i.symbol, version: 'v1', listed: i.listed, factory: i.factory?.address ?? null, asset: i.asset,
      apy: pct(i.state?.apy), netApy: pct(i.state?.netApy), totalAssets: big(i.state?.totalAssets), totalAssetsUsd: typeof i.state?.totalAssetsUsd === 'number' ? i.state.totalAssetsUsd : null,
      fee: typeof i.state?.fee === 'number' ? i.state.fee : null,
    }
  }

  private v2(item: Record<string, never>): ApiVault {
    const i = item as unknown as { address: Address; name: string; symbol: string; listed: boolean; factory: { address: Address } | null; chain: { id: number }; asset: ApiVault['asset']; apy?: number; netApy?: number; totalAssets?: unknown; totalAssetsUsd?: number; performanceFee?: number }
    return {
      address: i.address, chainId: i.chain.id, name: i.name, symbol: i.symbol, version: 'v2', listed: i.listed, factory: i.factory?.address ?? null, asset: i.asset,
      apy: pct(i.apy), netApy: pct(i.netApy), totalAssets: big(i.totalAssets), totalAssetsUsd: typeof i.totalAssetsUsd === 'number' ? i.totalAssetsUsd : null,
      fee: typeof i.performanceFee === 'number' ? i.performanceFee : null,
    }
  }

  /** Listed vaults on a chain (both generations), optionally for one deposit asset, biggest first. */
  async listVaults(o: { chainId: number; asset?: Address; first?: number; version?: 'v1' | 'v2' }): Promise<ApiVault[]> {
    const where = { chainId_in: [o.chainId], listed: true, ...(o.asset ? { assetAddress_in: [o.asset] } : {}) }
    const first = o.first ?? 50
    const out: ApiVault[] = []
    if (o.version !== 'v2') {
      const d = await this.query<{ vaults: { items: Record<string, never>[] } }>(
        `query($where: VaultFilters, $first: Int) { vaults(first: $first, where: $where, orderBy: TotalAssetsUsd, orderDirection: Desc) { items { ${VAULT_FIELDS} } } }`, { where, first })
      out.push(...d.vaults.items.map((i) => this.v1(i)))
    }
    if (o.version !== 'v1') {
      try {
        const d = await this.query<{ vaultV2s: { items: Record<string, never>[] } }>(
          `query($where: VaultV2Filters, $first: Int) { vaultV2s(first: $first, where: $where, orderBy: TotalAssetsUsd, orderDirection: Desc) { items { ${VAULT_V2_FIELDS} } } }`, { where, first })
        out.push(...d.vaultV2s.items.map((i) => this.v2(i)))
      } catch { /* V2 listing is best effort: the schema is younger */ }
    }
    return out.sort((a, b) => (b.totalAssetsUsd ?? 0) - (a.totalAssetsUsd ?? 0))
  }

  /** One vault by address, whichever generation it is; null when the API does not know it. */
  async vault(address: Address, chainId: number): Promise<ApiVault | null> {
    try {
      const d = await this.query<{ vaultByAddress: Record<string, never> | null }>(
        `query($address: String!, $chainId: Int) { vaultByAddress(address: $address, chainId: $chainId) { ${VAULT_FIELDS} } }`, { address, chainId })
      if (d.vaultByAddress) return this.v1(d.vaultByAddress)
    } catch { /* not a V1 vault */ }
    try {
      const d = await this.query<{ vaultV2ByAddress: Record<string, never> | null }>(
        `query($address: String!, $chainId: Int!) { vaultV2ByAddress(address: $address, chainId: $chainId) { ${VAULT_V2_FIELDS} } }`, { address, chainId })
      if (d.vaultV2ByAddress) return this.v2(d.vaultV2ByAddress)
    } catch { /* unknown */ }
    return null
  }

  private market(i: Record<string, never>): ApiMarket {
    const m = i as unknown as { marketId: Hex; listed: boolean; lltv: string; irmAddress: Address; chain: { id: number }; oracle: { address: Address } | null; loanAsset: ApiMarket['loanAsset']; collateralAsset: ApiMarket['collateralAsset']; state: Record<string, unknown> | null }
    return {
      id: m.marketId, chainId: m.chain.id, listed: m.listed, loanAsset: m.loanAsset, collateralAsset: m.collateralAsset, oracle: m.oracle?.address ?? null, irm: m.irmAddress, lltv: BigInt(m.lltv),
      supplyApy: pct(m.state?.supplyApy), borrowApy: pct(m.state?.borrowApy), utilization: typeof m.state?.utilization === 'number' ? m.state.utilization : null,
      supplyAssetsUsd: typeof m.state?.supplyAssetsUsd === 'number' ? m.state.supplyAssetsUsd : null, liquidityAssets: big(m.state?.liquidityAssets),
    }
  }

  /** Listed Blue markets on a chain, optionally filtered by loan / collateral token, biggest first. */
  async listMarkets(o: { chainId: number; loanToken?: Address; collateralToken?: Address; first?: number }): Promise<ApiMarket[]> {
    const where = {
      chainId_in: [o.chainId], listed: true,
      ...(o.loanToken ? { loanAssetAddress_in: [o.loanToken] } : {}),
      ...(o.collateralToken ? { collateralAssetAddress_in: [o.collateralToken] } : {}),
    }
    const d = await this.query<{ markets: { items: Record<string, never>[] } }>(
      `query($where: MarketFilters, $first: Int) { markets(first: $first, where: $where, orderBy: SupplyAssetsUsd, orderDirection: Desc) { items { ${MARKET_FIELDS} } } }`, { where, first: o.first ?? 50 })
    return d.markets.items.map((i) => this.market(i))
  }

  async marketById(id: Hex, chainId: number): Promise<ApiMarket | null> {
    try {
      const d = await this.query<{ marketById: Record<string, never> | null }>(
        `query($id: String!, $chainId: Int!) { marketById(marketId: $id, chainId: $chainId) { ${MARKET_FIELDS} } }`, { id, chainId })
      return d.marketById ? this.market(d.marketById) : null
    } catch {
      return null
    }
  }
}
