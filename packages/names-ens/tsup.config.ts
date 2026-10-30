import { defineConfig } from 'tsup'
import type { Plugin } from 'esbuild'

/**
 * ./node-transport.js and ./ccip-node.js stay separate files, imported at their built name: package.json's `browser`
 * and `react-native` fields swap node-transport for its stub, so browser and React Native bundles never reach the
 * Node-only transport (scan 2026-10-30 F17).
 */
const separateNodeTransport: Plugin = {
  name: 'separate-node-transport',
  setup(build) {
    const ext = build.initialOptions.format === 'cjs' ? '.cjs' : '.js'
    build.onResolve({ filter: /^\.\/(node-transport|ccip-node)\.js$/ }, (args) =>
      args.kind === 'entry-point' ? undefined : { path: args.path.replace(/\.js$/, ext), external: true })
  },
}

export default defineConfig({
  entry: { index: './src/index.ts', server: './src/server.ts', 'ccip-node': './src/ccip-node.ts', 'node-transport': './src/node-transport.ts', 'node-transport-stub': './src/node-transport-stub.ts' },
  format: ['esm', 'cjs'], dts: true, sourcemap: true, clean: true, target: 'es2022', platform: 'neutral',
  external: [/^@anywalletkit\//, /^node:/, 'viem', '@noble/hashes', '@scure/base'],
  esbuildPlugins: [separateNodeTransport],
})
