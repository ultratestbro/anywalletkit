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
export {}
