import { describe, expect, it } from 'vitest'
import { NameError, type NameResolver } from '@forgewallet/core'

/**
 * What every NameResolver promises: a known name resolves to the expected
 * address for its chain, bad input is refused by code (no I/O for invalid
 * names), a name with no record for a chain is `no-address-for-chain` rather
 * than another chain's address, reverse lookups are forward-verified, and
 * `supports` is a pure shape check.
 */
export interface NamesSuiteFixture {
  /** A name that resolves on `chain` to `address` (case-insensitive compare). */
  known: { name: string; chain: string; address: string }
  /** A name the resolver serves but that is not registered. */
  unregistered: string
  /** Input that must be refused as `invalid-name`. */
  invalid: string
  /** A name that exists but has no record for this chain (optional). */
  noRecord?: { name: string; chain: string }
  /** A chain the resolver cannot serve at all (optional). */
  unsupportedChain?: string
  /** A name shape another resolver owns (`alice.sol` for ENS) — `supports` must be false. */
  foreign?: string
}

export function namesSuite(label: string, make: () => NameResolver, fx: NamesSuiteFixture): void {
  describe(`names conformance · ${label}`, () => {
    it('has an id and a pure supports()', () => {
      const r = make()
      expect(typeof r.id).toBe('string')
      expect(r.supports(fx.known.name)).toBe(true)
      expect(r.supports('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe(false)
      if (fx.foreign) expect(r.supports(fx.foreign)).toBe(false)
    })
    it('resolves the known name to its address for the chain', async () => {
      const out = await make().resolve(fx.known.name, fx.known.chain)
      expect(out.address.toLowerCase()).toBe(fx.known.address.toLowerCase())
      expect(out.chain).toBe(fx.known.chain)
      expect(Array.isArray(out.warnings)).toBe(true)
    })
    it('refuses invalid input and unknown names by code', async () => {
      const r = make()
      await expect(r.resolve(fx.invalid, fx.known.chain)).rejects.toSatisfy((e: unknown) => e instanceof NameError && e.code === 'invalid-name')
      await expect(r.resolve(fx.unregistered, fx.known.chain)).rejects.toSatisfy((e: unknown) => e instanceof NameError && e.code === 'not-found')
    })
    if (fx.noRecord) {
      const nr = fx.noRecord
      it('a name without a record for the chain is an error, never another chain\'s address', async () => {
        await expect(make().resolve(nr.name, nr.chain)).rejects.toSatisfy((e: unknown) => e instanceof NameError && e.code === 'no-address-for-chain')
      })
    }
    if (fx.unsupportedChain) {
      const ch = fx.unsupportedChain
      it('an unsupported chain is `unsupported`', async () => {
        await expect(make().resolve(fx.known.name, ch)).rejects.toSatisfy((e: unknown) => e instanceof NameError && e.code === 'unsupported')
      })
    }
    it('reverse is forward-verified (the known address maps to a name that resolves back, or null)', async () => {
      const r = make()
      const name = await r.reverse(fx.known.address, fx.known.chain)
      if (name !== null) {
        const back = await r.resolve(name, fx.known.chain)
        expect(back.address.toLowerCase()).toBe(fx.known.address.toLowerCase())
      }
    })
  })
}
