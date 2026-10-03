// The bare Hermes CLI has globalThis but no `global` / `self` / `console`, and
// (in RN 0.81's build) a native TextEncoder WITHOUT a TextDecoder. RN provides
// all of these to apps; here we provide them to the smoke bundle.
const g = globalThis as Record<string, unknown>
g.global ??= globalThis
g.self ??= globalThis
declare const print: ((s: string) => void) | undefined
if (typeof g.console === 'undefined' && typeof print === 'function') {
  const p = (...a: unknown[]) => print!(a.map(String).join(' '))
  g.console = { log: p, error: p, warn: p, info: p, debug: p }
}
// The polyfill installs TextEncoder+TextDecoder only when TextEncoder is absent.
if (typeof g.TextDecoder === 'undefined' && typeof g.TextEncoder !== 'undefined') delete g.TextEncoder
export {}
