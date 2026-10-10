/**
 * Hermes (React Native) lacks a few web platform pieces the SDK's dependencies
 * expect. Everything the SDK needs is installed by ONE call, at app entry,
 * before any chain package is imported:
 *
 *   import 'react-native-get-random-values'            // app's job: secure randomness
 *   import { installHermesRuntime } from '@forgewallet/runtime-hermes'
 *   installHermesRuntime()
 *
 * Nothing here is imported by the SDK packages themselves — they stay
 * polyfill-free and this package stays optional for Node and browsers.
 */
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js'

export interface HermesRuntimeReport {
  bufferSubarray: 'native' | 'patched' | 'no-buffer'
  abortSignalTimeout: 'native' | 'polyfilled'
  abortSignalAny: 'native' | 'polyfilled'
  subtleDigest: 'native' | 'polyfilled' | 'unavailable'
  textEncoder: 'native' | 'missing'
  getRandomValues: 'native' | 'missing'
  /** WHATWG URL: RN ships a partial one (no working searchParams); providers parse endpoints with it. */
  url: 'native' | 'partial' | 'missing'
  structuredClone: 'native' | 'polyfilled'
}

type AnyAbortSignal = typeof AbortSignal & { timeout?: (ms: number) => AbortSignal; any?: (signals: AbortSignal[]) => AbortSignal }

/** `AbortSignal.timeout(ms)` — missing on Hermes; its absence silently broke every swap2 execution once. */
export function installAbortSignalTimeout(): 'native' | 'polyfilled' {
  const AS = globalThis.AbortSignal as AnyAbortSignal | undefined
  if (!AS) return 'polyfilled' // no AbortController at all: nothing sensible to patch
  if (typeof AS.timeout === 'function') return 'native'
  AS.timeout = (ms: number) => {
    const c = new AbortController()
    setTimeout(() => c.abort(new DOMExceptionLike('The operation timed out.', 'TimeoutError')), ms)
    return c.signal
  }
  return 'polyfilled'
}

/** `AbortSignal.any(signals)`. */
export function installAbortSignalAny(): 'native' | 'polyfilled' {
  const AS = globalThis.AbortSignal as AnyAbortSignal | undefined
  if (!AS) return 'polyfilled'
  if (typeof AS.any === 'function') return 'native'
  AS.any = (signals: AbortSignal[]) => {
    const c = new AbortController()
    for (const s of signals) {
      if (s.aborted) { c.abort(s.reason); break }
      s.addEventListener('abort', () => c.abort(s.reason), { once: true })
    }
    return c.signal
  }
  return 'polyfilled'
}

/** `crypto.subtle.digest` for SHA-256/384/512 via noble — Solana's ed25519 polyfill creates `subtle` without it. */
export function installSubtleDigest(): 'native' | 'polyfilled' | 'unavailable' {
  const c = globalThis.crypto as (Crypto & { subtle?: SubtleCrypto & { digest?: unknown } }) | undefined
  if (!c) return 'unavailable'
  c.subtle ??= {} as SubtleCrypto
  if (typeof c.subtle.digest === 'function') return 'native'
  const HASHES: Record<string, (d: Uint8Array) => Uint8Array> = { 'SHA-256': sha256, 'SHA-384': sha384, 'SHA-512': sha512 }
  ;(c.subtle as { digest: unknown }).digest = async (algorithm: string | { name: string }, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer> => {
    const name = (typeof algorithm === 'string' ? algorithm : algorithm.name).toUpperCase()
    const hash = HASHES[name]
    if (!hash) throw new Error(`subtle.digest polyfill: unsupported algorithm ${name}`)
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data)
    return hash(bytes).slice().buffer as ArrayBuffer
  }
  return 'polyfilled'
}

/**
 * Hermes has no Symbol.species, so `Buffer.prototype.subarray` (and any other
 * TypedArray method that returns a view) yields a plain Uint8Array — the next
 * `.copy()` / `.readUInt32BE()` on it throws "undefined is not a function".
 * @ton/core, bitcoinjs-lib and many Node-style libraries slice Buffers this way.
 * Patches the global Buffer (the app installs one from the `buffer` package).
 */
export function installBufferSubarrayFix(): 'native' | 'patched' | 'no-buffer' {
  const B = (globalThis as { Buffer?: { alloc(n: number): Uint8Array; prototype: Uint8Array } }).Buffer
  if (!B) return 'no-buffer'
  const probe = B.alloc(2).subarray(0, 1)
  if (probe instanceof (B as unknown as new () => object)) return 'native'
  const proto = B.prototype as Uint8Array & { subarray: Uint8Array['subarray'] }
  const original = Uint8Array.prototype.subarray
  Object.defineProperty(proto, 'subarray', {
    configurable: true, writable: true,
    value: function subarray(this: Uint8Array, start?: number, end?: number) {
      const out = original.call(this, start, end)
      Object.setPrototypeOf(out, proto)
      return out
    },
  })
  return 'patched'
}

/** URL/URLSearchParams probe. 'partial' = RN's built-in stub (no searchParams); fix with react-native-url-polyfill/auto. */
export function probeUrl(): 'native' | 'partial' | 'missing' {
  const g = globalThis as { URL?: new (u: string) => { protocol: string; searchParams?: { get(k: string): string | null } } }
  if (typeof g.URL !== 'function') return 'missing'
  try {
    const u = new g.URL('https://example.com/p?x=1')
    return u.protocol === 'https:' && u.searchParams?.get('x') === '1' ? 'native' : 'partial'
  } catch { return 'partial' }
}

export function installStructuredClone(): 'native' | 'polyfilled' {
  const g = globalThis as { structuredClone?: unknown }
  if (typeof g.structuredClone === 'function') return 'native'
  g.structuredClone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x)), (_k, x) => (typeof x === 'string' && /^\d+n$/.test(x) ? BigInt(x.slice(0, -1)) : x)) as T))
  return 'polyfilled'
}

/**
 * Install everything and report. Throws for the two things only the APP can
 * provide (secure randomness, TextEncoder) — a wallet must not run without them.
 */
export function installHermesRuntime(options: { throwOnMissing?: boolean } = {}): HermesRuntimeReport {
  const report: HermesRuntimeReport = {
    bufferSubarray: installBufferSubarrayFix(),
    abortSignalTimeout: installAbortSignalTimeout(),
    abortSignalAny: installAbortSignalAny(),
    subtleDigest: installSubtleDigest(),
    structuredClone: installStructuredClone(),
    textEncoder: typeof globalThis.TextEncoder === 'function' && typeof globalThis.TextDecoder === 'function' ? 'native' : 'missing',
    getRandomValues: typeof globalThis.crypto?.getRandomValues === 'function' ? 'native' : 'missing',
    url: probeUrl(),
  }
  if (options.throwOnMissing !== false) {
    if (report.getRandomValues === 'missing') throw new Error("crypto.getRandomValues is missing. Add `import 'react-native-get-random-values'` as the FIRST import of your app entry.")
    if (report.textEncoder === 'missing') throw new Error("TextEncoder/TextDecoder are missing. Add `import 'fastestsmallesttextencoderdecoder/EncoderDecoderTogether.min.js'` to your app entry.")
    if (report.url !== 'native') throw new Error(`URL is ${report.url}. Add \`import 'react-native-url-polyfill/auto'\` to your app entry — swap and staking providers parse endpoint URLs and query strings with it.`)
  }
  return report
}

class DOMExceptionLike extends Error {
  constructor(message: string, name: string) { super(message); this.name = name }
}
