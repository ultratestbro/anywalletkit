/**
 * CoW Protocol (GPv2) typed data the engine signs: the order, the EIP-2612 permit that funds it, and
 * the off-chain cancellation. Each is bound to the swap field by field before the account sees it —
 * the provider's own checks come first, these are the engine's, on the exact payload that is signed.
 *
 * The settlement contract and its vault relayer are the canonical deployments (same address on every
 * chain CoW Protocol lists them for); an order for any other verifying contract, or an allowance for
 * any other spender, is refused.
 */
import {Swap2ValidationError} from "../errors.js";

/** GPv2Settlement — the EIP-712 verifying contract of every order and cancellation. */
export const GPV2_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
/** GPv2VaultRelayer — the only spender a CoW order's sell token is approved (or permitted) for. */
export const GPV2_VAULT_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110";
/** The buy-token marker for "pay the chain's native coin to the receiver". */
export const GPV2_NATIVE_BUY = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
/** EIP-712 domain name and version of GPv2Settlement. */
export const GPV2_DOMAIN_NAME = "Gnosis Protocol";
export const GPV2_DOMAIN_VERSION = "v2";
/** The longest order lifetime the engine signs (the module's own default is 20 minutes). */
export const GPV2_MAX_VALIDITY_SECONDS = 3 * 60 * 60;

/** `GPv2Order.Data` as EIP-712 fields, in the contract's order. */
export const GPV2_ORDER_FIELDS = [
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

/** EIP-2612 `Permit`. */
export const EIP2612_PERMIT_FIELDS = [
  {name: "owner", type: "address"},
  {name: "spender", type: "address"},
  {name: "value", type: "uint256"},
  {name: "nonce", type: "uint256"},
  {name: "deadline", type: "uint256"},
] as const;

/** The orderbook's off-chain cancellation message. */
export const GPV2_CANCELLATIONS_FIELDS = [{name: "orderUids", type: "bytes[]"}] as const;

const DOMAIN_FIELDS = [
  {name: "name", type: "string"},
  {name: "version", type: "string"},
  {name: "chainId", type: "uint256"},
  {name: "verifyingContract", type: "address"},
] as const;

type Fields = readonly {name: string; type: string}[];
interface Typed {domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown>}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const same = (a: unknown, b: string) => typeof a === "string" && ADDRESS.test(a) && a.toLowerCase() === b.toLowerCase();
const sameFields = (got: unknown, want: Fields) =>
  Array.isArray(got) && got.length === want.length && want.every((f, i) => {
    const g = got[i] as {name?: unknown; type?: unknown} | null;
    return !!g && typeof g === "object" && Object.keys(g).length === 2 && g.name === f.name && g.type === f.type;
  });
const sameKeys = (o: Record<string, unknown>, want: Fields) => {
  const keys = Object.keys(o);
  return keys.length === want.length && want.every((f) => Object.prototype.hasOwnProperty.call(o, f.name));
};
const uint = (v: unknown): bigint | null => (typeof v === "string" && DECIMAL.test(v) ? BigInt(v) : null);

function parse(json: string, fail: (why: string) => Error): Typed {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw fail("the typed data is not JSON"); }
  const td = parsed as Partial<Typed> | null;
  if (!td || typeof td !== "object" || Array.isArray(td)) throw fail("the typed data is not an object");
  const obj = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
  if (!obj(td.domain) || !obj(td.types) || !obj(td.message) || typeof td.primaryType !== "string") throw fail("the typed data is malformed");
  return td as Typed;
}

/** Only the primary type (and, optionally, the standard `EIP712Domain`) may be declared: no nested or shadow types. */
function assertTypes(td: Typed, primary: string, fields: Fields, domainFields: Fields, fail: (why: string) => Error): void {
  if (td.primaryType !== primary) throw fail(`primaryType ${td.primaryType} is not ${primary}`);
  for (const key of Object.keys(td.types)) {
    if (key !== primary && key !== "EIP712Domain") throw fail(`unexpected type ${key}`);
  }
  if (!sameFields(td.types[primary], fields)) throw fail(`the ${primary} type is not the canonical one`);
  if (td.types.EIP712Domain !== undefined && !sameFields(td.types.EIP712Domain, domainFields)) throw fail("the EIP712Domain type does not match the domain");
}

