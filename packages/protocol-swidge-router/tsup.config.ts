import { defineConfig } from 'tsup'
export default defineConfig({ entry: {"index": "./src/index.ts", "router": "./src/router.ts", "swidge/router": "./src/swidge/router.ts"}, format: ['esm', 'cjs'], dts: true, sourcemap: true, clean: true, target: 'es2022', platform: 'neutral', external: [/^@forgewallet\//, /^@ton\//, /^@ston-fi\//, 'viem', 'buffer'] })
