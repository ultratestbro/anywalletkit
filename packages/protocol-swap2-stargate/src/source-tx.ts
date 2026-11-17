import {zeroAddress} from "viem";
import {ccAssetByToken} from "@anywalletkit/swap2-assets";
import type {Quote} from "@anywalletkit/protocol-swap2-core/types";
import {stargateChainActive} from "./availability.js";
import {destinationAmount, splitSourceAmount} from "./amounts.js";
import type {StargateDeployment} from "./registry.js";
import {assertStargate, sameAddress} from "./rpc.js";

export function stargateFees(source: StargateDeployment, protocolFee: bigint, cap: bigint): NonNullable<Quote["fees"]> {
  const nativeToken = ccAssetByToken(source.chain, zeroAddress)?.assetId ?? zeroAddress;
  return [
    ...(protocolFee ? [{type: "protocol" as const, amount: String(protocolFee), token: source.kind === "native" ? nativeToken : source.token, included: true, description: "Stargate protocol fee, already deducted from output"}] : []),
    {type: "network", amount: String(cap), token: nativeToken, included: false, description: "Messaging fee cap; unused headroom is refunded. Source transaction gas is additional."},
  ];
}

/** Envelope shared by every direct `sendToken` route: target, chain, value, spender and expiry. */
export function checkedStargateSource(q: Quote, source: StargateDeployment, destination: StargateDeployment, amount: bigint, routeId: string) {
  assertStargate(stargateChainActive(source.chain) && stargateChainActive(destination.chain), "chain support has ended for new transfers");
  const tx = q.txRequest;
  assertStargate(q.provider === "stargate" && q.routeId === routeId && tx && tx.to && tx.data, "missing Stargate transaction");
  assertStargate(q.depositAddress === "" && q.depositMemo === null && tx.serializedTx === undefined && tx.gasLimit === undefined, "unexpected transaction fields");
  assertStargate(sameAddress(tx.to, source.address) && tx.chainId === source.chainId && q.sourceAmount === String(amount), "quote identity mismatch");
  assertStargate(Number.isFinite(q.validUntilMs) && q.validUntilMs > Date.now(), "quote expired");
  assertStargate(typeof tx.nativeFee === "string" && /^(0|[1-9][0-9]{0,77})$/.test(tx.nativeFee), "invalid messaging fee cap");
  const cap = BigInt(tx.nativeFee);
  const value = cap + (source.kind === "native" ? amount : 0n);
  assertStargate(value < (1n << 256n) && tx.value === String(value), "native value mismatch");
  assertStargate(source.kind !== "native" && source.approvalRequired ? !!tx.approvalAddress && sameAddress(tx.approvalAddress, source.address) : tx.approvalAddress === undefined, "approval spender mismatch");
  return {tx: {...tx, to: tx.to, data: tx.data}, cap};
}

/** Disclosed wire amount, dust, protocol fee/reward and messaging fee must reproduce `received`. */
export function checkedStargateAccounting(q: Quote, source: StargateDeployment, destination: StargateDeployment, amount: bigint, cap: bigint, received: bigint): void {
  const pd = q.providerData;
  assertStargate(pd && ["sentAmount", "dust", "protocolFee", "protocolReward", "messagingFee"].every((key) => /^(0|[1-9][0-9]{0,77})$/.test(pd[key] ?? "")), "missing amount accounting");
  const split = splitSourceAmount(amount, source.localDecimals, source.sharedDecimals);
  assertStargate(pd.sentAmount === String(split.sentLD) && pd.dust === String(split.dustLD), "dust accounting mismatch");
  assertStargate(destinationAmount(split.sentLD - BigInt(pd.protocolFee!) + BigInt(pd.protocolReward!), source.localDecimals, destination.localDecimals, source.sharedDecimals) === received, "fee accounting mismatch");
  assertStargate(BigInt(pd.messagingFee!) <= cap, "messaging fee exceeds cap");
  const fees = stargateFees(source, BigInt(pd.protocolFee!), cap);
  assertStargate(q.fees?.length === fees.length && fees.every((fee, index) => Object.entries(fee).every(([key, value]) => q.fees![index]![key as keyof typeof fee] === value)), "fee display mismatch");
}
