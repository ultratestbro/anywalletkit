import {SingleProviderSwap2} from "@forgewallet/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@forgewallet/protocol-swap2-core/swap2/base";
import {chainflip as cfCfg} from "./config.js";
import {chainflipProvider, type ChainflipProviderConfig} from "./provider.js";

export interface ChainflipSwap2Config extends Swap2EngineConfig, ChainflipProviderConfig {}

/** Standalone Chainflip swap2: vault swaps from Ethereum, Arbitrum and Tron to every Chainflip chain. */
export class ChainflipSwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  constructor(account: Swap2Account | undefined, config: ChainflipSwap2Config) {
    super(account, config);
    this.provider = chainflipProvider(config);
  }
  protected override chainSupported(caip2: string): boolean {
    return cfCfg.supportsChain(caip2);
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return cfCfg.supports(fromChain, toChain);
  }
}
