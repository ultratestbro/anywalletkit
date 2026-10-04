// After the TextEncoder polyfill: the real call an app makes at entry —
// AbortSignal.timeout/any, subtle.digest, Buffer.subarray (no Symbol.species in Hermes), …
import { installHermesRuntime } from '@forgewallet/runtime-hermes'
declare const print: ((s: string) => void) | undefined
const report = installHermesRuntime()
if (typeof print === 'function') print(`runtime-hermes: ${JSON.stringify(report)}`)
export {}
