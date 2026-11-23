/**
 * The GPv2 order as EIP-712 typed data, its digest and its UID — written from the contracts
 * (github.com/cowprotocol/contracts `GPv2Order.sol`, `GPv2Signing.sol`). Orders are signed as typed data only:
 * there is no `eth_sign` path in this module, an account never sees a bare 32-byte digest.
 */
import {concat, encodeAbiParameters, getAddress, hashTypedData, keccak256, numberToHex, stringToHex, type Hex} from "viem";
import {COW_SETTLEMENT} from "./deployments.js";

export const COW_DOMAIN_NAME = "Gnosis Protocol";
export const COW_DOMAIN_VERSION = "v2";
/** `GPv2Order.TYPE_HASH`. */
export const COW_ORDER_TYPE_HASH = "0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489";

const DOMAIN_TYPE = [
  {name: "name", type: "string"},
  {name: "version", type: "string"},
  {name: "chainId", type: "uint256"},
  {name: "verifyingContract", type: "address"},
] as const;
/** `GPv2Order.Data` in the contract's field order. */
export const COW_ORDER_TYPE = [
  {name: "sellToken", type: "address"},
  {name: "buyToken", type: "address"},
  {name: "receiver", type: "address"},
  {name: "sellAmount", type: "uint256"},
  {name: "buyAmount", type: "uint256"},
  {name: "validTo", type: "uint32"},
  {name: "appData", type: "bytes32"},
  {name: "feeAmount", type: "uint256"},
  {name: "kind", type: "string"},
  {name: "partiallyFillable", type: "bool"},
  {name: "sellTokenBalance", type: "string"},
  {name: "buyTokenBalance", type: "string"},
] as const;
const CANCELLATIONS_TYPE = [{name: "orderUids", type: "bytes[]"}] as const;

/** A fill-or-kill sell order with ERC-20 balances — the only shape this module signs. */
export interface CowOrder {
  sellToken: string;
  buyToken: string;
  receiver: string;
  /** Base units, decimal. */
  sellAmount: string;
  /** Base units, decimal: the least the receiver accepts. */
  buyAmount: string;
  /** Unix seconds. */
  validTo: number;
  /** keccak256 of the appData document. */
  appData: string;
  /** Always "0": the fee is taken from the surplus, never signed for. */
  feeAmount: "0";
  kind: "sell";
  partiallyFillable: false;
  sellTokenBalance: "erc20";
  buyTokenBalance: "erc20";
}

export interface CowTypedData<M> {
  domain: {name: string; version: string; chainId: number; verifyingContract: string};
  types: Record<string, readonly {name: string; type: string}[]>;
  primaryType: string;
  message: M;
}

/** The GPv2Settlement EIP-712 domain of `chainId`. */
export function cowDomain(chainId: number): CowTypedData<never>["domain"] {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("cow: chain id must be a positive integer");
  return {name: COW_DOMAIN_NAME, version: COW_DOMAIN_VERSION, chainId, verifyingContract: COW_SETTLEMENT};
}

/** `GPv2Settlement.domainSeparator()` of `chainId`, computed locally. */
export function cowDomainSeparator(chainId: number): Hex {
  const d = cowDomain(chainId);
  return keccak256(encodeAbiParameters(
    [{type: "bytes32"}, {type: "bytes32"}, {type: "bytes32"}, {type: "uint256"}, {type: "address"}],
    [
      keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
      keccak256(stringToHex(d.name)),
      keccak256(stringToHex(d.version)),
      BigInt(chainId),
      getAddress(d.verifyingContract),
    ],
  ));
}

/** The typed data an account signs for `order` (`eth_signTypedData_v4`). */
export function orderTypedData(chainId: number, order: CowOrder): CowTypedData<CowOrder> {
  return {domain: cowDomain(chainId), types: {EIP712Domain: DOMAIN_TYPE, Order: COW_ORDER_TYPE}, primaryType: "Order", message: {...order}};
}

