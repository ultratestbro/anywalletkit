import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {symbiosis as symbiosisCfg} from "./config.js";
import {symbiosisProvider, type SymbiosisProviderConfig} from "./provider.js";

export interface SymbiosisSwap2Config extends Swap2EngineConfig, SymbiosisProviderConfig {}

/** Standalone Symbiosis swap2: any-to-any between EVM chains, Tron and TON through Symbiosis' own bridge, in one source transaction. */
export class SymbiosisSwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  constructor(account: Swap2Account | undefined, config: SymbiosisSwap2Config) {
    super(account, config);
    this.provider = symbiosisProvider(config);
  }
  protected override chainSupported(caip2: string): boolean {
    return symbiosisCfg.supportsChain(caip2);
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return this.provider.supportsChainPair?.(fromChain, toChain) ?? symbiosisCfg.supports(fromChain, toChain);
  }
}
