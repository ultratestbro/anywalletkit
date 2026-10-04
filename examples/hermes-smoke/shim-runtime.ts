// After the TextEncoder polyfill: the real call an app makes at entry —
// AbortSignal.timeout/any, subtle.digest, Buffer.subarray (no Symbol.species in Hermes), …
// Exactly what `react-native-url-polyfill/auto` installs in an app: it wraps this package. The
// auto entry also imports react-native (for Platform), which the bare VM has no use for.
// @ts-expect-error no types shipped
import { URL, URLSearchParams } from 'whatwg-url-without-unicode'
import { installHermesRuntime } from '@forgewallet/runtime-hermes'
declare const print: ((s: string) => void) | undefined
const g = globalThis as { URL?: unknown; URLSearchParams?: unknown }
const probe = (): boolean => { try { return new (g.URL as new (u: string) => { searchParams?: { get(k: string): string | null } })('https://e.com/?x=1').searchParams?.get('x') === '1' } catch { return false } }
if (!probe()) { g.URL = URL; g.URLSearchParams = URLSearchParams }
const report = installHermesRuntime()
if (typeof print === 'function') print(`runtime-hermes: ${JSON.stringify(report)}`)
export {}
