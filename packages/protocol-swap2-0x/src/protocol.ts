import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {zeroExProvider, type ZeroExProviderConfig} from "./provider.js";

export interface ZeroExSwap2Config extends Swap2EngineConfig, ZeroExProviderConfig {}

/** 0x as a standalone swap2 protocol (same-chain swaps on one account). */
export class ZeroExSwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  constructor(account: Swap2Account | undefined, config: ZeroExSwap2Config) {
    super(account, config);
    this.provider = zeroExProvider(config);
  }
  protected override chainSupported(caip2: string): boolean {
    return this.provider.supportsChain?.(caip2) === true;
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return fromChain === toChain && this.chainSupported(fromChain);
  }
}
