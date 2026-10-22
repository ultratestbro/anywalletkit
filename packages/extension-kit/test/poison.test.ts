import { describe, expect, it } from 'vitest'
import { RecipientBook, lookalikeOf, memoryJsonStorage, type RecipientsState } from '../src/index.js'

const REAL = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const POISON = `${REAL.slice(0, 6)}${'a'.repeat(32)}${REAL.slice(-4)}` // same 4 + 4, different middle
const OTHER = '0x1111111111111111111111111111111111111111'

describe('address poisoning', () => {
  it('a recipient that shares the first and last four characters with a known one, but is not it, is a lookalike', () => {
    expect(lookalikeOf(POISON, [REAL])).toBe(REAL)
    expect(lookalikeOf(POISON.toUpperCase(), [REAL.toLowerCase()])).toBe(REAL.toLowerCase())
    expect(lookalikeOf(REAL, [REAL])).toBeNull() // the real one is not a lookalike of itself
    expect(lookalikeOf(OTHER, [REAL])).toBeNull()
    expect(lookalikeOf('TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', ['TXYZo1111111111111111111111111AeBf'])).toBe('TXYZo1111111111111111111111111AeBf')
    expect(lookalikeOf('short', ['shorty'])).toBeNull()
  })

  it('the book remembers confirmed recipients per chain (deduplicated, capped) and checks new ones against them', async () => {
    const book = new RecipientBook(memoryJsonStorage<RecipientsState>(), 3)
    await book.remember('eip155', REAL)
    await book.remember('eip155', REAL.toLowerCase())
    expect(await book.list('eip155')).toEqual([REAL.toLowerCase()])
    expect(await book.check('eip155', REAL)).toEqual({ known: true, lookalike: null })
    expect(await book.check('eip155', POISON)).toEqual({ known: false, lookalike: REAL.toLowerCase() })
    expect(await book.check('eip155', OTHER)).toEqual({ known: false, lookalike: null })
    expect(await book.check('solana', POISON)).toEqual({ known: false, lookalike: null }) // other namespace
    await book.remember('eip155', OTHER)
    await book.remember('eip155', '0x2222222222222222222222222222222222222222')
    await book.remember('eip155', '0x3333333333333333333333333333333333333333')
    expect((await book.list('eip155')).length).toBe(3)
    expect(await book.check('eip155', REAL)).toMatchObject({ known: false }) // evicted by the cap
  })
})
