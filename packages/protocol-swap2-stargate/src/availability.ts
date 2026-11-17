/** Reviewed service policy, separate from deployment identity and historical tracking.
 * https://layerzero.network/blog/ecosystem-update-september-2026 (2026-09-15)
 * https://layerzero.network/blog/support-update-july-24-2026 (updated 2026-10-29)
 */
export const STARGATE_BUS_RETIRED = "Stargate Bus is retired for new transfers; use Taxi";

// Scroll is the only currently pinned chain in the announced Stargate sunset list.
// Fail closed at the beginning of the effective day (UTC); tracking stays available.
export function stargateChainCutoff(chain: string): number {
  return chain === "eip155:534352" ? Date.UTC(2026, 11, 8) : Infinity;
}

export function stargateChainActive(chain: string, now = Date.now()): boolean {
  return now < stargateChainCutoff(chain);
}
