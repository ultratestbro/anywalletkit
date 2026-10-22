/**
 * WebAuthn assertion verification for "passkey on every signature": the approval
 * page asks the authenticator to sign a challenge the service worker derived from
 * the request, and the worker checks the assertion against the public key the
 * vault stored at registration. The ceremony itself (`navigator.credentials`) runs
 * in an extension page; this module is pure WebCrypto so it is testable and the
 * worker never trusts the page's word that the user touched the authenticator.
 *
 * ES256 (COSE -7, P-256 + SHA-256) only — the only algorithm registration asks
 * for. The signature is DER (WebAuthn) and converted to the raw r‖s WebCrypto
 * wants.
 */
import { fromBase64, toArrayBuffer } from './codec.js'
import { fromBase64Url } from './vault.js'

export interface AssertionInput {
  /** `PublicKeyCredential.rawId`, base64url. */
  credentialId: string
  /** `AuthenticatorAssertionResponse.authenticatorData`, base64url. */
  authenticatorData: string
  /** `AuthenticatorAssertionResponse.clientDataJSON`, base64url. */
  clientDataJSON: string
  /** `AuthenticatorAssertionResponse.signature` (DER), base64url. */
  signature: string
}

export interface AssertionExpectations {
  /** SPKI public key of the credential, base64 (what `getPublicKey()` returned at registration). */
  publicKey: string
  /** COSE alg of the key; only -7 is accepted. */
  alg: number
  /** The challenge the worker handed the page (raw bytes; the page sent it base64url in clientDataJSON). */
  challenge: Uint8Array
  /** `chrome-extension://<id>` */
  origin: string
  /** The RP id the credential was created for (the extension id); its SHA-256 must be the first 32 bytes of authenticatorData. */
  rpId: string
  /** Require the UV flag (user verification: biometric / PIN) — on for signing. */
  requireUserVerification?: boolean
  crypto?: Crypto
}

export type AssertionVerdict = { ok: true; counter: number } | { ok: false; reason: string }

const FLAG_UP = 0x01
const FLAG_UV = 0x04

/** Verify one assertion. Never throws on bad input — a verdict with the reason, so the worker can refuse in-band. */
export async function verifyAssertion(input: AssertionInput, expect: AssertionExpectations): Promise<AssertionVerdict> {
  const c = expect.crypto ?? globalThis.crypto
  try {
    if (expect.alg !== -7) return { ok: false, reason: `unsupported algorithm ${expect.alg} (ES256 only)` }
    const authData = fromBase64Url(input.authenticatorData)
    const clientData = fromBase64Url(input.clientDataJSON)
    const signature = fromBase64Url(input.signature)
    if (authData.length < 37) return { ok: false, reason: 'authenticatorData too short' }
    // 1. client data: type, challenge, origin
    let client: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown }
    try { client = JSON.parse(new TextDecoder().decode(clientData)) as typeof client } catch { return { ok: false, reason: 'clientDataJSON is not JSON' } }
    if (client.type !== 'webauthn.get') return { ok: false, reason: `clientData.type is ${String(client.type)}` }
    if (client.origin !== expect.origin) return { ok: false, reason: `assertion origin ${String(client.origin)} is not ${expect.origin}` }
    if (client.crossOrigin === true) return { ok: false, reason: 'cross-origin assertion' }
    if (typeof client.challenge !== 'string' || !equal(fromBase64Url(client.challenge), expect.challenge)) return { ok: false, reason: 'challenge does not match this request' }
    // 2. authenticator data: rpIdHash, flags, counter
    const rpIdHash = new Uint8Array(await c.subtle.digest('SHA-256', toArrayBuffer(new TextEncoder().encode(expect.rpId))))
    if (!equal(authData.subarray(0, 32), rpIdHash)) return { ok: false, reason: 'rpIdHash does not match this extension' }
    const flags = authData[32]!
    if (!(flags & FLAG_UP)) return { ok: false, reason: 'user presence flag not set' }
    if (expect.requireUserVerification !== false && !(flags & FLAG_UV)) return { ok: false, reason: 'user verification flag not set' }
    const counter = ((authData[33]! << 24) | (authData[34]! << 16) | (authData[35]! << 8) | authData[36]!) >>> 0
    // 3. signature over authenticatorData ‖ SHA-256(clientDataJSON)
    const clientHash = new Uint8Array(await c.subtle.digest('SHA-256', toArrayBuffer(clientData)))
    const signed = new Uint8Array(authData.length + clientHash.length)
    signed.set(authData, 0)
    signed.set(clientHash, authData.length)
    const raw = derToRaw(signature)
    if (!raw) return { ok: false, reason: 'signature is not a DER ECDSA signature' }
    const key = await c.subtle.importKey('spki', toArrayBuffer(fromBase64(expect.publicKey)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const ok = await c.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, toArrayBuffer(raw), toArrayBuffer(signed))
    return ok ? { ok: true, counter } : { ok: false, reason: 'signature does not verify against the registered passkey' }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** DER `SEQUENCE { INTEGER r, INTEGER s }` → 64-byte r‖s; `null` when malformed. */
export function derToRaw(der: Uint8Array): Uint8Array | null {
  if (der[0] !== 0x30) return null
  let i = 2
  if (der[1]! & 0x80) i = 2 + (der[1]! & 0x7f)
  const int = (): Uint8Array | null => {
    if (der[i] !== 0x02) return null
    const len = der[i + 1]!
    const start = i + 2
    i = start + len
    let v = der.subarray(start, start + len)
    while (v.length > 32 && v[0] === 0) v = v.subarray(1)
    if (v.length > 32) return null
    const out = new Uint8Array(32)
    out.set(v, 32 - v.length)
    return out
  }
  const r = int()
  if (!r) return null
  const s = int()
  if (!s) return null
  const raw = new Uint8Array(64)
  raw.set(r, 0)
  raw.set(s, 32)
  return raw
}

/** Raw r‖s → DER (tests build assertions with WebCrypto, which signs raw). */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const enc = (v: Uint8Array): number[] => {
    let i = 0
    while (i < v.length - 1 && v[i] === 0) i++
    let body = Array.from(v.subarray(i))
    if (body[0]! & 0x80) body = [0, ...body]
    return [0x02, body.length, ...body]
  }
  const r = enc(raw.subarray(0, 32))
  const s = enc(raw.subarray(32, 64))
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s])
}

/**
 * The challenge for one approval request: SHA-256 over the request id, kind,
 * origin and payload, so an assertion made for one sheet cannot answer another.
 */
export async function approvalChallenge(request: { id: string; kind: string; origin: string; payload: unknown }, c: Crypto = globalThis.crypto): Promise<Uint8Array> {
  const text = JSON.stringify([request.id, request.kind, request.origin, request.payload])
  return new Uint8Array(await c.subtle.digest('SHA-256', toArrayBuffer(new TextEncoder().encode(text))))
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!
  return d === 0
}
