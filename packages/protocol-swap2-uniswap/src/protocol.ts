import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {evmRef, isEvm} from "@anywalletkit/protocol-swap2-core/util";
import {UNISWAP_V3} from "./addresses.js";
import {uniswapProvider, type UniswapProviderConfig} from "./provider.js";

export interface UniswapSwap2Config extends Swap2EngineConfig, UniswapProviderConfig {}

/** Uniswap v3 as a standalone swap2 protocol (same-chain swaps on one account). */
export class UniswapSwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  private readonly _rpcUrls: UniswapProviderConfig["rpcUrls"];
  private readonly _deployments: NonNullable<UniswapProviderConfig["deployments"]>;
  constructor(account: Swap2Account | undefined, config: UniswapSwap2Config) {
    super(account, config);
    this.provider = uniswapProvider(config);
    this._rpcUrls = config.rpcUrls ?? {};
    this._deployments = config.deployments ?? UNISWAP_V3;
  }
  protected override chainSupported(caip2: string): boolean {
    return isEvm(caip2) && !!this._deployments[evmRef(caip2)] && !!this._rpcUrls[evmRef(caip2)]?.length;
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return fromChain === toChain && this.chainSupported(fromChain);
  }
}