function assertGpv2Domain(td: Typed, chainId: number | null, fail: (why: string) => Error): void {
  const d = td.domain;
  if (!sameKeys(d, DOMAIN_FIELDS)) throw fail("the domain is not {name, version, chainId, verifyingContract}");
  if (d.name !== GPV2_DOMAIN_NAME || d.version !== GPV2_DOMAIN_VERSION) throw fail("the domain is not GPv2Settlement's");
  if (chainId === null || typeof d.chainId !== "number" || d.chainId !== chainId) throw fail("the domain chainId is not the source chain");
  if (!same(d.verifyingContract, GPV2_SETTLEMENT)) throw fail(`verifyingContract ${String(d.verifyingContract)} is not GPv2Settlement`);
}

/** True for typed data whose `Order` type is GPv2's (it declares `sellToken`), so the GPv2 gate applies. */
export function isGpv2Order(typedData: string): boolean {
  try {
    const td = JSON.parse(typedData) as {types?: {Order?: unknown}} | null;
    const fields = td?.types?.Order;
    return Array.isArray(fields) && fields.some((f: {name?: unknown} | null) => f?.name === "sellToken");
  } catch {
    return false;
  }
}

export interface Gpv2OrderExpectation {
  /** The signing account. */
  self: string;
  /** Source token contract (a GPv2 order never sells the native coin). */
  token: string | undefined;
  /** Exact input, base units. */
  amount: string;
  chainId: number | null;
  /** The reviewed recipient of the output. */
  recipient: string;
  /** Destination token as the swap names it; an all-zero address is the native coin. */
  destToken: string;
  /** The quote's minimum output, base units. */
  minDest: string;
  /** Unix seconds. */
  now: number;
}

/**
 * A GPv2 order is signed only when it sells exactly the swap's input of the source token for at least
 * the quoted minimum of the destination token, pays the reviewed recipient, carries no fee, is a
 * fill-or-kill sell from and to plain ERC-20 balances, expires soon, and is for GPv2Settlement on the
 * source chain with the vault relayer as the spender. Returns the order's `validTo` and `appData`.
 */
export function assertGpv2Order(typedData: string, approvalAddress: string | undefined, e: Gpv2OrderExpectation): {validTo: number; appData: string; message: Record<string, unknown>} {
  const fail = (why: string) => new Swap2ValidationError(`swap2: CoW order refused — ${why}`);
  const td = parse(typedData, fail);
  assertTypes(td, "Order", GPV2_ORDER_FIELDS, DOMAIN_FIELDS, fail);
  assertGpv2Domain(td, e.chainId, fail);
  if (!approvalAddress || !same(approvalAddress, GPV2_VAULT_RELAYER)) throw fail(`the spender ${String(approvalAddress)} is not the GPv2 vault relayer`);
  const m = td.message;
  if (!sameKeys(m, GPV2_ORDER_FIELDS)) throw fail("the order has missing or extra fields");
  if (!e.token || !same(m.sellToken, e.token)) throw fail("the sellToken is not the source token");
  const nativeOut = /^0x0+$/.test(e.destToken);
  if (!same(m.buyToken, nativeOut ? GPV2_NATIVE_BUY : e.destToken)) throw fail("the buyToken is not the destination token");
  if (!same(m.receiver, e.recipient) || /^0x0+$/.test(String(m.receiver))) throw fail("the receiver is not the swap's recipient");
  const sell = uint(m.sellAmount);
  if (sell === null || sell !== BigInt(e.amount)) throw fail(`sellAmount ${String(m.sellAmount)} is not the swap's ${e.amount}`);
  const buy = uint(m.buyAmount);
  const floor = BigInt(e.minDest);
  if (buy === null || buy <= 0n || floor <= 0n || buy < floor) throw fail(`buyAmount ${String(m.buyAmount)} is below the quoted minimum ${e.minDest}`);
  if (uint(m.feeAmount) !== 0n) throw fail("the order carries a signed fee");
  if (m.kind !== "sell") throw fail("the order is not a sell order");
  if (m.partiallyFillable !== false) throw fail("the order is partially fillable");
  if (m.sellTokenBalance !== "erc20" || m.buyTokenBalance !== "erc20") throw fail("the order uses internal vault balances");
  if (typeof m.appData !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(m.appData)) throw fail("appData is not a 32-byte hash");
  const validTo = m.validTo;
  if (typeof validTo !== "number" || !Number.isSafeInteger(validTo) || validTo <= e.now || validTo > e.now + GPV2_MAX_VALIDITY_SECONDS || validTo >= 0xffffffff) {
    throw fail(`validTo ${String(validTo)} is not a near-future expiry`);
  }
  return {validTo, appData: m.appData.toLowerCase(), message: m};
}

