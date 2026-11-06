import {CURVE_DEPLOYMENTS, CURVE_LEGACY_ROUTERS, ZERO_ADDRESS, deploymentOf, type CurveDeployment} from "./deployments.js";
import {CURVE_POOLS} from "./pools/index.js";
import type {CurveChainPools} from "./pools/types.js";

/**
 * Labels for the contracts a Curve swap touches on `chainId`, for tx-preview's `known` (address → label): the pinned
 * Router NG (and Ethereum's older routers, so history reads), every allowlisted pool, the wrapped native the router's
 * wrap hop uses and, on Ethereum, the scrvUSD vault. Empty for a chain without a pinned router.
 */
export function curveKnownContracts(
  chainId: number,
  tables: {deployments?: Readonly<Record<number, CurveDeployment>>; pools?: Readonly<Record<number, CurveChainPools>>} = {},
): Record<string, string> {
  const d = deploymentOf(tables.deployments ?? CURVE_DEPLOYMENTS, chainId);
  if (!d) return {};
  const out: Record<string, string> = {[d.router]: `Curve Router NG ${d.version} · ${d.label}`};
  if (!tables.deployments) {
    for (const r of Object.prototype.hasOwnProperty.call(CURVE_LEGACY_ROUTERS, chainId) ? CURVE_LEGACY_ROUTERS[chainId]! : []) out[r.router] = `Curve Router NG ${r.version} (older) · ${d.label}`;
  }
  const pools = tables.pools ?? CURVE_POOLS;
  const table = Object.prototype.hasOwnProperty.call(pools, chainId) ? pools[chainId] : undefined;
  for (const p of table?.chainId === chainId ? table.pools : []) out[p.address] = `Curve pool · ${p.name}`;
  if (d.weth.toLowerCase() !== ZERO_ADDRESS) out[d.weth] = `Wrapped native (Curve router wrap hop) · ${d.label}`;
  if (d.erc4626) out[d.erc4626.vault] = "Savings crvUSD (scrvUSD vault)";
  return out;
}
