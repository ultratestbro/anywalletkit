import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {nearIntents as nearIntentsCfg} from "./config.js";
import {nearIntentsProvider, type NearIntentsProviderConfig} from "./provider.js";

export interface NearIntentsSwap2Config extends Swap2EngineConfig, NearIntentsProviderConfig {}

export class NearIntentsSwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  constructor(account: Swap2Account | undefined, config: NearIntentsSwap2Config) {
    super(account, config);
    this.provider = nearIntentsProvider(config);
  }
  protected override chainSupported(caip2: string): boolean {
    return nearIntentsCfg.supports(caip2, "eip155:1") || nearIntentsCfg.supports("eip155:1", caip2);
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return nearIntentsCfg.supports(fromChain, toChain);
  }
}
