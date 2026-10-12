import {SingleProviderSwap2} from "@forgewallet/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@forgewallet/protocol-swap2-core/swap2/base";
import {evmRef, isEvm} from "@forgewallet/protocol-swap2-core/util";
import {BALANCER_V2_CHAINS, balancerProvider, type BalancerProviderConfig} from "./provider.js";

export interface BalancerSwap2Config extends Swap2EngineConfig, BalancerProviderConfig {}

/** Balancer v2 as a standalone swap2 protocol (same-chain swaps on one account). */
export class BalancerSwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  private readonly _rpcUrls: BalancerProviderConfig["rpcUrls"];
  constructor(account: Swap2Account | undefined, config: BalancerSwap2Config) {
    super(account, config);
    this.provider = balancerProvider(config);
    this._rpcUrls = config.rpcUrls ?? {};
  }
  protected override chainSupported(caip2: string): boolean {
    return isEvm(caip2) && !!BALANCER_V2_CHAINS[evmRef(caip2)] && !!this._rpcUrls[evmRef(caip2)]?.length;
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return fromChain === toChain && this.chainSupported(fromChain);
  }
}
