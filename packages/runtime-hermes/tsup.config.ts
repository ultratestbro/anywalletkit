import { defineConfig } from 'tsup'
export default defineConfig({ entry: { index: 'src/index.ts', 'fast-pbkdf2': 'src/fast-pbkdf2.ts' }, format: ['esm', 'cjs'], dts: true, sourcemap: true, clean: true, target: 'es2022', platform: 'neutral', external: ['@noble/hashes'] })
