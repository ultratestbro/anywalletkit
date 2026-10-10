import {SingleProviderSwap2} from "@forgewallet/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@forgewallet/protocol-swap2-core/swap2/base";
import {cctp as cctpCfg} from "./config.js";
import {cctpProvider, type CctpProviderConfig} from "./provider.js";

export interface CctpSwap2Config extends Swap2EngineConfig, CctpProviderConfig {}

/** Standalone CCTP swap2: USDC burn-and-mint between EVM chains, claim via `claimSwap2`. */
export class CctpSwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  constructor(account: Swap2Account | undefined, config: CctpSwap2Config) {
    super(account, config);
    this.provider = cctpProvider(config);
  }
  protected override chainSupported(caip2: string): boolean {
    return cctpCfg.supportsChain(caip2);
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return cctpCfg.supports(fromChain, toChain);
  }
}
