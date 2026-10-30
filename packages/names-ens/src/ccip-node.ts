/**
 * The Node transport of `ensCcipRequest` when the app passes no `ccip.fetch` (scan 2026-10-30 F17): each gateway is
 * asked through `createEnsCcipHandler`, in process — every DNS answer checked, the connection pinned to the checked
 * address, no redirects, the answer capped and timed. The URL check alone cannot see where a public-looking host
 * resolves (split-horizon DNS, a name pointed at 127.0.0.1).
 *
 * Loaded by `ensCcipRequest` with a dynamic import whose specifier bundlers do not follow, so browser and React
 * Native bundles never include it (it needs `node:https` and `node:dns`). Not part of the public API.
 */
import type { EnsCcipProxyRequest } from './ccip-proxy.js'
import { createEnsCcipHandler, type EnsCcipResponse } from './server.js'

export function ccipGatewayCall(call: EnsCcipProxyRequest, opts: { timeoutMs: number; maxResponseBytes: number }): Promise<EnsCcipResponse> {
  return createEnsCcipHandler(opts)(call)
}
