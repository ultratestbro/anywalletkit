/**
 * Permit2 signature transfers as a swap's payment (`UnsignedTx.permit2Transfer`).
 *
 * A router that pulls the input through Permit2's `permitTransferFrom` (0x Settler) needs one
 * EIP-712 signature per swap: a `PermitTransferFrom` naming the token, the amount, the spender
 * (the router) and a one-time nonce. The signature travels inside the swap's own calldata, and
 * Permit2 takes the token from the `msg.sender` of the router call — so it is worth something only
 * in a transaction this account sends itself.
 *
 * What a backend or an API says the account should sign is never signed as given. This file reads
 * the payload strictly, holds every field to the swap, and returns a payload REBUILT from local
 * constants (domain, types) and the checked values; that rebuilt payload is what goes to
 * `signTypedData`.
 */
import {Swap2ValidationError} from "./errors.js";

/** Canonical Permit2 — the same address on every chain it is deployed to. */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** The longest a swap's Permit2 signature may stay valid from now. 0x signs about five minutes ahead. */
export const PERMIT2_MAX_DEADLINE_SECONDS = 3600;

/** The Permit2 `PermitTransferFrom` schema (no witness), field order as in the contract's type hash. */
export const PERMIT2_TRANSFER_TYPES = Object.freeze({
  PermitTransferFrom: Object.freeze([
    Object.freeze({name: "permitted", type: "TokenPermissions"}),
    Object.freeze({name: "spender", type: "address"}),
    Object.freeze({name: "nonce", type: "uint256"}),
    Object.freeze({name: "deadline", type: "uint256"}),
  ]),
  TokenPermissions: Object.freeze([
    Object.freeze({name: "token", type: "address"}),
    Object.freeze({name: "amount", type: "uint256"}),
  ]),
});
const DOMAIN_TYPE = [
  {name: "name", type: "string"},
  {name: "chainId", type: "uint256"},
  {name: "verifyingContract", type: "address"},
];

/** What the swap allows the signature to say. */
export interface Permit2TransferExpectation {
  /** EVM chain id of the source chain. */
  chainId: number;
  /** The source token (ERC-20). */
  token: string;
  /** Exactly the swap's input, base units. */
  amount: bigint;
  /** The contract the swap calls — the only address that may pull through this signature. */
  spender: string;
  /** Clock for the deadline check (tests); defaults to `Date.now()`. */
  nowMs?: number;
}

