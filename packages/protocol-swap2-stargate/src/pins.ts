import {decodeFunctionData, encodeFunctionData, pad, type Hex} from "viem";
import type {Quote, QuoteParams, RemotePins, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {validQuote} from "@anywalletkit/protocol-swap2-core/validate";
import {STARGATE_BUS_RETIRED} from "./availability.js";
import {STARGATE_ABI} from "./abi.js";
import {sourceMinimum} from "./amounts.js";
import {checkedStargateComposeQuote, createStargateComposer, isStargateComposeIntent, STARGATE_COMPOSE_CHAIN, type StargateComposeConfig} from "./compose-route.js";
import {stargateRegistry} from "./deployments.js";
import {parseStargateIntent, stargateToken} from "./intent.js";
import {createStargateQuoter, taxiNativeDrop, type StargateQuoteConfig, type StargateSendParam} from "./quote.js";
import type {StargateRegistry} from "./registry.js";
import {checkedStargateAccounting, checkedStargateSource, stargateFees} from "./source-tx.js";
import {assertStargate, sameAddress} from "./rpc.js";
import {createStargateTracker, type StargateTrackingConfig} from "./tracking.js";

export interface StargatePinsConfig extends StargateQuoteConfig, StargateTrackingConfig {
  nativeDrop?: {taxi?: bigint; bus?: boolean};
  /** Client opt-in for executable compose quotes; without it the pins refuse them. */
  compose?: StargateComposeConfig;
}

export {stargateFees};

export function checkedStargateQuote(q: Quote, registry: StargateRegistry) {
  const intent = parseStargateIntent(q.intentId, registry);
  const {source, destination, mode, sender, recipient, amount, minimum, nativeDrop} = intent;
  assertStargate(mode !== "bus", STARGATE_BUS_RETIRED);
  const {tx, cap} = checkedStargateSource(q, source, destination, amount, mode);
  assertStargate(q.minDestAmount === String(minimum), "quote identity mismatch");
  const sendParam: StargateSendParam = {
    dstEid: destination.eid, to: pad(recipient, {size: 32}), amountLD: amount,
    minAmountLD: sourceMinimum(minimum, source.localDecimals, destination.localDecimals, source.sharedDecimals),
    extraOptions: nativeDrop === 0n ? "0x" : mode === "taxi" ? taxiNativeDrop(nativeDrop, recipient) : "0x01",
    composeMsg: "0x", oftCmd: mode === "taxi" ? "0x" : "0x00",
  };
  // Re-encode, rather than ignoring unknown fields, trailing bytes or a changed refund recipient.
  const expected = encodeFunctionData({abi: STARGATE_ABI, functionName: "sendToken", args: [sendParam, {nativeFee: cap, lzTokenFee: 0n}, sender]});
  assertStargate(tx.data.toLowerCase() === expected.toLowerCase(), "calldata differs from the reviewed intent");
  const parsed = decodeFunctionData({abi: STARGATE_ABI, data: tx.data as Hex});
  assertStargate(parsed.functionName === "sendToken", "unsupported source function");
  assertStargate(/^[0-9]+$/.test(q.destAmount) && BigInt(q.destAmount) >= minimum, "invalid quoted output");
  checkedStargateAccounting(q, source, destination, amount, cap, BigInt(q.destAmount));
  assertStargate(q.providerData!.nativeDrop === String(nativeDrop), "native drop display mismatch");
  return {intent, sendParam, cap, tx};
}

export function stargatePins(config: StargatePinsConfig): RemotePins {
  const registry = config.registry ?? stargateRegistry;
  const quoter = createStargateQuoter(config);
  const recovery = createStargateTracker(config);
  const drop = {...config.nativeDrop};
  const composer = config.compose?.enabled ? createStargateComposer(config) : undefined;
  function verifyComposeQuote(params: QuoteParams, q: Quote) {
    assertStargate(composer && !params.flex && validQuote(q, params, "stargate"), "compose is not enabled on this client");
    const checked = checkedStargateComposeQuote(q, registry), {bridge: i} = checked.compose;
    assertStargate(i.source.chain === params.sourceChain && params.destChain === STARGATE_COMPOSE_CHAIN && sameAddress(stargateToken(params.sourceChain, params.sourceToken) ?? "", i.source.token) && sameAddress(stargateToken(params.destChain, params.destToken) ?? "", checked.compose.finalToken), "quote changed requested asset or chain");
    const placeholder = params.dry !== false ? "0x1111111111111111111111111111111111111111" : "";
    assertStargate(sameAddress(params.destAddress || placeholder, checked.compose.recipient) && sameAddress(params.refundAddress || placeholder, i.sender), "quote changed recipient or refund address");
    assertStargate(params.sourceDecimals === undefined || params.sourceDecimals === i.source.localDecimals, "source decimals mismatch");
    return checked;
  }
  function verifyQuote(params: QuoteParams, q: Quote): string | null {
    try {
      if (isStargateComposeIntent(q.intentId)) { verifyComposeQuote(params, q); return null; }
      assertStargate(!params.flex && validQuote(q, params, "stargate"), "invalid normalized quote");
      const {intent: i} = checkedStargateQuote(q, registry);
      assertStargate(i.source.chain === params.sourceChain && i.destination.chain === params.destChain && sameAddress(stargateToken(params.sourceChain, params.sourceToken) ?? "", i.source.token) && sameAddress(stargateToken(params.destChain, params.destToken) ?? "", i.destination.token), "quote changed requested asset or chain");
      const placeholder = params.dry !== false ? "0x1111111111111111111111111111111111111111" : "";
      assertStargate(sameAddress(params.destAddress || placeholder, i.recipient) && sameAddress(params.refundAddress || placeholder, i.sender), "quote changed recipient or refund address");
      assertStargate(params.sourceDecimals === undefined || params.sourceDecimals === i.source.localDecimals, "source decimals mismatch");
      assertStargate(i.mode === "taxi" ? i.nativeDrop === (drop.taxi ?? 0n) : drop.bus ? i.nativeDrop > 0n : i.nativeDrop === 0n, "unrequested native drop");
      return null;
    } catch { return "stargate: quote does not match client request and deployment pins"; }
  }
  return {
    recoveryTargets: recovery.recoveryTargets,
    verifyRecovery: recovery.verifyRecovery,
    trackIntent: recovery.trackIntent,
    callTargets: (chain) => registry.callTargets(chain),
    spenders: (chain) => registry.spenders(chain),
    verifyQuote,
    async verifyBuild(q: Quote, tx: UnsignedTx, params?: QuoteParams) {
      try {
        if (params) assertStargate(verifyQuote(params, q) === null, "quote mismatch");
        if (isStargateComposeIntent(q.intentId)) {
          assertStargate(composer, "compose is not enabled on this client");
          const {compose, tx: expected, cap} = checkedStargateComposeQuote(q, registry), source = compose.bridge.source;
          const canonical: UnsignedTx = {chain: source.chain, to: expected.to, data: expected.data, value: expected.value!, chainId: source.chainId, ...(expected.approvalAddress ? {approvalAddress: expected.approvalAddress} : {})};
          assertStargate(Object.keys(tx).every((key) => key in canonical) && Object.entries(canonical).every(([key, value]) => tx[key as keyof UnsignedTx] === value), "build mismatch");
          await composer.verifyBuild(compose, cap);
          assertStargate(q.validUntilMs > Date.now(), "quote changed during preflight");
          return null;
        }
        const {intent, tx: expected, cap} = checkedStargateQuote(q, registry);
        const canonical: UnsignedTx = {chain: intent.source.chain, to: expected.to!, data: expected.data!, value: expected.value!, chainId: intent.source.chainId, ...(expected.approvalAddress ? {approvalAddress: expected.approvalAddress} : {})};
        assertStargate(Object.keys(tx).every((key) => key in canonical) && Object.entries(canonical).every(([key, value]) => tx[key as keyof UnsignedTx] === value), "build mismatch");
        const fresh = await quoter.quote({sourceChain: intent.source.chain, sourceToken: intent.source.token, destinationChain: intent.destination.chain, destinationToken: intent.destination.token, sender: intent.sender, recipient: intent.recipient, amount: intent.amount, minimum: intent.minimum, slippageBps: 9999, mode: intent.mode,
          ...(intent.nativeDrop ? {nativeDrop: intent.mode === "taxi" ? {amount: intent.nativeDrop} : {bus: true}} : {}),
        });
        assertStargate(fresh.messagingFee <= cap && fresh.nativeDrop === intent.nativeDrop && q.validUntilMs > Date.now(), "quote changed during preflight");
        return null;
      } catch { return "stargate: build differs from the client-validated quote"; }
    },
  };
}
