import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {lifi as lifiCfg} from "./config.js";
import {lifiProvider, type LifiProviderConfig} from "./provider.js";

export interface LifiSwap2Config extends Swap2EngineConfig, LifiProviderConfig {}

export class LifiSwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  constructor(account: Swap2Account | undefined, config: LifiSwap2Config) {
    super(account, config);
    this.provider = lifiProvider(config);
  }
  protected override chainSupported(caip2: string): boolean {
    return lifiCfg.supportsChain(caip2);
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return lifiCfg.supports(fromChain, toChain);
  }
}
