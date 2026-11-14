/**
 * The app's side of Across when the V5 key stays on a server.
 *
 * `acrossRemoteProvider({baseUrl})` forwards quotes and builds to your backend (which runs `acrossProvider({apiKey})`
 * under `createSwap2Handler`) and checks, on the device, everything that comes back before the engine signs:
 * `acrossPinsWith({maxFeeBps})` holds every deposit to the request the app itself sent — the pinned SpokePool as the
 * only call target and spender, depositor = the signing account, recipient, tokens, amounts, destination, empty
 * message, deadlines, the app's fee cap and the per-asset fee floor relayers take. The backend chooses only the
 * output amount within those bounds; it cannot get a deposit signed for anyone else, or one that pays relayers less
 * than they take. With `rpcUrls` the app also reads the deposit's status from the chains itself; without, it asks the
 * backend.
 */
import {remoteProvider, type RemoteProviderOptions} from "@anywalletkit/protocol-swap2-core/remote";
import type {CrossChainProvider, IntentRef, IntentStatus} from "@anywalletkit/protocol-swap2-core/types";
import {describeAcrossActivity} from "./activity.js";
import {across as acrossCfg} from "./config.js";
import {acrossProvider, acrossServesRoute} from "./provider.js";
import {acrossPinsWith, type AcrossPinsOptions} from "./verify.js";

export interface AcrossRemoteOptions extends AcrossPinsOptions, Pick<RemoteProviderOptions, "baseUrl" | "enabled" | "fetchImpl" | "headers" | "timeoutMs" | "allowInsecureBaseUrl"> {
  /**
   * The app's own JSON-RPC URLs per CAIP-2 chain: with both chains of a deposit here, its status is read on the device
   * (the source receipt and the destination's `fillStatuses`), not asked of the backend.
   */
  rpcUrls?: Readonly<Record<string, string>> | undefined;
}

/**
 * Across through your backend: `remoteProvider` with {@link acrossPinsWith} (the app's fee cap), the routes this
 * module prices, and on-device status when `rpcUrls` names both chains.
 *
 * ```ts
 * const across = acrossRemoteProvider({baseUrl: "https://api.example.com/swap2", rpcUrls});
 * ```
 */
export function acrossRemoteProvider(options: AcrossRemoteOptions): CrossChainProvider {
  const pins = acrossPinsWith(options.maxFeeBps !== undefined ? {maxFeeBps: options.maxFeeBps} : {});
  const inner = remoteProvider({
    name: "across",
    baseUrl: options.baseUrl,
    supportsChain: (chain) => acrossCfg.supportsChain(chain),
    supportsChainPair: (from, to) => acrossCfg.supports(from, to),
    supportsRoute: acrossServesRoute,
    ...pins,
    ...(options.enabled ? {enabled: options.enabled} : {}),
    ...(options.fetchImpl ? {fetchImpl: options.fetchImpl} : {}),
    ...(options.headers ? {headers: options.headers} : {}),
    ...(options.timeoutMs !== undefined ? {timeoutMs: options.timeoutMs} : {}),
    ...(options.allowInsecureBaseUrl !== undefined ? {allowInsecureBaseUrl: options.allowInsecureBaseUrl} : {}),
  });
  const rpcUrls = options.rpcUrls;
  // Keyless: it never quotes, only reads the chains.
  const local = rpcUrls ? acrossProvider({rpcUrls, ...(options.fetchImpl ? {fetchImpl: options.fetchImpl} : {})}) : undefined;
  const has = (caip2: string): boolean => !!rpcUrls && Object.prototype.hasOwnProperty.call(rpcUrls, caip2);
  return {
    ...inner,
    describeActivity: describeAcrossActivity,
    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      const m = /^across:([1-9]\d{0,15}):([1-9]\d{0,15}):/.exec(typeof ref.intentId === "string" ? ref.intentId : "");
      if (local && m && has(`eip155:${m[1]}`) && has(`eip155:${m[2]}`)) return local.trackIntent(ref);
      return inner.trackIntent(ref);
    },
  };
}
