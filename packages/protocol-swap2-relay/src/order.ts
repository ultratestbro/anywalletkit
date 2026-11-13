/**
 * A Relay order, read strictly, hashed and attributed here.
 *
 *  - The order id is the EIP-712 `hashStruct` of the order under {@link RELAY_ORDER_TYPES} (no domain separator), as
 *    github.com/relayprotocol/relay-protocol-sdk (src/order/index.ts) computes it. Chain ids are STRINGS (Relay's own
 *    chain names), addresses and currencies are `bytes` (20 raw bytes on an EVM chain).
 *  - `orderSignature` is the solver's EIP-191 `personal_sign` over the 32 raw bytes of that id.
 *
 * The id a deposit names is a commitment to everything in the order — recipient, chain, token, minimum, refunds — so
 * recomputing it from the order the API hands over, and reading that same parsed order, is what binds the deposit
 * to terms the device has seen.
 */
import {secp256k1} from "@noble/curves/secp256k1.js";
import {withReason, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import {hashMessage, hashStruct, hexToBytes, keccak256, type Hex} from "viem";

/** Why an order, a quote or a deposit was refused. One code per check; the message says what was found. */
export type RelayRefusalCode =
  | "request-invalid"
  | "chain-unsupported"
  | "protocol-data-missing"
  | "hub-type"
  | "order-malformed"
  | "order-version"
  | "order-inputs"
  | "order-payments"
  | "order-calls"
  | "order-fees"
  | "solver-not-pinned"
  | "input-chain"
  | "input-currency"
  | "input-amount"
  | "input-weight"
  | "output-chain"
  | "output-recipient"
  | "output-currency"
  | "output-minimum"
  | "output-expected"
  | "output-deadline"
  | "refund-missing"
  | "refund-chain"
  | "refund-recipient"
  | "refund-currency"
  | "refund-deadline"
  | "order-id-mismatch"
  | "signature-invalid"
  | "payment-details"
  | "tx-chain"
  | "tx-target"
  | "tx-selector"
  | "tx-calldata"
  | "tx-depositor"
  | "tx-token"
  | "tx-amount"
  | "tx-id"
  | "tx-value"
  | "order-reused"
  | "app-fee"
  | "gas-topup"
  | "quote-gas"
  | "quote-expiry"
  | "quote-steps"
  | "quote-amounts"
  | "quote-approval"
  | "quote-shape";

/**
 * `code` names the check; `reason` (a `Swap2RefusalReason` from `@anywalletkit/protocol-swap2-core`) is the stable
 * classification an app switches on. It is set where the refusal is raised, so one code can carry different reasons
 * (an order deadline too far ahead is `policy_refused`, one already used up is `quote_expired`); a malformed request
 * from the caller (a programming error) carries none.
 */
export class RelayRefusal extends Error {
  readonly code: RelayRefusalCode;
  declare readonly reason?: Swap2RefusalReason;
  constructor(code: RelayRefusalCode, detail: string, reason?: Swap2RefusalReason) {
    super(`relay: ${detail} [${code}]`);
    this.name = "RelayRefusal";
    this.code = code;
    if (reason !== undefined) withReason(this, reason);
  }
}

export const RELAY_ORDER_TYPES = {
  Order: [
    {name: "version", type: "string"},
    {name: "solverChainId", type: "string"},
    {name: "solver", type: "address"},
    {name: "salt", type: "uint256"},
    {name: "inputs", type: "Input[]"},
    {name: "output", type: "Output"},
    {name: "fees", type: "Fee[]"},
  ],
  Input: [
    {name: "payment", type: "InputPayment"},
    {name: "refunds", type: "InputRefund[]"},
  ],
  InputPayment: [
    {name: "chainId", type: "string"},
    {name: "currency", type: "bytes"},
    {name: "amount", type: "uint256"},
    {name: "weight", type: "uint256"},
  ],
  InputRefund: [
    {name: "chainId", type: "string"},
    {name: "recipient", type: "bytes"},
    {name: "currency", type: "bytes"},
    {name: "minimumAmount", type: "uint256"},
    {name: "deadline", type: "uint32"},
    {name: "extraData", type: "bytes"},
  ],
  Output: [
    {name: "chainId", type: "string"},
    {name: "payments", type: "OutputPayment[]"},
    {name: "deadline", type: "uint32"},
    {name: "calls", type: "bytes[]"},
    {name: "extraData", type: "bytes"},
  ],
  OutputPayment: [
    {name: "recipient", type: "bytes"},
    {name: "currency", type: "bytes"},
    {name: "minimumAmount", type: "uint256"},
    {name: "expectedAmount", type: "uint256"},
  ],
  Fee: [
    {name: "recipientChainId", type: "string"},
    {name: "recipient", type: "bytes"},
    {name: "currencyChainId", type: "string"},
    {name: "currency", type: "bytes"},
    {name: "amount", type: "uint256"},
  ],
} as const;

export interface RelayInputRefund {chainId: string; recipient: Hex; currency: Hex; minimumAmount: bigint; deadline: number; extraData: Hex}
export interface RelayInput {payment: {chainId: string; currency: Hex; amount: bigint; weight: bigint}; refunds: RelayInputRefund[]}
export interface RelayOutputPayment {recipient: Hex; currency: Hex; minimumAmount: bigint; expectedAmount: bigint}
export interface RelayFee {recipientChainId: string; recipient: Hex; currencyChainId: string; currency: Hex; amount: bigint}
/** An order after {@link parseRelayOrder}: hex lowercased, integers exact. Every field below is hashed into the id. */
export interface RelayOrder {
  version: string;
  solverChainId: string;
  solver: Hex;
  salt: bigint;
  inputs: RelayInput[];
  output: {chainId: string; payments: RelayOutputPayment[]; deadline: number; calls: Hex[]; extraData: Hex};
  fees: RelayFee[];
}

const MAX_LIST = 8;
const MAX_BYTES_HEX = 2 + 2 * 1024;
const MAX_TEXT = 64;
const U256_MAX = (1n << 256n) - 1n;

// The answer is not the documented shape.
const bad = (what: string): never => { throw new RelayRefusal("order-malformed", `the order's ${what}`, "upstream_unavailable"); };

function rec(v: unknown, what: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) bad(`${what} is not an object`);
  return v as Record<string, unknown>;
}
function list(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) bad(`${what} is not a list`);
  if ((v as unknown[]).length > MAX_LIST) bad(`${what} has more than ${MAX_LIST} entries`);
  return v as unknown[];
}
/** Own property only: a field missing from the JSON is never read off a prototype. */
function own(o: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}
function text(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_TEXT) bad(`${what} is not a short string`);
  return v as string;
}
/** `bytes`: 0x-hex of whole bytes, lowercased. */
function bytes(v: unknown, what: string): Hex {
  if (typeof v !== "string" || v.length > MAX_BYTES_HEX || !/^0x(?:[0-9a-fA-F]{2})*$/.test(v)) bad(`${what} is not hex bytes`);
  return (v as string).toLowerCase() as Hex;
}
/** `uint256`: a decimal string, a 0x-hex string (Relay writes the salt that way) or a safe non-negative integer. */
function uint(v: unknown, what: string, max: bigint = U256_MAX): bigint {
  let n: bigint | null = null;
  if (typeof v === "string" && (/^(?:0|[1-9]\d{0,77})$/.test(v) || /^0x[0-9a-fA-F]{1,64}$/.test(v))) n = BigInt(v);
  else if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) n = BigInt(v);
  if (n === null || n > max) bad(`${what} is not an unsigned integer in range`);
  return n as bigint;
}
function uint32(v: unknown, what: string): number {
  // Below 2^32, so the conversion is exact.
  return parseInt(uint(v, what, 0xffff_ffffn).toString(10), 10);
}
function address(v: unknown, what: string): Hex {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) bad(`${what} is not an address`);
  return (v as string).toLowerCase() as Hex;
}

