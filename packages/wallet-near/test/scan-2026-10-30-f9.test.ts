import { describe, expect, it } from 'vitest'
import { assertWellFormed, decodeTransaction, describeTransaction, encodeTransaction, parsePublicKey, type NearBuiltTransaction } from '../src/index.js'

// scan 2026-10-30 F9: an AddKey permission that is neither functionCall nor fullAccess used to be encoded as
// FullAccess while the description gave no full-access warning. Now it is refused before encoding or signing.
const PK = parsePublicKey('ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25')
const tx = (permission: unknown, nested = false): NearBuiltTransaction => {
  const addKey = { addKey: { publicKey: PK, accessKey: { nonce: 0n, permission } } } as never
  const actions = nested
    ? [{ signedDelegate: { delegateAction: { senderId: 'victim.near', receiverId: 'victim.near', actions: [addKey], nonce: 1n, maxBlockHeight: 100n, publicKey: PK }, signature: { keyType: 0, data: new Uint8Array(64) } } } as never]
    : [addKey]
  return { signerId: 'victim.near', publicKey: PK, nonce: 1n, receiverId: 'victim.near', blockHash: new Uint8Array(32).fill(7), actions }
}

const BAD: Array<[string, unknown]> = [
  ['empty', {}],
  ['misspelled', { fullaccess: {} }],
  ['unknown variant', { gasKey: {} }],
  ['both variants', { fullAccess: {}, functionCall: { receiverId: 'app.near', methodNames: [] } }],
  ['fullAccess not an object', { fullAccess: true }],
  ['functionCall without methodNames', { functionCall: { receiverId: 'app.near' } }],
  ['functionCall number allowance', { functionCall: { receiverId: 'app.near', methodNames: [], allowance: 5 } }],
  ['functionCall extra field', { functionCall: { receiverId: 'app.near', methodNames: [], fullAccess: {} } }],
  ['not an object', 'fullAccess'],
]

describe('scan 2026-10-30 F9: NEAR access-key permission is exactly one known variant', () => {
  for (const [name, perm] of BAD) {
    it(`${name}: refused by assertWellFormed, the encoder and (inside a delegate) the nested check`, () => {
      expect(() => assertWellFormed(tx(perm))).toThrow(/permission|fullAccess|functionCall/)
      expect(() => encodeTransaction(tx(perm))).toThrow()
      expect(() => assertWellFormed(tx(perm, true))).toThrow()
    })
    it(`${name}: described as malformed, never as a function-call key`, () => {
      const msgs = describeTransaction(tx(perm)).warnings.map((w) => w.message).join('\n')
      expect(msgs).toMatch(/Malformed access-key permission|FULL ACCESS/)
    })
  }

  it('controls: genuine fullAccess / functionCall encode, round-trip, and fullAccess warns', () => {
    const full = tx({ fullAccess: {} })
    expect(() => assertWellFormed(full)).not.toThrow()
    expect((decodeTransaction(encodeTransaction(full)).actions[0] as any).addKey.accessKey.permission).toEqual({ fullAccess: {} })
    expect(describeTransaction(full).warnings.map((w) => w.code)).toContain('full-access-key')

    for (const fc of [{ receiverId: 'app.near', methodNames: ['ping'] }, { receiverId: 'app.near', methodNames: [], allowance: 10n ** 24n }, { receiverId: 'app.near', methodNames: [], allowance: undefined }]) {
      const t = tx({ functionCall: fc })
      expect(() => assertWellFormed(t)).not.toThrow()
      expect(() => assertWellFormed(tx({ functionCall: fc }, true))).not.toThrow()
      const back = (decodeTransaction(encodeTransaction(t)).actions[0] as any).addKey.accessKey.permission
      expect(back.functionCall.receiverId).toBe('app.near')
      expect(back.functionCall.allowance).toBe(fc.allowance)
      expect(describeTransaction(t).warnings.map((w) => w.code)).not.toContain('full-access-key')
    }
  })
})
