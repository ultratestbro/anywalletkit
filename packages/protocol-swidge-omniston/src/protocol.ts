import "./buffer-global.js";
import {SingleProviderSwidge} from "@forgewallet/protocol-swidge-core/swidge/single";
import type {SwidgeAccount, SwidgeEngineConfig} from "@forgewallet/protocol-swidge-core/swidge/base";
import {omniston as omnistonCfg} from "./config.js";
import {omnistonProvider, type OmnistonProviderOptions} from "./provider.js";

export interface OmnistonSwidgeConfig extends SwidgeEngineConfig, OmnistonProviderOptions {}

export class OmnistonSwidgeProtocol extends SingleProviderSwidge {
  protected readonly provider;
  constructor(account: SwidgeAccount | undefined, config: OmnistonSwidgeConfig) {
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
