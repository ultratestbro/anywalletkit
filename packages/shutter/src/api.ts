/**
 * A client for the Shutter API's time-based endpoints. It never trusts what it is told without a check it can make:
 * every identity is re-derived from the prefix and the registrant, every eon key must be a valid G2 point, and every
 * decryption key must pass the pairing check against the eon key it was encrypted under. `/decrypt_commitment` is not
 * offered: decryption happens on the device, the ciphertext never leaves it.
 */
import { deriveIdentity } from './registry.js'
import { bytesOf, randomHex32, toHex, type BytesLike } from './bytes.js'
import { verifyDecryptionKey } from './crypto.js'
import { ShutterApiError, ShutterNotYetRevealedError } from './errors.js'
import { SHUTTER_GNOSIS, type ShutterNetwork } from './networks.js'

export interface ShutterApiOptions {
  /** Default Gnosis mainnet. */
  readonly network?: ShutterNetwork | undefined
  /**
   * An API key (`Authorization: Bearer …`) lifts the per-IP limits (mainnet without a key: 5 registrations, 10
   * encryption-data and 20 decryption-key requests per 24 h). A getter is read on every request. In a mobile app,
   * prefer calling through your backend rather than shipping a key in the bundle.
   */
  readonly apiKey?: string | (() => string | undefined) | undefined
  readonly fetch?: typeof fetch | undefined
  /** Per-request timeout, ms. Default 15 000. */
  readonly timeoutMs?: number | undefined
}

/** What the API returns for an identity: enough to encrypt for it. */
export interface EncryptionData {
  readonly eon: number
  readonly identity: `0x${string}`
  readonly identityPrefix: `0x${string}`
  readonly eonKey: `0x${string}`
  /** The account the identity is derived from (the API's own account, or yours when you self-register). */
  readonly registrant: string
}

export interface ApiRegistration extends EncryptionData {
  readonly revealAt: number
  /** The API's registration transaction on the network's chain. */
  readonly txHash: `0x${string}`
}

