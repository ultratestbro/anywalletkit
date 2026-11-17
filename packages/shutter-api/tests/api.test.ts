import { describe, expect, it } from 'vitest'
import {
  decodeRegistration, deriveIdentity, open, openText, readRegistration, registerCalldata, seal, ShutterApi, ShutterApiError, ShutterNotYetRevealedError,
  SHUTTER_CHIADO, SHUTTER_GNOSIS, type SealedMessage,
} from '../src/index.js'
import { keyper } from './keyper.js'

const k = keyper()

/** A Shutter API stand-in: answers like the live one (wrapped in { message }), with a one-key keyper set. */
function fakeApi(over: { lie?: 'identity' | 'key' | 'eon'; tooEarly?: boolean; status?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const u = new URL(url)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (over.status) return json({ description: 'too many requests', statusCode: over.status }, over.status)
    const answer = (prefix: string, registrant: string) => ({
      eon: 1,
      identity: over.lie === 'identity' ? '0x' + '99'.repeat(32) : deriveIdentity(prefix, registrant),
      identity_prefix: prefix,
      eon_key: over.lie === 'eon' ? keyper(5n).eonKey : k.eonKey,
    })
    if (u.pathname.endsWith('/time/register_identity')) {
      const body = JSON.parse(String(init.body)) as { identityPrefix: string }
      return json({ message: { ...answer(body.identityPrefix, SHUTTER_GNOSIS.apiRegistrant), tx_hash: '0x' + 'ab'.repeat(32) } })
    }
    if (u.pathname.endsWith('/time/get_data_for_encryption')) return json({ message: { ...answer(u.searchParams.get('identityPrefix')!, u.searchParams.get('address')!), epoch_id: '0x00' } })
    if (u.pathname.endsWith('/time/get_decryption_key')) {
      if (over.tooEarly) return json({ description: 'timestamp not reached yet, decryption key requested too early', statusCode: 400 }, 400)
      const identity = u.searchParams.get('identity')!
      return json({ message: { identity, decryption_key: over.lie === 'key' ? keyper(9n).keyFor(identity) : k.keyFor(identity), decryption_timestamp: 1 } })
    }
    return json({ description: 'not found' }, 404)
  }) as unknown as typeof fetch
  return { api: new ShutterApi({ fetch: fetchImpl, apiKey: () => 'k-123' }), calls }
}

const soon = () => Math.floor(Date.now() / 1000) + 60

describe('ShutterApi', () => {
  it('registers through the API: identity re-derived from the prefix and the API account, key sent as a bearer header', async () => {
    const { api, calls } = fakeApi()
    const r = await api.registerIdentity({ revealAt: soon() })
    expect(r.identity).toBe(deriveIdentity(r.identityPrefix, SHUTTER_GNOSIS.apiRegistrant))
    expect(r.registrant).toBe(SHUTTER_GNOSIS.apiRegistrant)
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k-123')
    expect(calls[0]!.init.redirect).toBe('error')
  })

  it('refuses an identity not derived from prefix ‖ registrant, and a key that fails the pairing check', async () => {
    await expect(fakeApi({ lie: 'identity' }).api.registerIdentity({ revealAt: soon() })).rejects.toThrow(/not derived from the prefix/)
    const { api } = fakeApi({ lie: 'key' })
    await expect(api.getDecryptionKey({ identity: '0x' + '01'.repeat(32), eonKey: k.eonKey })).rejects.toThrow(/pairing check failed/)
  })

  it('maps "too early" to ShutterNotYetRevealedError and 429 to a rate-limited ShutterApiError', async () => {
    await expect(fakeApi({ tooEarly: true }).api.getDecryptionKey({ identity: '0x' + '01'.repeat(32), eonKey: k.eonKey })).rejects.toBeInstanceOf(ShutterNotYetRevealedError)
    const err = await fakeApi({ status: 429 }).api.getEncryptionData({ identityPrefix: '0x' + '01'.repeat(32) }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ShutterApiError)
    expect((err as ShutterApiError).rateLimited).toBe(true)
  })

  it('refuses a past reveal time and a non-https API', async () => {
    await expect(fakeApi().api.registerIdentity({ revealAt: 1000 })).rejects.toThrow(/future/)
    expect(() => new ShutterApi({ network: { ...SHUTTER_GNOSIS, apiBaseUrl: 'http://evil.example/api' } })).toThrow(/https/)
  })
})

