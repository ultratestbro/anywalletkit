/**
 * The app's side of Uniswap when the provider runs on your server.
 *
 * `uniswapRemoteProvider({baseUrl})` is `remoteProvider({name: "uniswap", baseUrl, ...uniswapPinsWith(options)})` plus
 * what the bare stub cannot carry: `ownGasEstimate: true` — the engine sends every Uniswap call with the account's own
 * estimate of that exact call, dry-run right before the broadcast, never the gas limit the backend quoted (owner
 * decision 7, UNISWAP-V4-RESEARCH §2.1: Monad charges the whole gas limit, and a v3 quote there carries 16.3M for a
 * swap the account estimates far lower) — and the module's `describeActivity`. Everything the backend returns is still
 * checked on the device by the pins (`verifyQuote`, call targets, spenders) before anything is approved or signed.
 */
import {remoteProvider, type RemoteProviderOptions} from "@anywalletkit/protocol-swap2-core/remote";
import type {CrossChainProvider} from "@anywalletkit/protocol-swap2-core/types";
import {describeUniswapActivity} from "./activity.js";
import {UNISWAP_V3, uniswapPinsWith, type UniswapPinsOptions} from "./addresses.js";
import {UNISWAP_V4} from "./v4/addresses.js";

export interface UniswapRemoteOptions extends UniswapPinsOptions, Pick<RemoteProviderOptions, "baseUrl" | "enabled" | "fetchImpl" | "headers" | "timeoutMs" | "allowInsecureBaseUrl"> {}

/** What {@link uniswapRemoteProvider} returns: a remote swap2 provider that declares `ownGasEstimate`. */
export type UniswapRemoteProvider = CrossChainProvider & {readonly ownGasEstimate: true};

/**
 * Uniswap through your backend (which runs `uniswapProvider`): the remote stub with the app's own pins
 * ({@link uniswapPinsWith}: the shipped tables, plus `v4ExtraPools` / `clockSkewSeconds` when given) and
 * `ownGasEstimate: true`, so the engine never broadcasts the backend's quoted gas limit. Same-chain swaps only; a chain
 * where the pins name no call target (no SwapRouter02, no v4 pool list) is not offered.
 *
 * ```ts
 * const uniswap = uniswapRemoteProvider({baseUrl: "/api/v2/swap2"});
 * ```
 */
export function uniswapRemoteProvider(options: UniswapRemoteOptions): UniswapRemoteProvider {
  const pins = uniswapPinsWith({
    ...(options.v4ExtraPools !== undefined ? {v4ExtraPools: options.v4ExtraPools} : {}),
    ...(options.clockSkewSeconds !== undefined ? {clockSkewSeconds: options.clockSkewSeconds} : {}),
  });
  const served = (caip2: string): boolean => pins.callTargets(caip2).length > 0;
  const inner = remoteProvider({
    name: "uniswap",
    baseUrl: options.baseUrl,
    supportsSameChain: true,
    supportsChain: served,
    supportsChainPair: (from, to) => from === to && served(from),
    supportsRoute: (from, to) => from.chain === to.chain && served(from.chain),
    callTargets: pins.callTargets,
    spenders: pins.spenders,
    verifyQuote: pins.verifyQuote!,
    reasonOf: pins.reasonOf!,
    ...(options.enabled ? {enabled: options.enabled} : {}),
    ...(options.fetchImpl ? {fetchImpl: options.fetchImpl} : {}),
    ...(options.headers ? {headers: options.headers} : {}),
    ...(options.timeoutMs !== undefined ? {timeoutMs: options.timeoutMs} : {}),
    ...(options.allowInsecureBaseUrl !== undefined ? {allowInsecureBaseUrl: options.allowInsecureBaseUrl} : {}),
  });
  return {
    ...inner,
    describeActivity: (tx, ctx) => describeUniswapActivity(tx, ctx, UNISWAP_V3, UNISWAP_V4),
    // The quoted gas limit is the backend's word: every call goes out with the account's own estimate (decision 7).
    ownGasEstimate: true,
  };
}