/** A checked `PermitTransferFrom`, rebuilt locally: `domain`, `types`, `primaryType` and `message` go to `signTypedData`. */
export interface Permit2Transfer {
  domain: {name: "Permit2"; chainId: number; verifyingContract: string};
  types: typeof PERMIT2_TRANSFER_TYPES;
  primaryType: "PermitTransferFrom";
  /** uint256 values as decimal strings. */
  message: {permitted: {token: string; amount: string}; spender: string; nonce: string; deadline: string};
  nonce: bigint;
  /** Unix seconds. */
  deadline: bigint;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT256_MAX = (1n << 256n) - 1n;

function uint(v: unknown): bigint | null {
  if (typeof v === "string" && /^(?:0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(v)) {
    const n = BigInt(v);
    return n <= UINT256_MAX ? n : null;
  }
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
}
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]) => {
  const have = Object.keys(o);
  return have.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
const sameFields = (got: unknown, want: readonly {name: string; type: string}[]) =>
  Array.isArray(got) && got.length === want.length && got.every((f: unknown, i) => plain(f) && onlyKeys(f, ["name", "type"]) && f.name === want[i]!.name && f.type === want[i]!.type);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Read a JSON EIP-712 `PermitTransferFrom` and hold it to the swap; throws {@link Swap2ValidationError} for anything
 * else. Accepted: exactly the Permit2 schema (no witness, no extra types or fields), the Permit2 domain on
 * `expected.chainId` with the canonical contract, the expected token, EXACTLY the expected amount, the expected
 * spender, a uint256 nonce, and a deadline in the future but no further than {@link PERMIT2_MAX_DEADLINE_SECONDS}.
 */
export function readPermit2Transfer(json: string, expected: Permit2TransferExpectation): Permit2Transfer {
  const fail = (why: string) => new Swap2ValidationError(`swap2: Permit2 transfer refused — ${why}`);
  if (typeof json !== "string" || json.length > 20_000) throw fail("the typed data is not a JSON string of a sane size");
  if (!Number.isSafeInteger(expected.chainId) || expected.chainId <= 0) throw fail("the source chain has no EVM chain id");
  if (!ADDRESS.test(expected.token) || !ADDRESS.test(expected.spender)) throw fail("the swap names no token or no spender");
  if (expected.amount <= 0n || expected.amount > UINT256_MAX) throw fail("the swap amount is not a positive uint256");
  if (same(expected.spender, PERMIT2_ADDRESS) || same(expected.spender, expected.token) || /^0x0{40}$/.test(expected.spender)) {
    throw fail("the spender is Permit2, the token itself or the zero address");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw fail("the typed data is not JSON"); }
  if (!plain(parsed) || !onlyKeys(parsed, ["domain", "types", "primaryType", "message"])) throw fail("the typed data is not {domain, types, primaryType, message}");
  if (parsed.primaryType !== "PermitTransferFrom") throw fail(`primaryType ${String(parsed.primaryType).slice(0, 40)} is not PermitTransferFrom`);

  const types = parsed.types;
  if (!plain(types)) throw fail("it carries no types");
  for (const name of Object.keys(types)) {
    if (name !== "EIP712Domain" && name !== "PermitTransferFrom" && name !== "TokenPermissions") throw fail(`unexpected type ${name.slice(0, 40)} (witness transfers are not signed)`);
  }
  if (!sameFields(types.PermitTransferFrom, PERMIT2_TRANSFER_TYPES.PermitTransferFrom) || !sameFields(types.TokenPermissions, PERMIT2_TRANSFER_TYPES.TokenPermissions)) {
    throw fail("the types are not Permit2's PermitTransferFrom / TokenPermissions");
  }
  if (types.EIP712Domain !== undefined && !sameFields(types.EIP712Domain, DOMAIN_TYPE)) throw fail("the EIP712Domain type is not Permit2's");

  const domain = parsed.domain;
  if (!plain(domain) || !onlyKeys(domain, ["name", "chainId", "verifyingContract"])) throw fail("the domain is not {name, chainId, verifyingContract}");
  if (domain.name !== "Permit2") throw fail("the domain name is not Permit2");
  if (uint(domain.chainId) !== BigInt(expected.chainId)) throw fail(`the domain chainId is not the source chain ${expected.chainId}`);
  if (typeof domain.verifyingContract !== "string" || !same(domain.verifyingContract, PERMIT2_ADDRESS)) throw fail("the verifying contract is not Permit2");

  const message = parsed.message;
  if (!plain(message) || !onlyKeys(message, ["permitted", "spender", "nonce", "deadline"])) throw fail("the message is not {permitted, spender, nonce, deadline}");
  const permitted = message.permitted;
  if (!plain(permitted) || !onlyKeys(permitted, ["token", "amount"])) throw fail("the message permits something other than {token, amount}");
  if (typeof permitted.token !== "string" || !ADDRESS.test(permitted.token) || !same(permitted.token, expected.token)) throw fail("the permitted token is not the source token");
  const amount = uint(permitted.amount);
  if (amount === null || amount !== expected.amount) throw fail(`the permitted amount is not the swap's ${expected.amount}`);
  if (typeof message.spender !== "string" || !ADDRESS.test(message.spender) || !same(message.spender, expected.spender)) throw fail("the spender is not the contract the swap calls");
  const nonce = uint(message.nonce);
  if (nonce === null) throw fail("the nonce is not a uint256");
  const deadline = uint(message.deadline);
  const now = BigInt(Math.floor((expected.nowMs ?? Date.now()) / 1000));
  if (deadline === null || deadline <= now) throw fail("the deadline has passed or is not a uint256");
  if (deadline > now + BigInt(PERMIT2_MAX_DEADLINE_SECONDS)) throw fail(`the deadline is more than ${PERMIT2_MAX_DEADLINE_SECONDS} s away`);

  return {
    domain: {name: "Permit2", chainId: expected.chainId, verifyingContract: PERMIT2_ADDRESS},
    types: PERMIT2_TRANSFER_TYPES,
    primaryType: "PermitTransferFrom",
    message: {
      permitted: {token: permitted.token, amount: amount.toString()},
      spender: message.spender,
      nonce: nonce.toString(),
      deadline: deadline.toString(),
    },
    nonce,
    deadline,
  };
}

/** The canonical JSON of a checked transfer (EIP712Domain type included, as wallets expect on the wire). */
export function permit2TransferJson(t: Pick<Permit2Transfer, "domain" | "message">): string {
  return JSON.stringify({
    domain: {name: t.domain.name, chainId: t.domain.chainId, verifyingContract: t.domain.verifyingContract},
    types: {EIP712Domain: DOMAIN_TYPE, PermitTransferFrom: PERMIT2_TRANSFER_TYPES.PermitTransferFrom, TokenPermissions: PERMIT2_TRANSFER_TYPES.TokenPermissions},
    primaryType: "PermitTransferFrom",
    message: {
      permitted: {token: t.message.permitted.token, amount: t.message.permitted.amount},
      spender: t.message.spender,
      nonce: t.message.nonce,
      deadline: t.message.deadline,
    },
  });
}

/**
 * `calldata ++ uint256(signature length) ++ signature` — where a 0x Settler quote expects the Permit2 signature
 * (its first action's `sig` offset points at the end of the calldata the API returned). A signature is 64–65 bytes
 * for an EOA; a contract account's may be longer, up to 2048 bytes here.
 */
export function appendPermit2Signature(data: string, signature: string): string {
  if (!/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(data)) throw new Swap2ValidationError("swap2: Permit2 transfer refused — the calldata is not hex bytes");
  if (typeof signature !== "string" || !/^0x(?:[0-9a-fA-F]{2}){64,2048}$/.test(signature)) {
    throw new Swap2ValidationError("swap2: Permit2 transfer refused — the account returned no usable signature");
  }
  const length = ((signature.length - 2) / 2).toString(16).padStart(64, "0");
  return `${data}${length}${signature.slice(2)}`;
}
