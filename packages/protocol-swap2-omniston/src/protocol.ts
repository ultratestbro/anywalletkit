import "./buffer-global.js";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {omniston as omnistonCfg} from "./config.js";
import {omnistonProvider, type OmnistonProviderOptions} from "./provider.js";

export interface OmnistonSwap2Config extends Swap2EngineConfig, OmnistonProviderOptions {}

export class OmnistonSwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  constructor(account: Swap2Account | undefined, config: OmnistonSwap2Config) {
    super(account, config);
    this.provider = omnistonProvider(config);
  }
  protected override chainSupported(caip2: string): boolean {
    // Network discovery is broad; provider.supportsRoute keeps the currently
    // audited execution direction (TON-source → EVM) fail-closed.
    return omnistonCfg.supportsChain(caip2);
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return this.provider.supportsRoute({chain: fromChain, token: ""}, {chain: toChain, token: ""});
  }
}
