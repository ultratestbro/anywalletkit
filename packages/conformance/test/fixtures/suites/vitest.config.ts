import { defineConfig } from 'vitest/config'
// Run only by suites-catch.test.ts, one file at a time: each file is a module the suite must accept or reject.
export default defineConfig({ test: { include: ['*.suite.ts'] } })
