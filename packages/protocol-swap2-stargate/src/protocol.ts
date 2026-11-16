import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {stargateProvider, type StargateProviderConfig} from "./provider.js";

export interface StargateSwap2Config extends Swap2EngineConfig, StargateProviderConfig {}

/** Direct, reviewed Stargate deployments through the shared approval/review/journal engine. */
export class StargateSwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  constructor(account: Swap2Account | undefined, config: StargateSwap2Config) {
    super(account, config);
    this.provider = stargateProvider(config);
  }
  protected override chainSupported(chain: string): boolean { return this.provider.supportsChain!(chain); }
  protected override pairSupported(from: string, to: string): boolean { return this.provider.supportsChainPair!(from, to); }
}
