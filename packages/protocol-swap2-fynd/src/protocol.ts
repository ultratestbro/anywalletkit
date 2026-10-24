import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {evmRef, isEvm} from "@anywalletkit/protocol-swap2-core/util";
import {fyndProvider, type FyndProviderConfig} from "./provider.js";
import {FYND_CHAINS} from "./router.js";

export interface FyndSwap2Config extends Swap2EngineConfig, FyndProviderConfig {}

/** Fynd as a standalone swap2 protocol (same-chain swaps on one account). */
export class FyndSwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  private readonly _fynd: FyndProviderConfig;
  constructor(account: Swap2Account | undefined, config: FyndSwap2Config) {
    super(account, config);
    this.provider = fyndProvider(config);
    this._fynd = config;
  }
  protected override chainSupported(caip2: string): boolean {
    if (!isEvm(caip2)) return false;
    const id = evmRef(caip2);
    return !!FYND_CHAINS[id] && (!!this._fynd.selfHosted?.[id] || !!this._fynd.apiKey);
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return fromChain === toChain && this.chainSupported(fromChain);
  }
}
