import { defineConfig } from 'vitest/config'

// The vault's scrypt (N = 2^17) takes about a second per create / unlock.
export default defineConfig({ test: { testTimeout: 30_000 } })
