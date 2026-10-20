// What a React Native app provides to its JS and the bare Hermes CLI does not.
// Mirrors a RN entry file: `import 'react-native-get-random-values'`, Buffer,
// TextEncoder/Decoder. SMOKE-TEST ONLY — the random source here is Math.random.
import { Buffer } from 'buffer'

const g = globalThis as Record<string, unknown>
g.global ??= globalThis
g.self ??= globalThis
g.Buffer ??= Buffer // @ton/core, bitcoinjs-lib expect a global Buffer (RN apps install it at entry)
declare const print: ((s: string) => void) | undefined
if (typeof g.console === 'undefined' && typeof print === 'function') {
  const p = (...a: unknown[]) => print!(a.map(String).join(' '))
  g.console = { log: p, error: p, warn: p, info: p, debug: p }
}
// The TextEncoder polyfill installs TextEncoder+TextDecoder only when TextEncoder is absent;
// RN 0.81's Hermes has TextEncoder but no TextDecoder.
if (typeof g.TextDecoder === 'undefined' && typeof g.TextEncoder !== 'undefined') delete g.TextEncoder
// react-native-get-random-values stand-in (NOT secure; nothing in the smoke derives keys from it).
const c = (g.crypto ??= {}) as { getRandomValues?: (a: ArrayBufferView) => ArrayBufferView }
c.getRandomValues ??= (a) => { const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < u.length; i++) u[i] = Math.floor(Math.random() * 256); return a }
// React Native provides fetch; the bare VM does not. The smoke never reaches the network:
// every call fails with an ordinary Error (what an offline phone produces), never a ReferenceError.
g.fetch ??= async (input: unknown) => { throw new Error(`network disabled in the Hermes smoke (${typeof input === 'string' ? input : 'request'})`) }
// React Native provides AbortController; the bare VM does not. viem 2.57's withTimeout does
// `new AbortController()` outside its try block inside an un-awaited async IIFE, so without one every
// http-transport request hangs forever instead of failing (found with the USDT0 provider, 2026-10-20).
if (typeof g.AbortController === 'undefined') {
  type Listener = (ev: { type: 'abort' }) => void
  class AbortSignalShim {
    aborted = false
    reason: unknown = undefined
    onabort: Listener | null = null
    private listeners: Listener[] = []
    addEventListener(type: string, fn: Listener) { if (type === 'abort') this.listeners.push(fn) }
    removeEventListener(type: string, fn: Listener) { if (type === 'abort') this.listeners = this.listeners.filter((l) => l !== fn) }
    throwIfAborted() { if (this.aborted) throw this.reason }
    _abort(reason: unknown) {
      if (this.aborted) return
      this.aborted = true
      this.reason = reason ?? Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
      const ev = { type: 'abort' as const }
      this.onabort?.(ev)
      for (const l of this.listeners.slice()) l(ev)
    }
  }
  class AbortControllerShim {
    signal = new AbortSignalShim()
    abort(reason?: unknown) { this.signal._abort(reason) }
  }
  g.AbortController = AbortControllerShim
  g.AbortSignal = AbortSignalShim
}
export {}
