import { describe, expect, it } from 'vitest'
import { approvalChallenge, derToRaw, rawToDer, toBase64Url, verifyAssertion, type AssertionInput } from '../src/index.js'

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const RP_ID = 'abcdefghijklmnopabcdefghijklmnop'
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))

/** A software authenticator: P-256 key, authenticatorData with the given flags, clientDataJSON, DER signature. */
async function authenticator() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey))
  const credentialId = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
  const assert = async (challenge: Uint8Array, o: { flags?: number; origin?: string; rpId?: string; type?: string; counter?: number } = {}): Promise<AssertionInput> => {
    const authData = new Uint8Array(37)
    authData.set(await sha256(new TextEncoder().encode(o.rpId ?? RP_ID)), 0)
    authData[32] = o.flags ?? 0x05
    const counter = o.counter ?? 7
    authData[33] = counter >>> 24; authData[34] = (counter >>> 16) & 0xff; authData[35] = (counter >>> 8) & 0xff; authData[36] = counter & 0xff
    const clientData = new TextEncoder().encode(JSON.stringify({ type: o.type ?? 'webauthn.get', challenge: toBase64Url(challenge), origin: o.origin ?? ORIGIN, crossOrigin: false }))
    const signed = new Uint8Array([...authData, ...(await sha256(clientData))])
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, signed as BufferSource))
    return { credentialId, authenticatorData: toBase64Url(authData), clientDataJSON: toBase64Url(clientData), signature: toBase64Url(rawToDer(raw)) }
  }
  return { publicKey: b64(spki), credentialId, assert }
}

describe('verifyAssertion (passkey on every signature)', () => {
  it('accepts a fresh assertion over this request\'s challenge from the registered key with UP+UV', async () => {
    const a = await authenticator()
    const request = { id: 'r1', kind: 'send-transaction', origin: 'https://dapp.example', payload: { to: '0x1', value: '1' } }
    const challenge = await approvalChallenge(request)
    const v = await verifyAssertion(await a.assert(challenge), { publicKey: a.publicKey, alg: -7, challenge, origin: ORIGIN, rpId: RP_ID })
    expect(v).toEqual({ ok: true, counter: 7 })
    // the challenge is bound to the request: a different payload, id or origin changes it
    expect(await approvalChallenge({ ...request, payload: { to: '0x2', value: '1' } })).not.toEqual(challenge)
    expect(await approvalChallenge({ ...request, id: 'r2' })).not.toEqual(challenge)
  })

  it('refuses: another challenge, another origin, another rpId, no UV, no UP, wrong type, another key, a mangled signature, a non-ES256 key', async () => {
    const a = await authenticator()
    const other = await authenticator()
    const challenge = await approvalChallenge({ id: 'r', kind: 'sign-message', origin: 'https://x', payload: 'm' })
    const reason = async (input: AssertionInput, over: Partial<Parameters<typeof verifyAssertion>[1]> = {}) => {
      const v = await verifyAssertion(input, { publicKey: a.publicKey, alg: -7, challenge, origin: ORIGIN, rpId: RP_ID, ...over })
      return v.ok ? 'ok' : v.reason
    }
    expect(await reason(await a.assert(crypto.getRandomValues(new Uint8Array(32))))).toMatch(/challenge/)
    expect(await reason(await a.assert(challenge, { origin: 'https://evil.example' }))).toMatch(/origin/)
    expect(await reason(await a.assert(challenge, { rpId: 'other-extension' }))).toMatch(/rpIdHash/)
    expect(await reason(await a.assert(challenge, { flags: 0x01 }))).toMatch(/user verification/)
    expect(await reason(await a.assert(challenge, { flags: 0x01 }), { requireUserVerification: false })).toBe('ok')
    expect(await reason(await a.assert(challenge, { flags: 0x04 }))).toMatch(/user presence/)
    expect(await reason(await a.assert(challenge, { type: 'webauthn.create' }))).toMatch(/type/)
    expect(await reason(await a.assert(challenge), { publicKey: other.publicKey })).toMatch(/does not verify/)
    const good = await a.assert(challenge)
    expect(await reason({ ...good, signature: toBase64Url(new Uint8Array([1, 2, 3])) })).toMatch(/DER/)
    expect(await reason(good, { alg: -257 })).toMatch(/unsupported algorithm/)
    expect(await reason({ ...good, authenticatorData: toBase64Url(new Uint8Array(10)) })).toMatch(/too short/)
    expect(await reason({ ...good, clientDataJSON: toBase64Url(new TextEncoder().encode('nope')) })).toMatch(/not JSON/)
  })

  it('DER ↔ raw round-trips, including high-bit and short components', () => {
    for (const _ of [1, 2, 3, 4, 5]) {
      const raw = crypto.getRandomValues(new Uint8Array(64))
      raw[0] = 0x80; raw[32] = 0x00; raw[33] = 0x00 // force a leading-zero pad on r and a short s
      expect(Array.from(derToRaw(rawToDer(raw))!)).toEqual(Array.from(raw))
    }
    expect(derToRaw(new Uint8Array([0x31, 0x00]))).toBeNull()
    expect(derToRaw(new Uint8Array([0x30, 0x02, 0x03, 0x00]))).toBeNull()
  })
})
