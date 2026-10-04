// @ton/core and @ton/crypto read the GLOBAL `Buffer` (Node convention). Browsers
// and Hermes have none, so the package installs the `buffer` polyfill once, at
// import time, only when it is missing. Node and React Native entries that
// already set it are untouched. This is the one side effect in the SDK's
// chain packages and the reason wallet-ton is not marked sideEffects: false.
import { Buffer } from 'buffer'
const g = globalThis as { Buffer?: unknown }
g.Buffer ??= Buffer
export {}