/**
 * Read an order as the API gives it (`protocol.v2.orderData`, already JSON-parsed) into the one typed form the id,
 * the signature and every check are computed from. Anything that is not exactly the documented shape is refused
 * (`order-malformed`); keys the type does not have are ignored — they are outside the hash, and nothing reads them.
 */
export function parseRelayOrder(raw: unknown): RelayOrder {
  const o = rec(raw, "body");
  const output = rec(own(o, "output"), "output");
  return {
    version: text(own(o, "version"), "version"),
    solverChainId: text(own(o, "solverChainId"), "solver chain"),
    solver: address(own(o, "solver"), "solver"),
    salt: uint(own(o, "salt"), "salt"),
    inputs: list(own(o, "inputs"), "inputs").map((x, i) => {
      const input = rec(x, `input ${i}`);
      const p = rec(own(input, "payment"), `input ${i} payment`);
      return {
        payment: {
          chainId: text(own(p, "chainId"), `input ${i} chain`),
          currency: bytes(own(p, "currency"), `input ${i} currency`),
          amount: uint(own(p, "amount"), `input ${i} amount`),
          weight: uint(own(p, "weight"), `input ${i} weight`),
        },
        refunds: list(own(input, "refunds"), `input ${i} refunds`).map((y, j) => {
          const r = rec(y, `refund ${j}`);
          return {
            chainId: text(own(r, "chainId"), `refund ${j} chain`),
            recipient: bytes(own(r, "recipient"), `refund ${j} recipient`),
            currency: bytes(own(r, "currency"), `refund ${j} currency`),
            minimumAmount: uint(own(r, "minimumAmount"), `refund ${j} minimum`),
            deadline: uint32(own(r, "deadline"), `refund ${j} deadline`),
            extraData: bytes(own(r, "extraData"), `refund ${j} extra data`),
          };
        }),
      };
    }),
    output: {
      chainId: text(own(output, "chainId"), "output chain"),
      payments: list(own(output, "payments"), "output payments").map((x, i) => {
        const p = rec(x, `output payment ${i}`);
        return {
          recipient: bytes(own(p, "recipient"), `output payment ${i} recipient`),
          currency: bytes(own(p, "currency"), `output payment ${i} currency`),
          minimumAmount: uint(own(p, "minimumAmount"), `output payment ${i} minimum`),
          expectedAmount: uint(own(p, "expectedAmount"), `output payment ${i} expected amount`),
        };
      }),
      deadline: uint32(own(output, "deadline"), "output deadline"),
      calls: list(own(output, "calls"), "output calls").map((x, i) => bytes(x, `output call ${i}`)),
      extraData: bytes(own(output, "extraData"), "output extra data"),
    },
    fees: list(own(o, "fees"), "fees").map((x, i) => {
      const f = rec(x, `fee ${i}`);
      return {
        recipientChainId: text(own(f, "recipientChainId"), `fee ${i} recipient chain`),
        recipient: bytes(own(f, "recipient"), `fee ${i} recipient`),
        currencyChainId: text(own(f, "currencyChainId"), `fee ${i} currency chain`),
        currency: bytes(own(f, "currency"), `fee ${i} currency`),
        amount: uint(own(f, "amount"), `fee ${i} amount`),
      };
    }),
  };
}

