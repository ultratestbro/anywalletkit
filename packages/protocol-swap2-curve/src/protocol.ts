import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {evmRef, isEvm} from "@anywalletkit/protocol-swap2-core/util";
import {CURVE_DEPLOYMENTS, deploymentOf} from "./deployments.js";
import {CURVE_POOLS} from "./pools/index.js";
import {curveProvider, type CurveProviderConfig} from "./provider.js";

export interface CurveSwap2Config extends Swap2EngineConfig, CurveProviderConfig {}

/** Curve Router NG as a standalone swap2 protocol (same-chain swaps on one account). */
export class CurveSwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  private readonly _rpcUrls: CurveProviderConfig["rpcUrls"];
  private readonly _deployments: NonNullable<CurveProviderConfig["deployments"]>;
  private readonly _pools: NonNullable<CurveProviderConfig["pools"]>;
  constructor(account: Swap2Account | undefined, config: CurveSwap2Config) {
    super(account, config);
    this.provider = curveProvider(config);
    this._rpcUrls = config.rpcUrls ?? {};
    this._deployments = config.deployments ?? CURVE_DEPLOYMENTS;
    this._pools = config.pools ?? CURVE_POOLS;
  }
  protected override chainSupported(caip2: string): boolean {
    if (!isEvm(caip2)) return false;
    const id = evmRef(caip2);
    return !!deploymentOf(this._deployments, id) && !!this._rpcUrls[id]?.length && !!(Object.prototype.hasOwnProperty.call(this._pools, id) && this._pools[id]!.pools.length);
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return fromChain === toChain && this.chainSupported(fromChain);
  }
}
