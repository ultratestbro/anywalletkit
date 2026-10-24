import { defineConfig } from 'tsup'
export default defineConfig({ entry: { index: 'src/index.ts', history: 'src/history.ts' }, format: ['esm', 'cjs'], dts: true, sourcemap: true, clean: true, target: 'es2022', platform: 'neutral', external: [/^@noble\//, /^@scure\//, '@anywalletkit/core'] })
