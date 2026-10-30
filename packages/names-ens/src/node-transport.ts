/**
 * Loads the pinned Node transport (./ccip-node.js). Browser and React Native bundles get node-transport-stub.js in
 * its place (the `browser` / `react-native` fields of package.json), so they contain neither `import()` (Hermes
 * cannot parse it) nor `node:https` / `node:dns`.
 */
import type { PinnedCall } from './node-transport-stub.js'

export type { PinnedCall }

// From the CommonJS build the import of ccip-node.cjs gives its exports as `default`.
export const loadNodeTransport: (() => Promise<PinnedCall>) | null = () =>
  import('./ccip-node.js').then((m) => {
    const call = (m as { ccipGatewayCall?: unknown }).ccipGatewayCall ?? (m as { default?: { ccipGatewayCall?: unknown } }).default?.ccipGatewayCall
    if (typeof call !== 'function') throw new Error('ccip-node exports no ccipGatewayCall')
    return call as PinnedCall
  })
