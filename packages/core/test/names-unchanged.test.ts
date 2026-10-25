import { describe, expect, it } from 'vitest'
import { assertNameUnchanged, type NameResolver } from '../src/index.js'

// Audit 2026-10-25 (post-release), L6: the signing-time check compared addresses case-insensitively
// on every chain, so a name re-pointed to a case variant of a base58 address (another key) passed.
const resolverTo = (address: string): NameResolver => ({
  id: 'fake', supports: () => true,
  resolve: async (name, chain) => ({ name, chain, address, resolver: 'fake', warnings: [] }),
  reverse: async () => null, avatar: async () => null,
})
const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const SOL_CASE = 'hAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'

describe('assertNameUnchanged', () => {
  it('compares EVM addresses without case (checksum casing is not identity)', async () => {
    const checksummed = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
    await expect(assertNameUnchanged(resolverTo(checksummed), 'a.eth', 'eip155:1', checksummed.toLowerCase())).resolves.toMatchObject({ address: checksummed })
    await expect(assertNameUnchanged(resolverTo(checksummed), 'a.eth', 'eip155:1', '0x2222222222222222222222222222222222222222')).rejects.toMatchObject({ code: 'changed' })
  })

  it('compares every other chain exactly: a case variant of a base58 address is another address', async () => {
    await expect(assertNameUnchanged(resolverTo(SOL), 'a.sol', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', SOL)).resolves.toMatchObject({ address: SOL })
    await expect(assertNameUnchanged(resolverTo(SOL_CASE), 'a.sol', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', SOL)).rejects.toMatchObject({ code: 'changed' })
    await expect(assertNameUnchanged(resolverTo('TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW'), 'a.trx', 'tron:0x2b6653dc', 'tjcnkspa7y5okkxvqaidzbzqx3qyq6sxmw')).rejects.toMatchObject({ code: 'changed' })
  })
})
