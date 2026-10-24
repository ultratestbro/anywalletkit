import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {jupiter as jupCfg} from "./config.js";
import {jupiterProvider, type JupiterProviderConfig} from "./provider.js";

export interface JupiterSwap2Config extends Swap2EngineConfig, JupiterProviderConfig {}

/** Standalone Jupiter swap2: same-chain Solana swaps (Metis routing, /build, no Jupiter fee). */
export class JupiterSwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  constructor(account: Swap2Account | undefined, config: JupiterSwap2Config) {
    super(account, config);
    this.provider = jupiterProvider(config);
  }
  protected override chainSupported(caip2: string): boolean {
    return jupCfg.supportsChain(caip2);
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return jupCfg.supports(fromChain, toChain);
  }
}
