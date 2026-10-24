import { defineConfig } from 'tsup'
export default defineConfig({ entry: {"index": "./src/index.ts", "router": "./src/router.ts", "value": "./src/value.ts", "swap2/router": "./src/swap2/router.ts"}, format: ['esm', 'cjs'], dts: true, sourcemap: true, clean: true, target: 'es2022', platform: 'neutral', external: [/^@anywalletkit\//, /^@ton\//, /^@ston-fi\//, 'viem', 'buffer'] })
