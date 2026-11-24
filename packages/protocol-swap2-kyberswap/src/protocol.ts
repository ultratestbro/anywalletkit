import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {evmRef, isEvm} from "@anywalletkit/protocol-swap2-core/util";
import {kyberswapProvider, type KyberswapProviderConfig} from "./provider.js";
import {kyberChain} from "./router.js";

export interface KyberswapSwap2Config extends Swap2EngineConfig, KyberswapProviderConfig {}

/** KyberSwap as a standalone swap2 protocol (same-chain swaps on one account). */
export class KyberswapSwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  private readonly _kyber: KyberswapProviderConfig;
  constructor(account: Swap2Account | undefined, config: KyberswapSwap2Config) {
    super(account, config);
    this.provider = kyberswapProvider(config);
    this._kyber = config;
  }
  protected override chainSupported(caip2: string): boolean {
    if (!isEvm(caip2)) return false;
    const id = evmRef(caip2);
    return !!kyberChain(id) && (!this._kyber.enabledChains || this._kyber.enabledChains.includes(id)) && !!this._kyber.rpcUrls?.[id]?.length;
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return fromChain === toChain && this.chainSupported(fromChain);
  }
}
