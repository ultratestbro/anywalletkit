// Watch 2026-11-04: MorphoApi.listVaults asked for `vaultV2s(where: VaultV2Filters)`. The live API
// answers 'Unknown type "VaultV2Filters". Did you mean "VaultV2sFilters"…' (GRAPHQL_VALIDATION_FAILED)
// and a catch-all swallowed it, so no Vault V2 was ever listed. The query now uses the type the
// schema has (introspected 2026-11-04) and a failed V2 query throws instead of shortening the list.
// A listed V2 vault that fails the dead-deposit rule stays listed (the API has no such field, the
// same as caps and gates), and the vault protocol refuses it with a typed error before any approval.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MorphoApi, MorphoDeadDepositError, MorphoVaultProtocolEvm } from '../src/index.js'
import { DEAD, E6, USDC, VAULT_V2, account, makeMorpho } from './fixture.js'

// api.morpho.org, 2026-11-04: vaultV2s(first: 3, where: { chainId_in: [8453], listed: true, assetAddress_in: [USDC] }, orderBy: TotalAssetsUsd, orderDirection: Desc).
const LIVE_V2 = JSON.parse(readFileSync(new URL('./fixtures/api-vault-v2s-base-usdc-2026-11-04.json', import.meta.url), 'utf8')) as { data: { vaultV2s: { items: Array<Record<string, unknown>> } } }
const OLD_TYPE_ERROR = { errors: [{ message: 'Unknown type "VaultV2Filters". Did you mean "VaultV2sFilters", "VaultFilters", "VaultV2Factory", "VaultV2History", or "VaultV2Adapter"?', status: 'GRAPHQL_VALIDATION_FAILED', extensions: {} }] }
// The fields the V2 query selects, all present on `VaultV2` by introspection on 2026-11-04.
const V2_FIELDS = ['address', 'name', 'symbol', 'listed', 'factory', 'chain', 'asset', 'apy', 'netApy', 'totalAssets', 'totalAssetsUsd', 'performanceFee']

const key = (...parts: string[]) => parts.map((p) => p.toLowerCase()).join(':')

/** A stand-in for api.morpho.org that validates the V2 filter type the way the live schema does. */
function liveLikeApi(opts: { v2?: 'ok' | 'down' } = {}) {
  const queries: Array<{ query: string; variables: Record<string, unknown> }> = []
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> }
    queries.push(body)
    if (body.query.includes('vaultV2s')) {
      if (opts.v2 === 'down') return new Response('bad gateway', { status: 502 })
      if (!/\$where: VaultV2sFilters\b/.test(body.query)) return new Response(JSON.stringify(OLD_TYPE_ERROR))
      return new Response(JSON.stringify(LIVE_V2))
    }
    if (body.query.includes('vaults(')) return new Response(JSON.stringify({ data: { vaults: { items: [] } } }))
    return new Response(JSON.stringify({ data: {} }))
  }) as unknown as typeof fetch
  return { api: new MorphoApi('https://example.invalid/graphql', fetchImpl), queries }
}

describe('MorphoApi.listVaults lists Vault V2 (live schema 2026-11-04)', () => {
  it('queries vaultV2s with VaultV2sFilters and maps the live response', async () => {
    const { api, queries } = liveLikeApi()
    const vaults = await api.listVaults({ chainId: 8453, asset: USDC })
    const v2q = queries.find((q) => q.query.includes('vaultV2s'))!
    expect(v2q.query).toMatch(/query\(\$where: VaultV2sFilters, \$first: Int\)/)
    expect(v2q.query).not.toMatch(/VaultV2Filters/)
    expect(v2q.variables).toEqual({ where: { chainId_in: [8453], listed: true, assetAddress_in: [USDC] }, first: 50 })
    for (const f of V2_FIELDS) expect(v2q.query).toMatch(new RegExp(`\\b${f}\\b`))
    expect(vaults.map((v) => v.address)).toEqual(LIVE_V2.data.vaultV2s.items.map((i) => i.address))
    expect(vaults.every((v) => v.version === 'v2' && v.listed && v.chainId === 8453 && v.asset.address === USDC)).toBe(true)
    const sirloin = vaults.find((v) => v.address === VAULT_V2)!
    expect(sirloin).toMatchObject({ name: 'Steakhouse High Yield USDC Edition', factory: '0x4501125508079A99ebBebCE205DeC9593C2b5857', fee: 0.25, totalAssets: 457973629087446n })
    expect(sirloin.netApy).toBeCloseTo(3.323771653995442, 9)
    expect(sirloin.apy).toBeCloseTo(4.456066583434675, 9)
    // Biggest first across both generations.
    const usd = vaults.map((v) => v.totalAssetsUsd ?? 0)
    expect([...usd].sort((a, b) => b - a)).toEqual(usd)
  })

  it('version filter: v1 skips the V2 query, v2 skips the V1 query', async () => {
    const a = liveLikeApi()
    expect(await a.api.listVaults({ chainId: 8453, version: 'v1' })).toEqual([])
    expect(a.queries.some((q) => q.query.includes('vaultV2s'))).toBe(false)
    const b = liveLikeApi()
    expect((await b.api.listVaults({ chainId: 8453, version: 'v2' })).length).toBe(LIVE_V2.data.vaultV2s.items.length)
    expect(b.queries.some((q) => q.query.includes('vaults('))).toBe(false)
  })

  it('a failed V2 query throws; the list is never silently V1-only', async () => {
    await expect(liveLikeApi({ v2: 'down' }).api.listVaults({ chainId: 8453 })).rejects.toThrow(/Morpho API 502/)
  })
})

describe('a listed V2 vault that fails the dead-deposit rule', () => {
  it('stays listed; quoteSupply / supply refuse it with MorphoDeadDepositError before any approval', async () => {
    const { api } = liveLikeApi()
    const listed = (await api.listVaults({ chainId: 8453, asset: USDC })).find((v) => v.address === VAULT_V2)
    expect(listed).toBeDefined()
    const { chain, state } = makeMorpho()
    state.balances.set(key(VAULT_V2, DEAD), 0n) // no dead deposit at all
    const acc = account()
    const p = new MorphoVaultProtocolEvm(acc, { chainId: 8453, vault: listed!.address, provider: chain.provider, api: null })
    expect(await p.getDeadDeposit()).toMatchObject({ ok: false, failure: { reason: 'deadShares' } })
    await expect(p.quoteSupply({ amount: E6 })).rejects.toBeInstanceOf(MorphoDeadDepositError)
    await expect(p.supply({ amount: E6 })).rejects.toMatchObject({ code: 'InsufficientDeadDeposit', target: VAULT_V2 })
    expect(acc.sent).toHaveLength(0)
    expect(chain.calls.some((c) => c.fn === 'allowance' || c.fn === 'deposit' || c.fn === 'previewDeposit')).toBe(false)
  })
})
