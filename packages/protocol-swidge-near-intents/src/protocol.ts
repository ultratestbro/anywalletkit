import {SingleProviderSwidge} from "@forgewallet/protocol-swidge-core/swidge/single";
import type {SwidgeAccount, SwidgeEngineConfig} from "@forgewallet/protocol-swidge-core/swidge/base";
import {nearIntents as nearIntentsCfg} from "./config.js";
import {nearIntentsProvider, type NearIntentsProviderConfig} from "./provider.js";

export interface NearIntentsSwidgeConfig extends SwidgeEngineConfig, NearIntentsProviderConfig {}

export class NearIntentsSwidgeProtocol extends SingleProviderSwidge {
  protected readonly provider;
  constructor(account: SwidgeAccount | undefined, config: NearIntentsSwidgeConfig) {
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
