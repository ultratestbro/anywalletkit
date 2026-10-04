import {SingleProviderSwidge} from "@forgewallet/protocol-swidge-core/swidge/single";
import type {SwidgeAccount, SwidgeEngineConfig} from "@forgewallet/protocol-swidge-core/swidge/base";
import {lifi as lifiCfg} from "./config.js";
import {lifiProvider, type LifiProviderConfig} from "./provider.js";

export interface LifiSwidgeConfig extends SwidgeEngineConfig, LifiProviderConfig {}

export class LifiSwidgeProtocol extends SingleProviderSwidge {
  protected readonly provider;
  constructor(account: SwidgeAccount | undefined, config: LifiSwidgeConfig) {
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
