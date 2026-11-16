import {encodePacked, getAddress, pad, type Address, type Hex} from "viem";
import {STARGATE_ABI} from "./abi.js";
import {conversionRate, destinationAmount, sourceMinimum, splitFeeDetails, splitSourceAmount} from "./amounts.js";
import {stargateRegistry} from "./deployments.js";
import {STARGATE_BUS_RETIRED, stargateChainActive, stargateChainCutoff} from "./availability.js";
import type {StargateDeployment, StargateRegistry} from "./registry.js";
import {assertNotAborted, assertStargate, nonzeroAddress, safeReadError, stargateRpc, type StargateBlock, type StargateRpcConfig} from "./rpc.js";

/** Bus is retained for historical intents; new quotes accept Taxi only. */
export type StargateMode = "taxi" | "bus";
export interface StargateQuoteRequest {
  sourceChain: string;
  /** Exact token address; zero address denotes native coin. No symbol aliases. */
  sourceToken: string;
  destinationChain: string;
  destinationToken: string;
  sender: string;
  recipient: string;
  amount: bigint;
  minimum?: bigint;
  /** Defaults to zero: the entire expected output is protected. */
  slippageBps?: number;
  mode: StargateMode;
  /** Taxi specifies a uint128 amount. The legacy Bus option is refused for new quotes. */
  nativeDrop?: {amount: bigint} | {bus: true};
}
export interface StargateSendParam {
  readonly dstEid: number;
  readonly to: Hex;
  readonly amountLD: bigint;
  readonly minAmountLD: bigint;
  readonly extraOptions: Hex;
  readonly composeMsg: Hex;
  readonly oftCmd: Hex;
}
export interface StargateQuote {
  readonly mode: StargateMode;
  readonly source: StargateDeployment;
  readonly destination: StargateDeployment;
  readonly sender: Address;
  readonly recipient: Address;
  readonly sourceBlock: StargateBlock;
  readonly destinationBlock: StargateBlock;
  readonly requestedAmount: bigint;
  readonly sentAmount: bigint;
  readonly dust: bigint;
  readonly destinationAmount: bigint;
  readonly minimumDestinationAmount: bigint;
  readonly protocolFee: bigint;
  readonly protocolReward: bigint;
  readonly messagingFee: bigint;
  /** Fee including configured headroom. Surplus is sent to sender as the refund address. */
  readonly messagingFeeCap: bigint;
  /** Native input (including refundable dust) plus messagingFeeCap. */
  readonly nativeValue: bigint;
  readonly nativeDrop: bigint;
  readonly creditSD: bigint;
  readonly sendParam: StargateSendParam;
  readonly validUntilMs: number;
  /** A quote does not reserve credits or promise a delivery time (especially for queued Bus). */
  readonly liquidityReserved: false;
  readonly etaSeconds: null;
  /** Wallet simulation determines gas; an unavailable estimate is never reported as zero. */
  readonly sourceGas: null;
  readonly approvalGas: null;
}
export interface StargateQuoteConfig extends StargateRpcConfig {
  /** Locally reviewed pins; never populate this from an untrusted discovery API. */
  registry?: StargateRegistry;
  quoteTtlMs?: number;
  /** Integer 0..10000, default 2500. This is a cap, not an additional charged fee. */
  feeHeadroomBps?: number;
}

const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

/** Type 3 / executor worker 1 / native-drop option 2, with a 48-byte payload. */
export function taxiNativeDrop(amount: bigint, recipient: Address): Hex {
  assertStargate(typeof amount === "bigint" && amount > 0n && amount < (1n << 128n), "native drop must be a positive uint128");
  assertStargate(nonzeroAddress(recipient), "invalid native drop recipient");
  return encodePacked(["uint16", "uint8", "uint16", "uint8", "uint128", "bytes32"], [3, 1, 49, 2, amount, pad(recipient, {size: 32})]);
}

