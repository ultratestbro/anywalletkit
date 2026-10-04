// @ton/core reads the GLOBAL Buffer (Node convention). Browsers have none, so the
// module installs the `buffer` polyfill once, at import time, only when missing.
import { Buffer } from 'buffer'
globalThis.Buffer ??= Buffer
