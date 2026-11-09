import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {relay as relayCfg} from "./config.js";
import {relayProvider, type RelayProviderConfig} from "./provider.js";

export interface RelaySwap2Config extends Swap2EngineConfig, RelayProviderConfig {}

/** Standalone Relay swap2: EVM → EVM through Relay's depository, every order verified on the device before a deposit is signed. */
export class RelaySwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  constructor(account: Swap2Account | undefined, config: RelaySwap2Config) {
    super(account, config);
    this.provider = relayProvider(config);
  }
  protected override chainSupported(caip2: string): boolean {
    return relayCfg.supportsChain(caip2);
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return relayCfg.supports(fromChain, toChain);
  }
}
