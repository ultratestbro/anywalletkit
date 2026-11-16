import {encodeFunctionData} from "viem";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {STARGATE_ABI} from "./abi.js";
import {stargateRegistry} from "./deployments.js";
import {stargateIntent, stargateToken} from "./intent.js";
import {checkedStargateQuote, stargateFees, stargatePins, type StargatePinsConfig} from "./pins.js";
import {createStargateQuoter, type StargateMode, type StargateQuoteRequest} from "./quote.js";
import {assertStargate, safeReadError} from "./rpc.js";
import {createStargateTracker, type StargateTrackingConfig} from "./tracking.js";
import {describeStargateActivity} from "./activity.js";

export interface StargateProviderConfig extends StargatePinsConfig, StargateTrackingConfig {
  /** Explicit opt-in until funded end-to-end validation is complete. Default false. */
  enabled?: boolean;
  /** Default taxi. A selected routeId always takes precedence, without fallback. */
  defaultMode?: StargateMode;
  /** Native drop is opt-in and bound to each quote and its tracking identity. */
  nativeDrop?: {taxi?: bigint; bus?: boolean};
}
const PREVIEW_ACTOR = "0x1111111111111111111111111111111111111111";

/** Direct Stargate transport. Compose and Value Transfer API use separate validated adapters. */
export function stargateProvider(config: StargateProviderConfig): CrossChainProvider {
  const registry = config.registry ?? stargateRegistry;
  const quoter = createStargateQuoter(config);
  const tracker = createStargateTracker(config);
  const pins = stargatePins(config);
  const enabled = config.enabled ?? false, mode = config.defaultMode ?? "taxi";
  const configuredChains = new Set(Object.keys(config.rpcUrls));
  const drop = Object.freeze({...config.nativeDrop});
  assertStargate(mode === "taxi" || mode === "bus", "invalid default mode");
  const supports = (src: string, token: string, dst: string, out: string) => {
    const source = stargateToken(src, token), destination = stargateToken(dst, out);
    return !!source && !!destination && quoter.supportsRoute(src, source, dst, destination);
  };
  async function getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
    try {
      assertStargate(!params.flex, "flexible deposits are unsupported");
      const selected = params.routeId ?? mode;
      assertStargate(selected === "taxi" || selected === "bus", "unknown route selector");
      const sourceToken = stargateToken(params.sourceChain, params.sourceToken), destinationToken = stargateToken(params.destChain, params.destToken);
      assertStargate(sourceToken && destinationToken && /^[0-9]{1,78}$/.test(params.amountIn), "invalid token or amount");
      assertStargate(params.minAmountOut === undefined || /^[0-9]{1,78}$/.test(params.minAmountOut), "invalid minimum");
      const source = registry.find(params.sourceChain, sourceToken);
      assertStargate(source && (params.sourceDecimals === undefined || params.sourceDecimals === source.localDecimals), "source decimals mismatch");
      const dry = params.dry !== false;
      const sender = params.refundAddress || (dry ? PREVIEW_ACTOR : "");
      const recipient = params.destAddress || (dry ? PREVIEW_ACTOR : "");
      const request: StargateQuoteRequest = {sourceChain: params.sourceChain, sourceToken, destinationChain: params.destChain, destinationToken, sender, recipient, amount: BigInt(params.amountIn), mode: selected,
        ...(params.minAmountOut !== undefined ? {minimum: BigInt(params.minAmountOut)} : {}), ...(params.slippageBps !== undefined ? {slippageBps: params.slippageBps} : {}),
        ...(selected === "taxi" && drop.taxi !== undefined ? {nativeDrop: {amount: drop.taxi}} : selected === "bus" && drop.bus ? {nativeDrop: {bus: true}} : {}),
      };
      const q = await quoter.quote(request, signal);
      const fee = {nativeFee: q.messagingFeeCap, lzTokenFee: 0n};
      const data = encodeFunctionData({abi: STARGATE_ABI, functionName: "sendToken", args: [q.sendParam, fee, q.sender]});
      const out: Quote = {
        provider: "stargate", routeId: selected, intentId: stargateIntent(q), depositAddress: "", depositMemo: null,
        sourceAmount: String(q.requestedAmount), destAmount: String(q.destinationAmount), minDestAmount: String(q.minimumDestinationAmount),
        txRequest: {to: q.source.address, data, value: String(q.nativeValue), nativeFee: String(q.messagingFeeCap), chainId: q.source.chainId, ...(q.source.kind !== "native" && q.source.approvalRequired ? {approvalAddress: q.source.address} : {})},
        feeUsd: 0, etaSeconds: null, reliability: 0.9, validUntilMs: q.validUntilMs,
        fees: stargateFees(q.source, q.protocolFee, q.messagingFeeCap),
        providerData: {sentAmount: String(q.sentAmount), dust: String(q.dust), protocolFee: String(q.protocolFee), protocolReward: String(q.protocolReward), messagingFee: String(q.messagingFee), nativeDrop: String(q.nativeDrop), sourceBlock: String(q.sourceBlock.number), sourceBlockHash: q.sourceBlock.hash, destinationBlock: String(q.destinationBlock.number), destinationBlockHash: q.destinationBlock.hash, liquidityReserved: "false", feeUsdKnown: "false", sourceGas: "unknown", approvalGas: "unknown"},
      };
      checkedStargateQuote(out, registry);
      return out;
    } catch (error) { params.onRefusal?.(safeReadError(error).message); return null; }
  }
  async function buildDeposit(q: Quote): Promise<UnsignedTx> {
    const {intent, tx} = checkedStargateQuote(q, registry);
    return {chain: intent.source.chain, to: tx.to!, data: tx.data!, value: tx.value!, chainId: intent.source.chainId, ...(tx.approvalAddress ? {approvalAddress: tx.approvalAddress} : {})};
  }
  return {
    name: "stargate", enabled: () => enabled,
    supportsRoute: (from, to) => supports(from.chain, from.token, to.chain, to.token),
    supportsChain: (chain) => registry.deployments.some((d) => d.chain === chain) && configuredChains.has(chain),
    supportsChainPair: (from, to) => registry.paths.some((p) => p.source === from && p.destination === to) && configuredChains.has(from) && configuredChains.has(to),
    callTargets: pins.callTargets, spenders: pins.spenders,
    describeActivity: (tx, ctx) => describeStargateActivity(tx, ctx, registry),
    getQuote,
    async getQuotes(params, signal) {
      assertStargate(params.dry !== false, "candidate enumeration is preview-only");
      const modes: StargateMode[] = params.routeId ? [params.routeId as StargateMode] : ["taxi", "bus"];
      const results = await Promise.all(modes.map((routeId) => getQuote({...params, routeId, dry: true}, signal)));
      return results.filter((q): q is Quote => q !== null);
    },
    buildDeposit,
    async preflightDeposit(q, tx) {
      assertStargate(await pins.verifyBuild!(q, tx) === null, "source transaction changed");
    },
    ...tracker,
  };
}
