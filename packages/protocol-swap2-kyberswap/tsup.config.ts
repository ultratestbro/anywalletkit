import { defineConfig } from 'tsup'
export default defineConfig({ entry: {"index": "./src/index.ts", "provider": "./src/provider.ts", "router": "./src/router.ts", "activity": "./src/activity.ts", "protocol": "./src/protocol.ts"}, format: ['esm', 'cjs'], dts: true, sourcemap: true, clean: true, target: 'es2022', platform: 'neutral', external: [/^@anywalletkit\//, 'viem'] })
