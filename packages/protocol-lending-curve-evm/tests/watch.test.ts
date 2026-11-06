// Every address the scrvUSD module pins has a watch source, and the vault's state the module gates on (shutdown,
// apiVersion, role manager, the unlock window, strategies) is read by an evm-call against the pinned value.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CURVE_LENDING_CHAINS, SCRVUSD, SCRVUSD_DEPLOYMENTS } from '../src/index.js'

interface Source { id: string; type: string; chainId?: number; address?: string; to?: string; signature?: string; decode?: string; format?: string; pins?: { from: string; export: string; group: string; roles: Record<string, string> } }
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../watch.json', import.meta.url)), 'utf8')) as { module: string; sources: Source[] }
const lc = (a: string) => a.toLowerCase()

describe('watch.json coverage', () => {
  it('names this module', () => expect(manifest.module).toBe('@anywalletkit/protocol-lending-curve-evm'))
  it('the vault and its implementation have evm-code sources on Ethereum', () => {
    const code = new Set(manifest.sources.filter((s) => s.type === 'evm-code').map((s) => `${s.chainId} ${lc(s.address!)}`))
    expect(code.has(`1 ${lc(SCRVUSD.vault)}`)).toBe(true)
    expect(code.has(`1 ${lc(SCRVUSD.implementation)}`)).toBe(true)
  })
  it('reads the vault state the module checks or gates on', () => {
    const calls = manifest.sources.filter((s) => s.type === 'evm-call' && s.chainId === 1 && lc(s.to!) === lc(SCRVUSD.vault))
    const bySig = Object.fromEntries(calls.map((s) => [s.signature, s.decode]))
    expect(bySig).toMatchObject({ 'isShutdown()': 'bool', 'apiVersion()': 'string', 'role_manager()': 'address', 'profitMaxUnlockTime()': 'uint256', 'totalDebt()': 'uint256', 'asset()': 'address' })
  })
  it('deployments.json pins the vault and crvUSD (curve-deployments)', () => {
    const j = manifest.sources.filter((s) => s.type === 'json-pins' && s.format === 'curve-deployments')
    expect(j).toHaveLength(1)
    expect(j[0]!.pins).toEqual({ from: 'dist/index.js', export: 'SCRVUSD_DEPLOYMENTS', group: '$key', roles: { vault: 'scrvUSD vault', asset: 'crvUSD' } })
    expect(Object.keys(SCRVUSD_DEPLOYMENTS)).toEqual(Object.keys(CURVE_LENDING_CHAINS).filter((id) => CURVE_LENDING_CHAINS[Number(id)]!.scrvUsd))
    expect(SCRVUSD_DEPLOYMENTS[1]).toBe(SCRVUSD)
  })
  it('ids are unique', () => {
    const ids = manifest.sources.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