export interface DecryptionKey {
  readonly identity: `0x${string}`
  readonly decryptionKey: `0x${string}`
  readonly revealAt: number
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/
const HEX_G2 = /^0x[0-9a-fA-F]{192}$/
const HEX_G1 = /^0x[0-9a-fA-F]{96}$/

function field(o: Record<string, unknown>, key: string, re: RegExp): `0x${string}` {
  const v = o[key]
  if (typeof v !== 'string' || !re.test(v)) throw new ShutterApiError(`the API answered without a valid ${key}`)
  return v.toLowerCase() as `0x${string}`
}

function uint(o: Record<string, unknown>, key: string): number {
  const v = o[key]
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new ShutterApiError(`the API answered without a valid ${key}`)
  return v
}

/** The API's error text → a typed error. */
function apiError(status: number, description: string): Error {
  const d = description.toLowerCase()
  if (d.includes('too early') || d.includes('not reached')) return new ShutterNotYetRevealedError(`Shutter: ${description}`)
  // Right at the reveal time the keypers have not published yet: 404 "decryption key doesnt exist" for a few seconds.
  if (status === 404 && /key does ?n[o']?t exist/.test(d)) return new ShutterNotYetRevealedError(`Shutter: the keypers have not released the key yet (${description})`)
  if (status === 429) return new ShutterApiError(`Shutter API rate limit reached: ${description || 'too many requests'}`, { status })
  return new ShutterApiError(`Shutter API: ${description || `HTTP ${status}`}`, { status })
}

export class ShutterApi {
  readonly network: ShutterNetwork
  private readonly options: ShutterApiOptions

  constructor(options: ShutterApiOptions = {}) {
    this.network = options.network ?? SHUTTER_GNOSIS
    this.options = options
    if (!/^https:\/\//.test(this.network.apiBaseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(this.network.apiBaseUrl)) {
      throw new ShutterApiError('the Shutter API base URL must be https')
    }
  }

  private async request(path: string, init: { method: 'GET' | 'POST'; query?: Record<string, string>; body?: unknown } ): Promise<Record<string, unknown>> {
    const url = new URL(`${this.network.apiBaseUrl.replace(/\/$/, '')}${path}`)
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v)
    const key = typeof this.options.apiKey === 'function' ? this.options.apiKey() : this.options.apiKey
    const headers: Record<string, string> = { accept: 'application/json' }
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    if (key) headers.authorization = `Bearer ${key}`
    // AbortSignal.timeout is missing on Hermes: a plain controller + timer, always cleared.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000)
    let res: Response
    try {
      res = await (this.options.fetch ?? fetch)(url.toString(), {
        method: init.method, headers, signal: controller.signal, redirect: 'error',
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      })
    } catch (error) {
      throw new ShutterApiError(`Shutter API unreachable (${error instanceof Error ? error.message : String(error)})`, { cause: error })
    } finally {
      clearTimeout(timer)
    }
    let json: unknown
    try {
      json = JSON.parse(await res.text())
    } catch {
      throw new ShutterApiError(`Shutter API answered HTTP ${res.status} without JSON`, { status: res.status })
    }
    const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
    if (!res.ok) throw apiError(res.status, typeof o.description === 'string' ? o.description : '')
    // Answers come wrapped as { message: {...} } (the README shows them bare): accept both.
    const body = o.message && typeof o.message === 'object' ? (o.message as Record<string, unknown>) : o
    return body
  }

  /** The identity, eon and eon key, checked: the identity must be keccak256(prefix ‖ registrant). */
  private encryptionData(o: Record<string, unknown>, registrant: string, expectedPrefix?: string): EncryptionData {
    const identityPrefix = field(o, 'identity_prefix', HEX32)
    if (expectedPrefix && identityPrefix !== expectedPrefix.toLowerCase()) throw new ShutterApiError('the API answered for another identity prefix')
    const identity = field(o, 'identity', HEX32)
    if (deriveIdentity(identityPrefix, registrant) !== identity) throw new ShutterApiError('the API answered with an identity that is not derived from the prefix and the registrant')
    const eonKey = field(o, 'eon_key', HEX_G2)
    return { eon: uint(o, 'eon'), identity, identityPrefix, eonKey, registrant }
  }

  /**
   * Register an identity through the API (the API's account pays and owns the registration; nothing secret is sent —
   * only a random prefix and the reveal time). `revealAt` is a Unix time in seconds, in the future.
   */
  async registerIdentity(input: { revealAt: number; identityPrefix?: BytesLike | undefined }): Promise<ApiRegistration> {
    if (!Number.isSafeInteger(input.revealAt) || input.revealAt <= Math.floor(Date.now() / 1000)) throw new ShutterApiError('revealAt must be a Unix time in seconds, in the future')
    const identityPrefix = input.identityPrefix === undefined ? randomHex32() : toHex(bytesOf(input.identityPrefix, 'identity prefix'))
    const o = await this.request('/time/register_identity', { method: 'POST', body: { decryptionTimestamp: input.revealAt, identityPrefix } })
    const data = this.encryptionData(o, this.network.apiRegistrant, identityPrefix)
    return { ...data, revealAt: input.revealAt, txHash: field(o, 'tx_hash', HEX32) }
  }

  /**
   * Encryption data for an identity registered (or to be registered) by `registrant`: the API's account by default,
   * or your own address when you self-register through the registry.
   */
  async getEncryptionData(input: { identityPrefix: BytesLike; registrant?: string | undefined }): Promise<EncryptionData> {
    const registrant = input.registrant ?? this.network.apiRegistrant
    const identityPrefix = toHex(bytesOf(input.identityPrefix, 'identity prefix'))
    const o = await this.request('/time/get_data_for_encryption', { method: 'GET', query: { address: registrant, identityPrefix } })
    return this.encryptionData(o, registrant, identityPrefix)
  }

  /**
   * The decryption key for an identity, once its time has come — verified against `eonKey` by pairing before it is
   * returned. Throws {@link ShutterNotYetRevealedError} before the reveal time.
   */
  async getDecryptionKey(input: { identity: BytesLike; eonKey: BytesLike }): Promise<DecryptionKey> {
    const identity = toHex(bytesOf(input.identity, 'identity'))
    const o = await this.request('/time/get_decryption_key', { method: 'GET', query: { identity } })
    if (field(o, 'identity', HEX32) !== identity.toLowerCase()) throw new ShutterApiError('the API answered with the key of another identity')
    const decryptionKey = field(o, 'decryption_key', HEX_G1)
    let valid = false
    try {
      valid = verifyDecryptionKey(decryptionKey, identity, input.eonKey)
    } catch (error) {
      throw new ShutterApiError('the API answered with a decryption key that is not a valid point', { cause: error })
    }
    if (!valid) throw new ShutterApiError('the API answered with a decryption key that does not match the eon key (pairing check failed)')
    return { identity, decryptionKey, revealAt: uint(o, 'decryption_timestamp') }
  }
}
