import {decodeFunctionData, encodeFunctionData, pad, zeroAddress, type Hex} from "viem";
import {ccAssetByToken} from "@anywalletkit/swap2-assets";
import type {Quote, QuoteParams, RemotePins, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {validQuote} from "@anywalletkit/protocol-swap2-core/validate";
import {STARGATE_BUS_RETIRED, stargateChainActive} from "./availability.js";
import {STARGATE_ABI} from "./abi.js";
import {destinationAmount, sourceMinimum, splitSourceAmount} from "./amounts.js";
import {stargateRegistry} from "./deployments.js";
import {parseStargateIntent, stargateToken} from "./intent.js";
import {createStargateQuoter, taxiNativeDrop, type StargateQuoteConfig, type StargateSendParam} from "./quote.js";
import type {StargateDeployment, StargateRegistry} from "./registry.js";
import {assertStargate, sameAddress} from "./rpc.js";

export interface StargatePinsConfig extends StargateQuoteConfig {
  nativeDrop?: {taxi?: bigint; bus?: boolean};
}

export function stargateFees(source: StargateDeployment, protocolFee: bigint, cap: bigint): NonNullable<Quote["fees"]> {
  const nativeToken = ccAssetByToken(source.chain, zeroAddress)?.assetId ?? zeroAddress;
  return [
    ...(protocolFee ? [{type: "protocol" as const, amount: String(protocolFee), token: source.kind === "native" ? nativeToken : source.token, included: true, description: "Stargate protocol fee, already deducted from output"}] : []),
    {type: "network", amount: String(cap), token: nativeToken, included: false, description: "Messaging fee cap; unused headroom is refunded. Source transaction gas is additional."},
  ];
}

export function checkedStargateQuote(q: Quote, registry: StargateRegistry) {
  const intent = parseStargateIntent(q.intentId, registry);
  const {source, destination, mode, sender, recipient, amount, minimum, nativeDrop} = intent;
  assertStargate(mode !== "bus", STARGATE_BUS_RETIRED);
  assertStargate(stargateChainActive(source.chain) && stargateChainActive(destination.chain), "chain support has ended for new transfers");
  const tx = q.txRequest;
  assertStargate(q.provider === "stargate" && q.routeId === mode && tx && tx.to && tx.data, "missing Stargate transaction");
  assertStargate(q.depositAddress === "" && q.depositMemo === null && tx.serializedTx === undefined && tx.gasLimit === undefined, "unexpected transaction fields");
  assertStargate(sameAddress(tx.to, source.address) && tx.chainId === source.chainId && q.sourceAmount === String(amount) && q.minDestAmount === String(minimum), "quote identity mismatch");
  assertStargate(Number.isFinite(q.validUntilMs) && q.validUntilMs > Date.now(), "quote expired");
  assertStargate(typeof tx.nativeFee === "string" && /^(0|[1-9][0-9]{0,77})$/.test(tx.nativeFee), "invalid messaging fee cap");
  const cap = BigInt(tx.nativeFee);
  const value = cap + (source.kind === "native" ? amount : 0n);
  assertStargate(value < (1n << 256n) && tx.value === String(value), "native value mismatch");
  assertStargate(source.kind !== "native" && source.approvalRequired ? !!tx.approvalAddress && sameAddress(tx.approvalAddress, source.address) : tx.approvalAddress === undefined, "approval spender mismatch");
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
  const pd = q.providerData;
  assertStargate(pd && ["sentAmount", "dust", "protocolFee", "protocolReward", "messagingFee"].every((key) => /^(0|[1-9][0-9]{0,77})$/.test(pd[key] ?? "")), "missing amount accounting");
  const split = splitSourceAmount(amount, source.localDecimals, source.sharedDecimals);
  assertStargate(pd.sentAmount === String(split.sentLD) && pd.dust === String(split.dustLD), "dust accounting mismatch");
  assertStargate(destinationAmount(split.sentLD - BigInt(pd.protocolFee!) + BigInt(pd.protocolReward!), source.localDecimals, destination.localDecimals, source.sharedDecimals) === BigInt(q.destAmount), "fee accounting mismatch");
  assertStargate(BigInt(pd.messagingFee!) <= cap, "messaging fee exceeds cap");
  assertStargate(pd.nativeDrop === String(nativeDrop), "native drop display mismatch");
  const fees = stargateFees(source, BigInt(pd.protocolFee!), cap);
  assertStargate(q.fees?.length === fees.length && fees.every((fee, index) => Object.entries(fee).every(([key, value]) => q.fees![index]![key as keyof typeof fee] === value)), "fee display mismatch");
  return {intent, sendParam, cap, tx};
}

export function stargatePins(config: StargatePinsConfig): RemotePins {
  const registry = config.registry ?? stargateRegistry;
  const quoter = createStargateQuoter(config);
  const drop = {...config.nativeDrop};
  function verifyQuote(params: QuoteParams, q: Quote): string | null {
    try {
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
    callTargets: (chain) => registry.callTargets(chain),
    spenders: (chain) => registry.spenders(chain),
    verifyQuote,
    async verifyBuild(q: Quote, tx: UnsignedTx, params?: QuoteParams) {
      try {
        if (params) assertStargate(verifyQuote(params, q) === null, "quote mismatch");
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
