import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {across as acrossCfg} from "./config.js";
import {acrossProvider, type AcrossProviderConfig} from "./provider.js";

export interface AcrossSwap2Config extends Swap2EngineConfig, AcrossProviderConfig {}

/**
 * Standalone Across swap2: EVM → EVM through the source chain's SpokePool, every deposit built and verified on the
 * device. Quoting arrives with the Across API V5 layer; until then the provider is disabled and quotes are refused.
 */
export class AcrossSwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  constructor(account: Swap2Account | undefined, config: AcrossSwap2Config) {
    super(account, config);
    this.provider = acrossProvider(config);
  }
  protected override chainSupported(caip2: string): boolean {
    return acrossCfg.supportsChain(caip2);
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return acrossCfg.supports(fromChain, toChain);
  }
}
