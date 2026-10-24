import { describe, expect, it } from 'vitest'
import { NameError, type NameResolver, type ResolvedName } from '@anywalletkit/core'
import { beforeSigning, names, profile, readRecipient, reviewLines } from '../src/names.ts'

const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

/** A resolver stand-in: one name, an address that can change, a Base record missing. */
function stub(state: { address: string }): NameResolver {
  return {
    id: 'stub',
    supports: (n) => n.endsWith('.eth'),
    resolve: async (name, chain) => {
      if (name === 'nobody.eth') throw new NameError('not-found', 'not found')
      if (chain === 'eip155:8453') throw new NameError('no-address-for-chain', 'no base record')
      return { name, chain, address: state.address, resolver: 'stub', warnings: [] }
    },
    reverse: async (address) => (address === state.address ? 'alice.eth' : null),
    avatar: async () => 'https://example.org/alice.png',
  }
}

describe('Names guide (docs) — offline', () => {
  it('an address passes through; a name resolves for the chain asked; errors become messages', async () => {
    const s = stub({ address: VITALIK })
    expect(await readRecipient(s, ` ${VITALIK} `, 'eip155:1')).toEqual({ kind: 'address', address: VITALIK })
    expect(await readRecipient(s, 'alice.eth', 'eip155:1')).toMatchObject({ kind: 'name', resolved: { address: VITALIK } })
    expect(await readRecipient(s, 'alice.eth', 'eip155:8453')).toEqual({ kind: 'error', message: 'This name has no address for this network.' })
    expect(await readRecipient(s, 'nobody.eth', 'eip155:1')).toEqual({ kind: 'error', message: 'No one owns this name.' })
  })

  it('invalid and lookalike names are refused before any network call, never treated as addresses', async () => {
    const ens = names()
    for (const bad of ['vit\u0430lik.eth', 'ex@mple.eth']) {
      expect(await readRecipient(ens, bad, 'eip155:1')).toEqual({ kind: 'error', message: 'This name is not valid, or names like it are not supported yet.' })
    }
    expect(await readRecipient(ens, 'alice.near', 'near:mainnet')).toEqual({ kind: 'address', address: 'alice.near' })
  })

  it('signing refuses when the name moved since the review screen', async () => {
    const state = { address: VITALIK }
    const s = stub(state)
    const r = await readRecipient(s, 'alice.eth', 'eip155:1')
    const resolved = (r as { resolved: ResolvedName }).resolved
    expect(reviewLines(resolved)).toEqual([`alice.eth → ${VITALIK}`])
    await expect(beforeSigning(s, resolved)).resolves.toBeUndefined()
    state.address = '0x000000000000000000000000000000000000dEaD'
    await expect(beforeSigning(s, resolved)).rejects.toMatchObject({ code: 'changed' })
  })

  it('profile: primary name only when it resolves back, plus the avatar URL', async () => {
    const s = stub({ address: VITALIK })
    expect(await profile(s, VITALIK, 'eip155:1')).toEqual({ name: 'alice.eth', avatar: 'https://example.org/alice.png' })
    expect(await profile(s, '0x0000000000000000000000000000000000000001', 'eip155:1')).toEqual({ name: null, avatar: null })
  })
})

// Ethereum mainnet reads: LIVE=1 pnpm --filter @anywalletkit/example-names test
describe.runIf(process.env.LIVE === '1')('Names guide (docs) — live', () => {
  it('vitalik.eth on Ethereum, a Basename through CCIP-Read on Base, the primary name back', async () => {
    const ens = names()
    const main = await readRecipient(ens, 'vitalik.eth', 'eip155:1')
    console.log(main)
    expect(main).toMatchObject({ kind: 'name', resolved: { address: VITALIK } })
    const base = await readRecipient(ens, 'jesse.base.eth', 'eip155:8453')
    console.log(base)
    expect(base.kind).toBe('name')
    expect((await profile(ens, VITALIK, 'eip155:1')).name).toBe('vitalik.eth')
  }, 60_000)
})