/** The order id: `hashStruct(Order)`, no domain. */
export function relayOrderId(order: RelayOrder): Hex {
  return hashStruct({types: RELAY_ORDER_TYPES, primaryType: "Order", data: order as never});
}

/**
 * The address whose `personal_sign` over the id's 32 bytes this signature is (lowercase), or null when it is not a
 * 65-byte secp256k1 signature that recovers at all. Synchronous on purpose: the same check runs wherever the order
 * is read, with nothing left for a later asynchronous step.
 */
export function relayOrderSigner(id: Hex, signature: unknown): Hex | null {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  const sig = hexToBytes(signature as Hex);
  const v = sig[64]!;
  const recovery = v === 27 || v === 28 ? v - 27 : v === 0 || v === 1 ? v : -1;
  if (recovery < 0) return null;
  try {
    const recoverable = new Uint8Array(65);
    recoverable[0] = recovery;
    recoverable.set(sig.subarray(0, 64), 1);
    const digest = hexToBytes(hashMessage({raw: id}));
    const key = secp256k1.recoverPublicKey(recoverable, digest, {prehash: false});
    // The recovery must also verify: a malformed (r, s) never passes as a signer.
    if (!secp256k1.verify(sig.subarray(0, 64), digest, key, {prehash: false})) return null;
    const uncompressed = secp256k1.Point.fromBytes(key).toBytes(false);
    return `0x${keccak256(uncompressed.subarray(1)).slice(-40)}`.toLowerCase() as Hex;
  } catch {
    return null;
  }
}
