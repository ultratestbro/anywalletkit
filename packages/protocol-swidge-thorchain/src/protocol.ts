import {SingleProviderSwidge} from "@forgewallet/protocol-swidge-core/swidge/single";
import type {SwidgeAccount, SwidgeEngineConfig} from "@forgewallet/protocol-swidge-core/swidge/base";
import {thorchain as thorchainCfg} from "./config.js";
import {thorchainProvider, type ThorchainProviderConfig} from "./provider.js";

export interface ThorchainSwidgeConfig extends SwidgeEngineConfig, ThorchainProviderConfig {}

export class ThorchainSwidgeProtocol extends SingleProviderSwidge {
  protected readonly provider;
  constructor(account: SwidgeAccount | undefined, config: ThorchainSwidgeConfig) {
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
