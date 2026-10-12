import {SingleProviderSwap2} from "@forgewallet/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@forgewallet/protocol-swap2-core/swap2/base";
import {evmRef, isEvm} from "@forgewallet/protocol-swap2-core/util";
import {WRAPPED_NATIVE, wrapProvider, type WrapProviderConfig} from "./provider.js";

export interface WrapSwap2Config extends Swap2EngineConfig, WrapProviderConfig {}

/** Wrap / unwrap the native coin on one account (ETH ↔ WETH and friends). */
export class WrapSwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  private readonly _rpcUrls: WrapProviderConfig["rpcUrls"];
  private readonly _wrapped: NonNullable<WrapProviderConfig["wrapped"]>;
  constructor(account: Swap2Account | undefined, config: WrapSwap2Config) {
    super(account, config);
    this.provider = wrapProvider(config);
    this._rpcUrls = config.rpcUrls ?? {};
    this._wrapped = config.wrapped ?? WRAPPED_NATIVE;
  }
  protected override chainSupported(caip2: string): boolean {
    return isEvm(caip2) && !!this._wrapped[evmRef(caip2)] && !!this._rpcUrls[evmRef(caip2)]?.length;
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return fromChain === toChain && this.chainSupported(fromChain);
  }
}