/** Any GPv2 order as the orderbook lists it — other kinds, fees and balances included. */
export interface CowRawOrder {
  sellToken: string;
  buyToken: string;
  /** Null (or absent) is the zero address in the signed struct: "pay the owner". */
  receiver?: string | null;
  sellAmount: string;
  buyAmount: string;
  validTo: number;
  appData: string;
  feeAmount: string;
  kind: string;
  partiallyFillable: boolean;
  sellTokenBalance: string;
  buyTokenBalance: string;
}

/**
 * The digest of any GPv2 order — used to check that an order the orderbook lists is the one its UID names (the
 * orders this module signs go through {@link orderDigest}).
 */
export function rawOrderDigest(chainId: number, order: CowRawOrder): Hex {
  return hashTypedData({
    domain: {...cowDomain(chainId), verifyingContract: COW_SETTLEMENT as Hex},
    types: {Order: COW_ORDER_TYPE},
    primaryType: "Order",
    message: {
      sellToken: getAddress(order.sellToken),
      buyToken: getAddress(order.buyToken),
      receiver: getAddress(order.receiver ?? "0x0000000000000000000000000000000000000000"),
      sellAmount: BigInt(order.sellAmount),
      buyAmount: BigInt(order.buyAmount),
      validTo: order.validTo,
      appData: order.appData as Hex,
      feeAmount: BigInt(order.feeAmount),
      kind: order.kind,
      partiallyFillable: order.partiallyFillable,
      sellTokenBalance: order.sellTokenBalance,
      buyTokenBalance: order.buyTokenBalance,
    },
  });
}

/** The order digest GPv2Settlement recovers the signer from. */
export function orderDigest(chainId: number, order: CowOrder): Hex {
  return rawOrderDigest(chainId, order);
}

/** The order UID: digest (32 bytes) ‖ owner (20) ‖ validTo (4, big-endian) — `GPv2Order.packOrderUidParams`. */
export function orderUid(digest: string, owner: string, validTo: number): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) throw new Error("cow: order digest must be 32 bytes");
  if (!Number.isInteger(validTo) || validTo < 0 || validTo > 0xffffffff) throw new Error("cow: validTo must fit uint32");
  return concat([digest.toLowerCase() as Hex, getAddress(owner).toLowerCase() as Hex, numberToHex(validTo, {size: 4})]);
}

const UID = /^0x[0-9a-fA-F]{112}$/;
/** True for a 56-byte order UID. */
export const isOrderUid = (uid: unknown): uid is string => typeof uid === "string" && UID.test(uid);

/** The parts of a UID (lowercase hex). */
export function splitOrderUid(uid: string): {digest: Hex; owner: Hex; validTo: number} {
  if (!isOrderUid(uid)) throw new Error("cow: order UID must be 56 bytes");
  const hex = uid.slice(2).toLowerCase();
  return {digest: `0x${hex.slice(0, 64)}`, owner: `0x${hex.slice(64, 104)}`, validTo: parseInt(hex.slice(104), 16)};
}

/** The orderbook's off-chain cancellation message for `uids` (signed under the GPv2Settlement domain). */
export function cancellationTypedData(chainId: number, uids: readonly string[]): CowTypedData<{orderUids: string[]}> {
  if (!uids.length || !uids.every(isOrderUid)) throw new Error("cow: a cancellation names at least one 56-byte order UID");
  return {domain: cowDomain(chainId), types: {EIP712Domain: DOMAIN_TYPE, OrderCancellations: CANCELLATIONS_TYPE}, primaryType: "OrderCancellations", message: {orderUids: uids.map((u) => u.toLowerCase())}};
}

/** The digest of {@link cancellationTypedData}. */
export function cancellationDigest(chainId: number, uids: readonly string[]): Hex {
  const td = cancellationTypedData(chainId, uids);
  return hashTypedData({domain: {...td.domain, verifyingContract: COW_SETTLEMENT as Hex}, types: {OrderCancellations: CANCELLATIONS_TYPE}, primaryType: "OrderCancellations", message: {orderUids: td.message.orderUids as Hex[]}});
}
