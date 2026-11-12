import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {usdt0 as usdt0Cfg} from "./config.js";
import {usdt0Provider, type Usdt0ProviderConfig} from "./provider.js";

export interface Usdt0Swap2Config extends Swap2EngineConfig, Usdt0ProviderConfig {}

/**
 * Standalone USDT0 swap2: USDT / USDT0 between the LayerZero OFT deployments in one source transaction, and USDT from
 * Ethereum / Arbitrum / Celo into TON (and Tron, opt-in through `meshDestinations`) through the Legacy Mesh. Source
 * chains are EVM only (`getSupportedChains` lists where it can send from); Tron and TON are destinations.
 */
export class Usdt0Swap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  constructor(account: Swap2Account | undefined, config: Usdt0Swap2Config) {
    super(account, config);
    this.provider = usdt0Provider(config);
  }
  /** The provider's `meshDestinations` (its default when unset). */
  private get meshDestinations(): readonly string[] | undefined {
    return (this._config as Usdt0Swap2Config).meshDestinations;
  }
  protected override chainSupported(caip2: string): boolean {
    return usdt0Cfg.supportsSourceChain(caip2, this.meshDestinations);
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return usdt0Cfg.supports(fromChain, toChain, this.meshDestinations);
  }
}
