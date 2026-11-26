import {UNISWAP_V4_POOLS} from "../v4pools/index.js";
import {uniswapV4DeploymentOf, type UniswapV4Deployment} from "./addresses.js";
import type {V4PoolKey} from "./pool.js";
import type {UniswapV4Mode} from "./verify.js";

/**
 * Where a provider in `mode` quotes Uniswap v4 (one rule for the provider and the standalone protocol, so they never
 * disagree): a pinned deployment that is quotable (not HyperEVM) with a pool list the app can check the route against —
 * the shipped one, or the integrator's own `v4ExtraPools` (provenance, UNISWAP-V4-RESEARCH §6.5 row 9). "native-in" also
 * needs a native coin that is not an ERC-20 (Celo, Arc: refused) and a wrapped native; "all" (token input through the
 * SwapProxy) serves a chain whose native coin is an ERC-20 too, for token → token only (see {@link v4ServesFlow}).
 */
export function v4ServedDeployment(
  chainId: number,
  mode: UniswapV4Mode,
  deployments: Readonly<Record<number, UniswapV4Deployment>>,
  extraPools: Readonly<Record<number, readonly V4PoolKey[]>>,
): UniswapV4Deployment | undefined {
  if (mode === "off") return undefined;
  const d4 = uniswapV4DeploymentOf(chainId, deployments);
  if (!d4 || d4.quotable === false) return undefined;
  if (mode === "native-in" && !nativeServed(d4)) return undefined;
  const own = Object.prototype.hasOwnProperty.call(UNISWAP_V4_POOLS, chainId);
  const extra = Object.prototype.hasOwnProperty.call(extraPools, chainId) && (extraPools[chainId]?.length ?? 0) > 0;
  return own || extra ? d4 : undefined;
}

/**
 * Whether a served chain's v4 takes this flow: native in → token ("native-in" and "all"); token → token and token →
 * native ("all" only, through the SwapProxy). A native leg needs a native coin that is not an ERC-20 and a wrapped native;
 * native → native is never a swap.
 */
export function v4ServesFlow(d4: UniswapV4Deployment, mode: UniswapV4Mode, nativeIn: boolean, nativeOut: boolean): boolean {
  if (mode === "off" || (nativeIn && nativeOut)) return false;
  if ((nativeIn || nativeOut) && !nativeServed(d4)) return false;
  return nativeIn || mode === "all";
}

const nativeServed = (d4: UniswapV4Deployment): boolean => d4.nativeWrap !== false && !!d4.weth;
