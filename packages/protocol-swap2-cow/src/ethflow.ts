/**
 * Native-coin sells through CoWSwapEthFlow (github.com/cowprotocol/ethflowcontract): the account sends one
 * transaction, `createOrder(data)` with the input as its value; the contract wraps the coin and becomes the owner of
 * a regular GPv2 order selling the wrapped native. The order is placed on-chain — nothing is signed off-chain and
 * nothing is posted to the orderbook by the wallet.
 *
 * What the user keeps: the order's `validTo` (after it, the order can no longer trade) and the refund — a filled
 * order pays the receiver; an order that expired or was invalidated returns the coin to the address that created
 * it, through `invalidateOrder(data)` (by the creator at any time, by anyone once expired).
 */
import {decodeFunctionData, encodeFunctionData, getAddress, parseAbi, type Hex} from "viem";
import {bigintToNumber} from "@anywalletkit/core";
import type {CowDeployment} from "./deployments.js";
import {orderDigest, orderUid, type CowOrder} from "./order.js";

export const ETH_FLOW_ABI = parseAbi([
  "struct EthFlowOrderData { address buyToken; address receiver; uint256 sellAmount; uint256 buyAmount; bytes32 appData; uint256 feeAmount; uint32 validTo; bool partiallyFillable; int64 quoteId; }",
  "function createOrder(EthFlowOrderData order) payable returns (bytes32 orderHash)",
  "function invalidateOrder(EthFlowOrderData order)",
  "function orders(bytes32 orderHash) view returns (address owner, uint32 validTo)",
  "error IncorrectEthAmount()",
  "error NotAllowedZeroSellAmount()",
  "error OrderIsAlreadyExpired()",
  "error OrderIsAlreadyOwned(bytes32 orderHash)",
  "error NotAllowedToInvalidateOrder(bytes32 orderHash)",
  "error EthTransferFailed()",
  "error ReceiverMustBeSet()",
]);
/** `createOrder((address,address,uint256,uint256,bytes32,uint256,uint32,bool,int64))`. */
export const ETH_FLOW_CREATE_SELECTOR = "0x322bba21";
/** `invalidateOrder((address,address,uint256,uint256,bytes32,uint256,uint32,bool,int64))`. */
export const ETH_FLOW_INVALIDATE_SELECTOR = "0x7bc41b96";
/** `orders[hash].owner` of an order that was invalidated or refunded (`EthFlowOrder.INVALIDATED_OWNER`). */
export const ETH_FLOW_INVALIDATED_OWNER = "0xffffffffffffffffffffffffffffffffffffffff";
/** The GPv2 order behind an eth-flow order never expires on the settlement side; the user's expiry lives in eth-flow. */
export const ETH_FLOW_GPV2_VALID_TO = 0xffffffff;
/** Gas for `createOrder` when it cannot be estimated (the transaction wraps, stores one slot and emits one event). */
export const ETH_FLOW_CREATE_GAS = 150_000n;
/** Gas for `invalidateOrder` (an unwrap and a native transfer). */
export const ETH_FLOW_INVALIDATE_GAS = 120_000n;

/** `EthFlowOrder.Data` with this module's fixed fields left out: `feeAmount` 0, `partiallyFillable` false. */
export interface EthFlowData {
  buyToken: string;
  receiver: string;
  /** Wei, decimal: the whole input. */
  sellAmount: string;
  /** Base units, decimal: the least the receiver accepts. */
  buyAmount: string;
  appData: string;
  /** Unix seconds: the order trades until then. */
  validTo: number;
  /** The quote the order was priced from (the orderbook links them). */
  quoteId: number;
}

const tuple = (d: EthFlowData) => ({
  buyToken: getAddress(d.buyToken),
  receiver: getAddress(d.receiver),
  sellAmount: BigInt(d.sellAmount),
  buyAmount: BigInt(d.buyAmount),
  appData: d.appData as Hex,
  feeAmount: 0n,
  validTo: d.validTo,
  partiallyFillable: false,
  quoteId: BigInt(d.quoteId),
});

function assertData(d: EthFlowData): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(d.buyToken) || !/^0x[0-9a-fA-F]{40}$/.test(d.receiver)) throw new Error("cow: eth-flow order addresses are malformed");
  if (/^0x0{40}$/.test(d.receiver)) throw new Error("cow: an eth-flow order must name its receiver");
  if (!/^[1-9][0-9]{0,77}$/.test(d.sellAmount) || !/^[1-9][0-9]{0,77}$/.test(d.buyAmount)) throw new Error("cow: eth-flow amounts must be positive decimals");
  if (!/^0x[0-9a-fA-F]{64}$/.test(d.appData)) throw new Error("cow: eth-flow appData must be 32 bytes");
  if (!Number.isInteger(d.validTo) || d.validTo <= 0 || d.validTo >= ETH_FLOW_GPV2_VALID_TO) throw new Error("cow: eth-flow validTo must be a unix time");
  if (!Number.isSafeInteger(d.quoteId) || d.quoteId < 0) throw new Error("cow: eth-flow quote id must be a non-negative integer");
}

