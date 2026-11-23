/**
 * The appData document of an order: a small JSON the order commits to by hash (`order.appData` =
 * keccak256 of the document's UTF-8 bytes; the orderbook stores the document and checks the hash).
 *
 * This module writes exactly one shape (github.com/cowprotocol/app-data, schema v1.16.0): the app code, the
 * environment, the quoted slippage and — only when the sell token's allowance comes from an EIP-2612 permit —
 * one pre-hook, the token's own `permit` call. No partner fee, no other hook, no bridging, no flash loan.
 * Keys are written in sorted order, so the same input always gives the same bytes and the same hash.
 */
import {keccak256, stringToHex, type Hex} from "viem";

export const COW_APP_DATA_VERSION = "1.16.0";
export const COW_DEFAULT_APP_CODE = "AnyWalletKit";
/** This module's own bound for a document, in bytes: the largest one it writes (with a permit hook) is about 750. */
export const COW_APP_DATA_MAX_BYTES = 1000;

/** The one hook this module ever writes: the sell token's `permit(...)`, run before the settlement pulls the tokens. */
export interface CowPermitHook {
  /** The sell token. */
  target: string;
  /** `permit(owner, spender, value, deadline, v, r, s)` calldata. */
  callData: string;
  /** Gas the hook may use, decimal. */
  gasLimit: string;
}

export interface CowAppDataInput {
  appCode?: string;
  slippageBps: number;
  permitHook?: CowPermitHook;
}

export interface CowAppData {
  /** The document as posted to the orderbook (`appData` of the quote and of the order creation). */
  json: string;
  /** keccak256 of `json` — `order.appData`. */
  hash: Hex;
}

/** JSON with object keys in sorted order at every level (arrays keep their order). */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** keccak256 of a document's UTF-8 bytes. */
export const appDataHash = (json: string): Hex => keccak256(stringToHex(json));

export function buildAppData(input: CowAppDataInput): CowAppData {
  const appCode = input.appCode ?? COW_DEFAULT_APP_CODE;
  // Printable ASCII without quotes or backslashes: the document stays byte-for-byte what was hashed on every runtime.
  if (!/^[A-Za-z0-9 ._-]{1,50}$/.test(appCode)) throw new Error("cow: appCode must be 1–50 characters of letters, digits, space, dot, dash or underscore");
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 10_000) throw new Error("cow: slippage must be whole basis points in 0..10000");
  const hook = input.permitHook;
  if (hook) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(hook.target)) throw new Error("cow: the permit hook target must be an address");
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(hook.callData)) throw new Error("cow: the permit hook calldata must be hex bytes");
    if (!/^[1-9][0-9]{0,8}$/.test(hook.gasLimit)) throw new Error("cow: the permit hook gas limit must be a positive decimal");
  }
  const doc = {
    appCode,
    environment: "production",
    metadata: {
      ...(hook ? {hooks: {pre: [{callData: hook.callData.toLowerCase(), gasLimit: hook.gasLimit, target: hook.target.toLowerCase()}]}} : {}),
      quote: {slippageBips: input.slippageBps},
    },
    version: COW_APP_DATA_VERSION,
  };
  const json = stableJson(doc);
  // The document is ASCII by construction, so its length is its byte size.
  if (json.length > COW_APP_DATA_MAX_BYTES) throw new Error(`cow: the appData document is ${json.length} bytes, over this module's ${COW_APP_DATA_MAX_BYTES}-byte bound`);
  return {json, hash: appDataHash(json)};
}