describe('seal / open', () => {
  it('seals through the API and opens after the reveal time; the ciphertext never goes to the API', async () => {
    const { api, calls } = fakeApi()
    const sealed = await seal({ api, message: 'gm, future me ✨', revealAt: soon() })
    expect(sealed).toMatchObject({ version: 1, network: 'gnosis', chainId: 100, registration: { by: 'api' } })
    await expect(open(sealed, api)).rejects.toBeInstanceOf(ShutterNotYetRevealedError)
    const later: SealedMessage = { ...sealed, revealAt: Math.floor(Date.now() / 1000) - 1 }
    // re-seal for a past time is impossible; open the same ciphertext as if its time had come
    expect(await openText(later, api)).toBe('gm, future me ✨')
    expect(calls.every((c) => !c.url.includes(sealed.ciphertext.slice(2, 40)) && !String(c.init.body ?? '').includes(sealed.ciphertext.slice(2, 40)))).toBe(true)
  })

  it('self-registers from the user account: register(eon, prefix, revealAt) to the registry, identity from the user address', async () => {
    const { api } = fakeApi()
    const me = '0x59bF7bc40eA7e1CD18F4790322679F80dE655562'
    const sent: unknown[] = []
    const revealAt = soon()
    const sealed = await seal({ api, message: '0x0102', revealAt, registrant: { address: me, sendTransaction: async (tx) => { sent.push(tx); return { hash: '0x' + 'cd'.repeat(32) } } } })
    expect(sealed.registrant).toBe(me)
    expect(sealed.identity).toBe(deriveIdentity(sealed.identityPrefix, me))
    expect(sent).toEqual([{ to: SHUTTER_GNOSIS.registry, data: registerCalldata({ eon: 1, identityPrefix: sealed.identityPrefix, revealAt }), value: 0n, chainId: 100 }])
    expect(sealed.registration).toEqual({ by: 'self', txHash: '0x' + 'cd'.repeat(32) })
  })

  it('a refused self-registration seals nothing; a sealed message for another chain is refused', async () => {
    const { api } = fakeApi()
    await expect(seal({ api, message: 'x', revealAt: soon(), registrant: { address: '0x59bF7bc40eA7e1CD18F4790322679F80dE655562', sendTransaction: async () => { throw new Error('User rejected') } } })).rejects.toThrow(/User rejected/)
    const sealed = await seal({ api, message: 'x', revealAt: soon() })
    await expect(open({ ...sealed, revealAt: 1 }, new ShutterApi({ network: SHUTTER_CHIADO, fetch: (() => { throw new Error('no') }) as never }))).rejects.toThrow(/chain 100/)
  })
})

describe('registry', () => {
  it('builds the calldata the API itself sent on Gnosis (tx 0x0365d5b0…d000)', () => {
    expect(registerCalldata({ eon: 1, identityPrefix: '0x2adba1397da555101237c5fff3ffe9cbb652b19b15edda827346145e4f9fee76', revealAt: 0x6afca87c }))
      .toBe('0xeaac357300000000000000000000000000000000000000000000000000000000000000012adba1397da555101237c5fff3ffe9cbb652b19b15edda827346145e4f9fee76000000000000000000000000000000000000000000000000000000006afca87c')
    // …and that registration's identity, as the API reported it
    expect(deriveIdentity('0x2adba1397da555101237c5fff3ffe9cbb652b19b15edda827346145e4f9fee76', SHUTTER_GNOSIS.apiRegistrant)).toBe('0x3f27e60a172f2d20232da5042600cafeecd38ce864b60142942547aa9920979c')
  })

  it('reads registrations(identity); refuses a zero prefix and bad answers', async () => {
    const { api } = fakeApi()
    const answer = '0x' + '1'.padStart(64, '0') + (0x6afca87c).toString(16).padStart(64, '0')
    expect(await readRegistration(async () => answer, api, '0x' + '01'.repeat(32))).toEqual({ eon: 1n, revealAt: 0x6afca87cn })
    expect(decodeRegistration('0x' + '0'.repeat(128))).toBeNull()
    expect(() => decodeRegistration('0x1234')).toThrow()
    expect(() => registerCalldata({ eon: 1, identityPrefix: '0x' + '00'.repeat(32), revealAt: 1 })).toThrow(/zero/)
  })
})
