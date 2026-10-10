import {SingleProviderSwap2} from "@forgewallet/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@forgewallet/protocol-swap2-core/swap2/base";
import {thorchain as thorchainCfg} from "./config.js";
import {thorchainProvider, type ThorchainProviderConfig} from "./provider.js";

export interface ThorchainSwap2Config extends Swap2EngineConfig, ThorchainProviderConfig {}

export class ThorchainSwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  constructor(account: Swap2Account | undefined, config: ThorchainSwap2Config) {
    super(account, config);
    this.provider = thorchainProvider(config);
  }
  protected override chainSupported(caip2: string): boolean {
    return thorchainCfg.supportsChain(caip2);
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return this.provider.supportsRoute({chain: fromChain, token: ""}, {chain: toChain, token: ""});
  }
}
