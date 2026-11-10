import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {cowProvider, type CowProviderConfig} from "./provider.js";

export interface CowSwap2Config extends Swap2EngineConfig, CowProviderConfig {}

/** CoW Protocol as a standalone swap2 protocol (same-chain intent swaps on one account). */
export class CowSwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  constructor(account: Swap2Account | undefined, config: CowSwap2Config) {
    super(account, config);
    this.provider = cowProvider(config);
  }
  protected override chainSupported(caip2: string): boolean {
    return this.provider.supportsChain?.(caip2) ?? false;
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return fromChain === toChain && this.chainSupported(fromChain);
  }
}