/** Read-only direct Stargate quotes. No transaction is signed, sent, or liquidity reserved. */
export function createStargateQuoter(config: StargateQuoteConfig) {
  const registry = config.registry ?? stargateRegistry;
  const rpc = stargateRpc(config);
  const ttl = config.quoteTtlMs ?? 60_000;
  const headroom = config.feeHeadroomBps ?? 2500;
  assertStargate(Number.isSafeInteger(ttl) && ttl > 0 && ttl <= 300_000, "invalid quote lifetime");
  assertStargate(Number.isInteger(headroom) && headroom >= 0 && headroom <= 10_000, "invalid messaging fee headroom");

  function supportsRoute(sourceChain: string, sourceToken: string, destinationChain: string, destinationToken: string): boolean {
    return stargateChainActive(sourceChain) && stargateChainActive(destinationChain) && rpc.has(sourceChain) && rpc.has(destinationChain) && !!registry.route(sourceChain, sourceToken, destinationChain, destinationToken);
  }

  async function quote(input: StargateQuoteRequest, signal?: AbortSignal): Promise<StargateQuote> {
    // Copy mutable caller objects before any await.
    const request = {...input, ...(input.nativeDrop ? {nativeDrop: {...input.nativeDrop}} : {})};
    const started = Date.now();
    try {
      assertNotAborted(signal);
      assertStargate(request.mode === "taxi" || request.mode === "bus", "invalid transport mode");
      assertStargate(request.mode !== "bus", STARGATE_BUS_RETIRED);
      assertStargate(stargateChainActive(request.sourceChain) && stargateChainActive(request.destinationChain), "chain support has ended for new transfers");
      const route = registry.route(request.sourceChain, request.sourceToken, request.destinationChain, request.destinationToken);
      assertStargate(route, "unsupported token route");
      const {source, destination} = route;
      assertStargate(nonzeroAddress(request.sender) && nonzeroAddress(request.recipient), "sender and recipient must be nonzero EVM addresses");
      const sender = getAddress(request.sender), recipient = getAddress(request.recipient);
      const slippage = request.slippageBps ?? 0;
      assertStargate(Number.isInteger(slippage) && slippage >= 0 && slippage < 10_000, "invalid slippage");
      const minimum = request.minimum ?? 0n;
      assertStargate(typeof minimum === "bigint" && minimum >= 0n && minimum <= UINT256_MAX, "invalid minimum");
      const split = splitSourceAmount(request.amount, source.localDecimals, source.sharedDecimals);
      assertStargate(split.amountSD > 0n, "amount is below shared-decimal precision");
      const src = rpc.client(source.chain, signal), dst = rpc.client(destination.chain, signal);
      const [sourceBlock, destinationBlock] = await Promise.all([rpc.snapshot(src, source.chainId), rpc.snapshot(dst, destination.chainId)]);
      await Promise.all([rpc.verify(src, source, destination, sourceBlock), rpc.verify(dst, destination, source, destinationBlock)]);
      assertNotAborted(signal);
      const at = {address: source.address, abi: STARGATE_ABI, blockNumber: sourceBlock.number, account: sender};
      const creditSD = await src.readContract({...at, functionName: "paths", args: [destination.eid]});
      let extraOptions: Hex = "0x", nativeDrop = 0n;
      if (request.nativeDrop) {
        assertStargate("amount" in request.nativeDrop && !("bus" in request.nativeDrop), "Taxi requires an explicit native drop amount");
        nativeDrop = request.nativeDrop.amount;
        extraOptions = taxiNativeDrop(nativeDrop, recipient);
      }
      const probe: StargateSendParam = {dstEid: destination.eid, to: pad(recipient, {size: 32}), amountLD: request.amount, minAmountLD: 0n, extraOptions, composeMsg: "0x", oftCmd: "0x"};
      const [limit, details, receipt] = await src.readContract({...at, functionName: "quoteOFT", args: [probe]});
      assertStargate(limit.minAmountLD <= split.sentLD && split.sentLD <= limit.maxAmountLD, "amount exceeds available OFT limits");
      assertStargate(receipt.amountSentLD === split.sentLD, "quote clipped the exact input amount");
      const received = destinationAmount(receipt.amountReceivedLD, source.localDecimals, destination.localDecimals, source.sharedDecimals);
      assertStargate(received > 0n, "quote has no output");
      const receivedSD = receipt.amountReceivedLD / conversionRate(source.localDecimals, source.sharedDecimals);
      assertStargate(creditSD === UINT64_MAX || receivedSD <= creditSD, "insufficient credits for output including reward");
      const fees = splitFeeDetails(details);
      assertStargate(receipt.amountSentLD - fees.feeLD + fees.rewardLD === receipt.amountReceivedLD, "protocol fee accounting mismatch");
      // Ceil the slippage floor, then ceil again to a representable shared amount.
      const slipFloor = (received * BigInt(10_000 - slippage) + 9999n) / 10_000n;
      const minAmountLD = sourceMinimum(minimum > slipFloor ? minimum : slipFloor, source.localDecimals, destination.localDecimals, source.sharedDecimals);
      assertStargate(minAmountLD <= receipt.amountReceivedLD, "output is below the caller's minimum");
      const sendParam = Object.freeze({...probe, minAmountLD});
      const fee = await src.readContract({...at, functionName: "quoteSend", args: [sendParam, false]});
      assertStargate(fee.lzTokenFee === 0n, "LZ token fees are unsupported");
      const cap = fee.nativeFee + (fee.nativeFee * BigInt(headroom) + 9999n) / 10_000n;
      const nativeValue = cap + (source.kind === "native" ? request.amount : 0n);
      assertStargate(nativeValue <= UINT256_MAX, "native value overflow");
      await Promise.all([rpc.unchanged(src, sourceBlock), rpc.unchanged(dst, destinationBlock)]);
      assertNotAborted(signal);
      const validUntilMs = Math.min(started + ttl, stargateChainCutoff(source.chain), stargateChainCutoff(destination.chain));
      assertStargate(Date.now() < validUntilMs, "quote expired during RPC reads");
      return Object.freeze({mode: request.mode, source, destination, sender, recipient, sourceBlock, destinationBlock, requestedAmount: request.amount, sentAmount: split.sentLD, dust: split.dustLD, destinationAmount: received, minimumDestinationAmount: destinationAmount(minAmountLD, source.localDecimals, destination.localDecimals, source.sharedDecimals), protocolFee: fees.feeLD, protocolReward: fees.rewardLD, messagingFee: fee.nativeFee, messagingFeeCap: cap, nativeValue, nativeDrop, creditSD, sendParam, validUntilMs, liquidityReserved: false, etaSeconds: null, sourceGas: null, approvalGas: null});
    } catch (error) { throw safeReadError(error); }
  }
  return Object.freeze({supportsRoute, quote});
}
