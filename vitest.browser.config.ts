/**
 * Browser target. The same test files as the Node run, executed in Chromium.
 * runtime-hermes is Node/RN-only and excluded. Packages must be built first
 * (workspace imports resolve to dist via package exports).
 */
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    exclude: ['packages/runtime-hermes/**', '**/node_modules/**'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(process.env.PW_CHANNEL ? { launchOptions: { channel: process.env.PW_CHANNEL } } : {}),
      // Locally, PW_CHANNEL=chrome runs the installed Google Chrome instead of downloading Chromium.
      instances: [{ browser: 'chromium' }],
    },
  },
})
