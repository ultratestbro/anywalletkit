import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {Swap2Account, Swap2EngineConfig} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {evmRef, isEvm} from "@anywalletkit/protocol-swap2-core/util";
import {UNISWAP_V3} from "./addresses.js";
import {uniswapProvider, type UniswapProviderConfig} from "./provider.js";
import {UNISWAP_V4, uniswapV4DeploymentOf} from "./v4/addresses.js";
import {UNISWAP_V4_POOLS} from "./v4pools/index.js";

export interface UniswapSwap2Config extends Swap2EngineConfig, UniswapProviderConfig {}

/** Uniswap (v3, and v4 when `v4` is on) as a standalone swap2 protocol (same-chain swaps on one account). */
export class UniswapSwap2Protocol extends SingleProviderSwap2 {
  protected readonly provider;
  private readonly _rpcUrls: UniswapProviderConfig["rpcUrls"];
  private readonly _deployments: NonNullable<UniswapProviderConfig["deployments"]>;
  private readonly _v4: (id: number) => boolean;
  constructor(account: Swap2Account | undefined, config: UniswapSwap2Config) {
    super(account, config);
    this.provider = uniswapProvider(config);
    this._rpcUrls = config.rpcUrls ?? {};
    this._deployments = config.deployments ?? UNISWAP_V3;
    // The chains the provider quotes v4 on (see UniswapProviderConfig.v4): a pinned, quotable deployment whose native coin
    // is not an ERC-20, with a pool list — shipped, or the integrator's own.
    const v4On = (config.v4 ?? "off") !== "off";
    const v4Deployments = config.v4Deployments ?? UNISWAP_V4;
    const extra = config.v4ExtraPools ?? {};
    this._v4 = (id) => {
      if (!v4On) return false;
      const d4 = uniswapV4DeploymentOf(id, v4Deployments);
      if (!d4 || d4.quotable === false || d4.nativeWrap === false || !d4.weth) return false;
      return Object.prototype.hasOwnProperty.call(UNISWAP_V4_POOLS, id) || !!(Object.prototype.hasOwnProperty.call(extra, id) && extra[id]?.length);
    };
  }
  protected override chainSupported(caip2: string): boolean {
    return isEvm(caip2) && (!!this._deployments[evmRef(caip2)] || this._v4(evmRef(caip2))) && !!this._rpcUrls[evmRef(caip2)]?.length;
  }
  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return fromChain === toChain && this.chainSupported(fromChain);
  }
}