export interface Gpv2PermitExpectation {
  self: string;
  token: string;
  /** The allowance the permit grants — never more than the engine would approve on-chain. */
  value: bigint;
  chainId: number | null;
  /** The order's `validTo`: the permit expires with the order it funds. */
  deadline: number;
}

/**
 * The EIP-2612 permit that replaces the approval transaction: this account as the owner, the GPv2 vault
 * relayer as the spender, the exact allowance, a deadline equal to the order's expiry, verified by the
 * source token on the source chain. Returns the allowance and the deadline.
 */
export function assertGpv2Permit(typedData: string, e: Gpv2PermitExpectation): {amount: bigint; deadline: number} {
  const fail = (why: string) => new Swap2ValidationError(`swap2: CoW permit refused — ${why}`);
  const td = parse(typedData, fail);
  const d = td.domain;
  const keys = Object.keys(d);
  const allowed = ["name", "version", "chainId", "verifyingContract"];
  if (keys.some((k) => !allowed.includes(k)) || typeof d.name !== "string" || (d.version !== undefined && typeof d.version !== "string")) throw fail("the domain is not an EIP-2612 token domain");
  const domainFields = DOMAIN_FIELDS.filter((f) => f.name !== "version" || d.version !== undefined);
  assertTypes(td, "Permit", EIP2612_PERMIT_FIELDS, domainFields, fail);
  if (e.chainId === null || typeof d.chainId !== "number" || d.chainId !== e.chainId) throw fail("the domain chainId is not the source chain");
  if (!same(d.verifyingContract, e.token)) throw fail("the verifying contract is not the source token");
  const m = td.message;
  if (!sameKeys(m, EIP2612_PERMIT_FIELDS)) throw fail("the permit has missing or extra fields");
  if (!same(m.owner, e.self)) throw fail("the owner is not this account");
  if (!same(m.spender, GPV2_VAULT_RELAYER)) throw fail(`the spender ${String(m.spender)} is not the GPv2 vault relayer`);
  const value = uint(m.value);
  if (value === null || value !== e.value) throw fail(`the value ${String(m.value)} is not the swap's allowance ${e.value}`);
  if (uint(m.nonce) === null) throw fail("the nonce is not a number");
  const deadline = uint(m.deadline);
  if (deadline === null || deadline !== BigInt(e.deadline)) throw fail("the deadline is not the order's expiry");
  return {amount: value, deadline: e.deadline};
}

/**
 * The orderbook's off-chain cancellation: GPv2Settlement's domain on the order's chain, and nothing but
 * order UIDs this account owns (a UID is digest ‖ owner ‖ validTo). Returns the UIDs.
 */
export function assertGpv2Cancellation(typedData: string, e: {self: string; chainId: number | null}): string[] {
  const fail = (why: string) => new Swap2ValidationError(`swap2: CoW cancellation refused — ${why}`);
  const td = parse(typedData, fail);
  assertTypes(td, "OrderCancellations", GPV2_CANCELLATIONS_FIELDS, DOMAIN_FIELDS, fail);
  assertGpv2Domain(td, e.chainId, fail);
  const m = td.message;
  if (!sameKeys(m, GPV2_CANCELLATIONS_FIELDS)) throw fail("the message has missing or extra fields");
  const uids = m.orderUids;
  if (!Array.isArray(uids) || uids.length === 0 || uids.length > 128) throw fail("it names no order");
  const self = e.self.toLowerCase().replace(/^0x/, "");
  for (const uid of uids) {
    if (typeof uid !== "string" || !/^0x[0-9a-fA-F]{112}$/.test(uid)) throw fail("an order UID is not 56 bytes");
    if (uid.slice(66, 106).toLowerCase() !== self) throw fail("an order does not belong to this account");
  }
  return uids as string[];
}
