// @ton/core and @ton/crypto read the GLOBAL `Buffer` (Node convention). Browsers
// and Hermes have none, so the package installs the `buffer` polyfill once, at
// import time, only when it is missing. Node and React Native entries that
// already set it are untouched. Called as a function from index.ts (not a bare
// import): bundlers drop bare imports of modules they consider side-effect
// free, and this one was silently dropped from dist before.
import { Buffer } from 'buffer'

export function installBufferGlobal(): void {
  const g = globalThis as { Buffer?: unknown }
  g.Buffer ??= Buffer
}

installBufferGlobal()
