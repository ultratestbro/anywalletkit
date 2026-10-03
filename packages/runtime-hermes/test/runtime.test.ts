import { afterEach, describe, expect, it } from 'vitest'
import { installAbortSignalAny, installAbortSignalTimeout, installHermesRuntime, installSubtleDigest } from '../src/index.js'

const AS = AbortSignal as unknown as { timeout?: unknown; any?: unknown }
const origTimeout = AS.timeout
const origAny = AS.any
afterEach(() => { AS.timeout = origTimeout; AS.any = origAny })

describe('runtime-hermes', () => {
  it('reports native when present', () => {
    expect(installAbortSignalTimeout()).toBe('native')
    expect(installSubtleDigest()).toBe('native')
  })
  it('polyfills AbortSignal.timeout and fires TimeoutError', async () => {
    delete AS.timeout
    expect(installAbortSignalTimeout()).toBe('polyfilled')
    const s = AbortSignal.timeout(5)
    await new Promise((r) => setTimeout(r, 20))
    expect(s.aborted).toBe(true)
    expect((s.reason as Error).name).toBe('TimeoutError')
  })
  it('polyfills AbortSignal.any', () => {
    delete AS.any
    expect(installAbortSignalAny()).toBe('polyfilled')
    const c = new AbortController()
    const s = AbortSignal.any([c.signal, new AbortController().signal])
    c.abort('x')
    expect(s.aborted).toBe(true)
    expect(s.reason).toBe('x')
  })
  it('subtle.digest polyfill hashes like noble (SHA-256 of empty)', async () => {
    const fake = { subtle: {} } as unknown as Crypto
    const real = globalThis.crypto
    Object.defineProperty(globalThis, 'crypto', { value: fake, configurable: true })
    try {
      expect(installSubtleDigest()).toBe('polyfilled')
      const out = new Uint8Array(await fake.subtle.digest('SHA-256', new Uint8Array()))
      expect(Array.from(out.slice(0, 4))).toEqual([0xe3, 0xb0, 0xc4, 0x42])
    } finally { Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true }) }
  })
  it('installHermesRuntime returns a full report in Node', () => {
    const r = installHermesRuntime()
    expect(r.getRandomValues).toBe('native')
    expect(r.textEncoder).toBe('native')
  })
})