/** `createOrder(data)` calldata; the transaction's value is `data.sellAmount`. */
export function encodeCreateOrder(d: EthFlowData): Hex {
  assertData(d);
  return encodeFunctionData({abi: ETH_FLOW_ABI, functionName: "createOrder", args: [tuple(d)]});
}

/** `invalidateOrder(data)` calldata: cancels a live order (its creator only) or refunds an expired one (anyone). */
export function encodeInvalidateOrder(d: EthFlowData): Hex {
  assertData(d);
  return encodeFunctionData({abi: ETH_FLOW_ABI, functionName: "invalidateOrder", args: [tuple(d)]});
}

/** `orders(hash)` calldata. */
export const encodeOrdersRead = (digest: string): Hex => encodeFunctionData({abi: ETH_FLOW_ABI, functionName: "orders", args: [digest as Hex]});

/** The order data of a `createOrder` / `invalidateOrder` call, or null when the calldata is neither (or carries a fee / partial fill). */
export function decodeEthFlowCall(data: string): {method: "createOrder" | "invalidateOrder"; order: EthFlowData} | null {
  try {
    const call = decodeFunctionData({abi: ETH_FLOW_ABI, data: data as Hex});
    if (call.functionName !== "createOrder" && call.functionName !== "invalidateOrder") return null;
    const o = call.args[0];
    if (o.feeAmount !== 0n || o.partiallyFillable || o.quoteId < 0n || o.quoteId > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return {
      method: call.functionName,
      order: {buyToken: o.buyToken, receiver: o.receiver, sellAmount: o.sellAmount.toString(), buyAmount: o.buyAmount.toString(), appData: o.appData, validTo: o.validTo, quoteId: bigintToNumber(o.quoteId)},
    };
  } catch {
    return null;
  }
}

/** The GPv2 order eth-flow places for `d` (`EthFlowOrder.toCoWSwapOrder`): it sells the wrapped native and never expires. */
export function ethFlowGpv2Order(deployment: CowDeployment, d: EthFlowData): CowOrder {
  assertData(d);
  return {
    sellToken: deployment.wrappedNative,
    buyToken: getAddress(d.buyToken),
    receiver: getAddress(d.receiver),
    sellAmount: d.sellAmount,
    buyAmount: d.buyAmount,
    validTo: ETH_FLOW_GPV2_VALID_TO,
    appData: d.appData.toLowerCase(),
    feeAmount: "0",
    kind: "sell",
    partiallyFillable: false,
    sellTokenBalance: "erc20",
    buyTokenBalance: "erc20",
  };
}

/** The digest eth-flow stores the order under, and the UID the orderbook lists it by (owner = the eth-flow contract). */
export function ethFlowOrderId(deployment: CowDeployment, d: EthFlowData): {digest: Hex; uid: Hex} {
  const digest = orderDigest(deployment.chainId, ethFlowGpv2Order(deployment, d));
  return {digest, uid: orderUid(digest, deployment.ethFlow, ETH_FLOW_GPV2_VALID_TO)};
}

/**
 * The order data as one hex string — it rides in the swap's status id, so a refund can be built later with nothing
 * but that id: buyToken (20) ‖ receiver (20) ‖ sellAmount (32) ‖ buyAmount (32) ‖ appData (32) ‖ validTo (4) ‖ quoteId (8).
 */
export function packEthFlowData(d: EthFlowData): string {
  assertData(d);
  const word = (v: bigint, bytes: number) => v.toString(16).padStart(bytes * 2, "0");
  return [
    d.buyToken.slice(2).toLowerCase(),
    d.receiver.slice(2).toLowerCase(),
    word(BigInt(d.sellAmount), 32),
    word(BigInt(d.buyAmount), 32),
    d.appData.slice(2).toLowerCase(),
    word(BigInt(d.validTo), 4),
    word(BigInt(d.quoteId), 8),
  ].join("");
}

/** {@link packEthFlowData} back; null when the text is not one. */
export function unpackEthFlowData(packed: string): EthFlowData | null {
  if (!/^[0-9a-f]{296}$/.test(packed)) return null;
  let at = 0;
  const take = (bytes: number) => packed.slice(at, (at += bytes * 2));
  const quoteWord = (hex: string) => {
    const v = BigInt(`0x${hex}`);
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? parseInt(hex, 16) : -1;
  };
  const d: EthFlowData = {
    buyToken: getAddress(`0x${take(20)}`),
    receiver: getAddress(`0x${take(20)}`),
    sellAmount: BigInt(`0x${take(32)}`).toString(),
    buyAmount: BigInt(`0x${take(32)}`).toString(),
    appData: `0x${take(32)}`,
    validTo: parseInt(take(4), 16),
    quoteId: quoteWord(take(8)),
  };
  try {
    assertData(d);
  } catch {
    return null;
  }
  return d;
}
