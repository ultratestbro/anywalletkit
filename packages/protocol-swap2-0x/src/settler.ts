/**
 * The device-side checks of a 0x Permit2 swap. Nothing here trusts the API.
 *
 *  - {@link createSettlerResolver}: the Settler in force is read from the pinned on-chain registry
 *    (`ownerOf(2)`, and `prev(2)` for 0x's dwell time after a new deployment) — never taken from a
 *    quote — and held to a CREATE3 deployment of that registry between the chain's pinned previous
 *    deployment and its newest plus the margin, with code. A paused or removed feature reverts there
 *    and the swap is refused.
 *  - {@link decodeSettlerExecute}: a word-level reader of `Settler.execute(slippage, actions, zid)`.
 *  - {@link checkZeroExTransaction}: the transaction a quote carries, held to the request — target
 *    (and, for a native-coin sale, a Settler live when the chain table was pinned), value, chain,
 *    method, the recipient / buy token / minimum of Settler's own slippage check, and, for a token
 *    sale, the Permit2 payload (rebuilt locally by the core reader) and the first action that
 *    spends it.
 *
 * Why the slippage tuple is the anchor: `execute` ends in Settler's `_checkSlippageAndTransfer`,
 * which sends the Settler's whole balance of `buyToken` to `recipient` and reverts below
 * `minAmountOut`. With the target a registry Settler, that tuple and the signed amount fixed, the
 * worst a hostile route can do is revert: the account pays at most the signed input and receives at
 * least the minimum. What the actions between do (which pools, in what order) is not checked.
 *
 * Why the first action is always checked: Settler runs a Permit2-spending action (`TRANSFER_FROM`,
 * every `*_VIP`) only at index 0, and Permit2 pulls from the caller. A token sale's action 0 must
 * therefore spend exactly the permit about to be signed, and a native-coin sale's action 0 must be
 * `NATIVE_CHECK` — otherwise an earlier, unspent permit of this account (one whose swap reverted)
 * could be spent inside a swap that looks like a plain native sale.
 *
 * Every refusal carries a `Swap2RefusalReason` (CS-13); a request this side cannot hold a
 * transaction to (no chain, recipient, tokens or amounts) is the caller's error and stays unclassified.
 */
import {getAddress, getContractAddress, numberToHex, pad} from "viem";
import {refusalOf, withReason, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import {readPermit2Transfer, type Permit2Transfer} from "@anywalletkit/protocol-swap2-core/util";
import {ZEROEX_CHAINS, ZEROEX_NATIVE, ZEROEX_PERMIT2, ZEROEX_SETTLER_MAX_NONCE, ZEROEX_SETTLER_NONCE_MARGIN, ZEROEX_SETTLER_REGISTRY, ZEROEX_TAKER_FEATURE, zeroExChain, type ZeroExChain} from "./chains.js";
import {isRevert, rpcRequest, rpcUrlsFor, type RpcUrls} from "./rpc.js";

/** `execute((address recipient, address buyToken, uint256 minAmountOut), bytes[] actions, bytes32 zidAndAffiliate)`. */
export const SETTLER_EXECUTE_SELECTOR = "0x1fff991f";
/** `ownerOf(uint256)` on the registry: the Settler in force for a feature. */
export const REGISTRY_OWNER_OF_SELECTOR = "0x6352211e";
/** `prev(uint128)` on the registry: the instance the current one replaced. */
export const REGISTRY_PREV_SELECTOR = "0xe2603dc2";
/** `NATIVE_CHECK(uint256 deadline, uint256 msgValue)`: the action every native-coin sale opens with (no Permit2 involved). */
export const SETTLER_NATIVE_CHECK_SELECTOR = "0xbd01c226";
/**
 * The longest a 0x permit may stay valid from now. 0x signs five minutes ahead; the core reader allows an hour for any
 * provider. A shorter window leaves less time for a permit that was published but not spent (its swap reverted).
 */
export const ZEROEX_MAX_PERMIT_SECONDS = 600;
/**
 * The longest a native-coin sale's quote may stay valid from now. A token sale's quote is bounded by its permit's
 * deadline; a native sale signs nothing, so its quote is bounded here instead: the transaction goes out within this
 * window of the registry read it was checked against, or not at all.
 */
export const ZEROEX_MAX_NATIVE_QUOTE_SECONDS = 120;

/** How far inside {@link ZEROEX_MAX_NATIVE_QUOTE_SECONDS} a backend ends a native sale's quote, so an app whose clock runs behind the backend's still accepts it. */
export const ZEROEX_NATIVE_QUOTE_SKEW_SECONDS = 30;

const PERMIT = "((address,uint256),uint256,uint256)";
/**
 * Settler actions through which a taker-submitted swap spends a Permit2 signature (`ISettlerActions.sol`), by
 * selector. Every one starts `(address recipient, PermitTransferFrom permit, …)`, so the permit sits in argument
 * words 1–4 (token, amount, nonce, deadline); `sigWord` is the head word holding the offset of `bytes sig`.
 * `RFQ_VIP` (a maker-signed order) is left out on purpose: a quote that opens with it is refused.
 */
export const SETTLER_PERMIT_ACTIONS: Readonly<Record<string, {name: string; signature: string; sigWord: number}>> = Object.freeze({
  "0xc1fb425e": Object.freeze({name: "TRANSFER_FROM", signature: `TRANSFER_FROM(address,${PERMIT},bytes)`, sigWord: 5}),
  "0x3036d6a6": Object.freeze({name: "UNISWAPV3_VIP", signature: `UNISWAPV3_VIP(address,${PERMIT},bytes,bytes,uint256)`, sigWord: 6}),
  "0x6a92dacb": Object.freeze({name: "UNISWAPV4_VIP", signature: `UNISWAPV4_VIP(address,${PERMIT},uint8,bool,uint256,uint256,bytes,bytes,uint256)`, sigWord: 10}),
  "0x441d2492": Object.freeze({name: "PANCAKE_INFINITY_VIP", signature: `PANCAKE_INFINITY_VIP(address,${PERMIT},uint8,bool,uint256,uint256,bytes,bytes,uint256)`, sigWord: 10}),
  "0x4150c86c": Object.freeze({name: "BALANCERV3_VIP", signature: `BALANCERV3_VIP(address,${PERMIT},bool,uint256,uint256,bytes,bytes,uint256)`, sigWord: 9}),
  "0x10cd6343": Object.freeze({name: "EKUBOV3_VIP", signature: `EKUBOV3_VIP(address,${PERMIT},bool,uint256,uint256,bytes,bytes,uint256)`, sigWord: 9}),
  "0x0bcce50f": Object.freeze({name: "CURVE_TRICRYPTO_VIP", signature: `CURVE_TRICRYPTO_VIP(address,${PERMIT},uint80,bytes,uint256)`, sigWord: 6}),
});

/** A refusal from one of the checks in this file. The message is safe to show and starts `zeroex: `; `reason` classifies it (CS-13). */
export class ZeroExTransactionError extends Error {
  declare readonly reason?: Swap2RefusalReason;
  constructor(why: string, reason?: Swap2RefusalReason) {
    super(`zeroex: ${why}`);
    this.name = "ZeroExTransactionError";
    if (reason) withReason(this, reason);
  }
}
const refuse = (why: string, reason?: Swap2RefusalReason) => new ZeroExTransactionError(why, reason);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/;
const same = (a: string, b: string) => a.length === b.length && a.toLowerCase() === b.toLowerCase();
/** The native coin, as the engine (zero address) or 0x (the `0xEeee…` sentinel) names it. */
export const isZeroExNative = (token: string): boolean => ZERO_ADDRESS.test(token) || same(token, ZEROEX_NATIVE);

// ── which addresses are 0x Settlers at all ──────────────────────────────────

/**
 * keccak256 of the CREATE3 shim (PUSH0 variant) through which the registry deploys every Settler: the registry
 * CREATE2s the shim with salt `feature << 128 | chainId << 64 | nonce`, and the shim CREATEs the Settler (nonce 1).
 */
export const ZEROEX_SETTLER_SHIM_INIT_HASH = "0x3bf3f97f0be1e2c00023033eefeb4fc062ac552ff36778b17060d90b6764902f";
/**
 * How far past the newest deployment a chain accepts ({@link ZeroExChain.newestLiveNonce} plus the margin) the resolver
 * still derives, only to tell "0x deployed a newer Settler than this module accepts" (refused until the pin is raised)
 * from "not a 0x Settler at all".
 */
export const ZEROEX_SETTLER_LOOKAHEAD = 16;

/** The newest deployment a token sale may use on a chain: the newest one live when pinned, plus the margin. */
const tokenCeiling = (chain: ZeroExChain): number => chain.newestLiveNonce + ZEROEX_SETTLER_NONCE_MARGIN;

/** The address the registry deploys taker-feature Settler number `nonce` to on `chainId` — computed, no network. */
export function zeroExSettlerAddress(chainId: number, nonce: number, registry: string = ZEROEX_SETTLER_REGISTRY): string {
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !Number.isSafeInteger(nonce) || nonce <= 0) throw new Error("zeroex: a Settler address needs a positive chain id and nonce");
  const salt = pad(numberToHex((BigInt(ZEROEX_TAKER_FEATURE) << 128n) | (BigInt(chainId) << 64n) | BigInt(nonce)), {size: 32});
  const shim = getContractAddress({opcode: "CREATE2", from: registry as `0x${string}`, salt, bytecodeHash: ZEROEX_SETTLER_SHIM_INIT_HASH});
  return getContractAddress({opcode: "CREATE", from: shim, nonce: 1n});
}

const derived = new Map<string, string[]>();
/**
 * Which deployment of the registry's taker feature `address` is on `chainId` (its nonce), or null when it is none of
 * deployments 1…`maxNonce` — by default the newest one the default table accepts on the chain
 * ({@link ZeroExChain.newestLiveNonce} plus {@link ZEROEX_SETTLER_NONCE_MARGIN}; a chain outside the table has none:
 * null). An RPC (or an API) can therefore only ever name a contract 0x's own registry deployed as a Settler — never an
 * arbitrary contract or account. Bounded by the pin, an address that is no Settler costs a few dozen derivations, not
 * a thousand. Memoized per chain.
 */
export function zeroExSettlerNonce(chainId: number, address: string, registry: string = ZEROEX_SETTLER_REGISTRY, maxNonce?: number): number | null {
  if (typeof address !== "string" || !ADDRESS.test(address) || !Number.isSafeInteger(chainId) || chainId <= 0 || !ADDRESS.test(registry)) return null;
  const pinned = zeroExChain(ZEROEX_CHAINS, chainId);
  const bound = Math.min(maxNonce ?? (pinned ? tokenCeiling(pinned) : 0), ZEROEX_SETTLER_MAX_NONCE + ZEROEX_SETTLER_NONCE_MARGIN + ZEROEX_SETTLER_LOOKAHEAD);
  if (!Number.isSafeInteger(bound) || bound < 1) return null;
  const key = `${registry.toLowerCase()}:${chainId}`;
  let list = derived.get(key);
  if (!list) derived.set(key, (list = []));
  const want = address.toLowerCase();
  const hit = list.indexOf(want);
  if (hit >= 0) return hit < bound ? hit + 1 : null;
  while (list.length < bound) {
    const next = zeroExSettlerAddress(chainId, list.length + 1, registry).toLowerCase();
    list.push(next);
    if (next === want) return list.length;
  }
  return null;
}

// ── the Settler in force ────────────────────────────────────────────────────

export interface SettlerResolverConfig {
  /** The chain table (registry per chain). */
  chains: Readonly<Record<number, ZeroExChain>>;
  /** JSON-RPC endpoints per EVM chain id. Without one for a chain, its Settler cannot be resolved and live quotes are refused. */
  rpcUrls?: RpcUrls | undefined;
  /** How long a registry read is reused, ms. Default 5 minutes; a miss always triggers a fresh read. */
  maxAgeMs?: number | undefined;
  /** Clock (tests). */
  now?: (() => number) | undefined;
}

export interface SettlerResolver {
  /** The Settlers a swap on `chainId` may call: the one in force, then the one it replaced (if any). Throws when the registry cannot be read or the feature is paused. */
  resolve(chainId: number, options?: {fresh?: boolean}): Promise<readonly string[]>;
  /** The last resolved set while it is still fresh; empty otherwise. Never touches the network. */
  known(chainId: number): readonly string[];
}

const DEFAULT_SETTLER_MAX_AGE_MS = 5 * 60_000;

/** One 32-byte word that is an address (upper 12 bytes zero), as a checksummed address; null for anything else, the zero address included. */
function addressWord(result: unknown): string | null {
  if (typeof result !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(result)) return null;
  const address = `0x${result.slice(26)}`;
  return ZERO_ADDRESS.test(address) ? null : getAddress(address);
}

/**
 * Reads the Settler in force from the registry and caches it per chain. The registry address comes from the chain
 * table; the answer comes from the integrator's own RPC — that RPC is what this module trusts for "which contract
 * is 0x's Settler right now", within hard bounds it cannot move: the answer must be a CREATE3 deployment of that
 * registry, no older than the chain's pinned {@link ZeroExChain.previousLiveNonce} and no newer than its
 * {@link ZeroExChain.newestLiveNonce} plus {@link ZEROEX_SETTLER_NONCE_MARGIN}, with code at the address (read through
 * the same RPC). Which of these a native-coin sale may use is narrower still ({@link checkZeroExTransaction}).
 */
export function createSettlerResolver(config: SettlerResolverConfig): SettlerResolver {
  const maxAge = config.maxAgeMs !== undefined && Number.isFinite(config.maxAgeMs) && config.maxAgeMs >= 0 ? config.maxAgeMs : DEFAULT_SETTLER_MAX_AGE_MS;
  const now = config.now ?? Date.now;
  const cache = new Map<number, {at: number; settlers: readonly string[]}>();
  const flights = new Map<number, Promise<readonly string[]>>();

  /** eth_call on the registry. `{reverted: true}` when the node says the call reverted; throws when nothing answered. */
  async function call(chainId: number, to: string, data: string): Promise<{result: string} | {reverted: true}> {
    if (!rpcUrlsFor(config.rpcUrls, chainId).length) throw refuse(`no RPC is configured for chain ${chainId} — the 0x Settler cannot be resolved`, "policy_refused");
    const answer = await rpcRequest(config.rpcUrls, chainId, "eth_call", [{to, data}, "latest"]);
    if (!answer) throw refuse(`no RPC answered on chain ${chainId} — the 0x Settler cannot be resolved`, "upstream_unavailable");
    // An execution revert is an answer (the feature is paused / has no instance); any other error is the endpoint failing.
    if ("error" in answer) {
      if (isRevert(answer.error)) return {reverted: true};
      throw refuse(`the RPC on chain ${chainId} could not read the 0x Settler registry`, "upstream_unavailable");
    }
    if (typeof answer.result !== "string") throw refuse(`the RPC on chain ${chainId} could not read the 0x Settler registry`, "upstream_unavailable");
    return {result: answer.result};
  }

  /** Addresses already seen holding code (per chain): a deployed Settler's code does not go away, so it is read once. */
  const withCode = new Set<string>();
  /** Whether `address` holds contract code, read over the same RPC as the registry. Throws when nothing answered. */
  async function hasCode(chainId: number, address: string): Promise<boolean> {
    const key = `${chainId}:${address.toLowerCase()}`;
    if (withCode.has(key)) return true;
    const answer = await rpcRequest(config.rpcUrls, chainId, "eth_getCode", [address, "latest"]);
    if (!answer) throw refuse(`no RPC answered on chain ${chainId} — the 0x Settler's code cannot be read`, "upstream_unavailable");
    if ("error" in answer || typeof answer.result !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(answer.result)) throw refuse(`the RPC on chain ${chainId} could not read the 0x Settler's code`, "upstream_unavailable");
    if (answer.result.length <= 2) return false;
    withCode.add(key);
    return true;
  }

  async function read(chainId: number): Promise<readonly string[]> {
    const entry = zeroExChain(config.chains, chainId);
    if (!entry) throw refuse(`chain ${chainId} is not in the 0x chain table`, "unsupported_pair");
    const feature = ZEROEX_TAKER_FEATURE.toString(16).padStart(64, "0");
    const current = await call(chainId, entry.registry, `${REGISTRY_OWNER_OF_SELECTOR}${feature}`);
    if ("reverted" in current) throw refuse(`the 0x Settler registry on chain ${chainId} reports no taker Settler in force (paused or removed)`, "chain_halted");
    const settler = addressWord(current.result);
    if (!settler) throw refuse(`the 0x Settler registry on chain ${chainId} answered something that is not an address`, "vault_mismatch");
    // The answer comes from one RPC: it must be a deployment the registry itself made, inside the window this module
    // pins for the chain, and a contract. A newer deployment is 0x moving on: refused, with what to do, until the pin
    // is raised (the watch job reports it the day it happens). An older one is a replaced Settler: refused.
    const oldest = entry.previousLiveNonce;
    const ceiling = tokenCeiling(entry);
    const nonce = zeroExSettlerNonce(chainId, settler, entry.registry, ceiling);
    if (nonce === null) {
      const newer = zeroExSettlerNonce(chainId, settler, entry.registry, ceiling + ZEROEX_SETTLER_LOOKAHEAD);
      if (newer !== null) {
        throw refuse(`the 0x registry on chain ${chainId} names Settler deployment ${newer} (${settler}), newer than the newest this module accepts there (${ceiling}) — update @anywalletkit/protocol-swap2-0x, or raise the chain's newestLiveNonce and previousLiveNonce once that deployment is checked`, "vault_mismatch");
      }
      throw refuse(`the RPC on chain ${chainId} names ${settler} as the 0x Settler, which is not an address the 0x registry deploys Settlers to`, "vault_mismatch");
    }
    if (nonce < oldest) throw refuse(`the RPC on chain ${chainId} names ${settler} (Settler deployment ${nonce}) as the 0x Settler, older than the oldest this module accepts there (${oldest}) — a replaced Settler is not called`, "vault_mismatch");
    // A deployment that does not exist yet (inside the margin past the newest live one) has no code: value or tokens
    // sent there would be stranded until 0x deploys it.
    if (!(await hasCode(chainId, settler))) throw refuse(`the RPC on chain ${chainId} names ${settler} (Settler deployment ${nonce}) as the 0x Settler, but no contract is deployed there`, "vault_mismatch");
    const settlers = [settler];
    // The instance it replaced: 0x keeps quoting it for a while after a new deployment. No previous instance reverts;
    // one outside the pinned window, or without code, is left out.
    try {
      const previous = await call(chainId, entry.registry, `${REGISTRY_PREV_SELECTOR}${feature}`);
      const prev = "result" in previous ? addressWord(previous.result) : null;
      const prevNonce = prev && !same(prev, settler) ? zeroExSettlerNonce(chainId, prev, entry.registry, ceiling) : null;
      if (prev && prevNonce !== null && prevNonce >= oldest && (await hasCode(chainId, prev))) settlers.push(prev);
    } catch {
      // The current Settler alone is a valid (stricter) answer.
    }
    return Object.freeze(settlers);
  }

  return {
    async resolve(chainId, options) {
      const hit = cache.get(chainId);
      if (!options?.fresh && hit && now() - hit.at <= maxAge) return hit.settlers;
      const running = flights.get(chainId);
      if (running) return running;
      const flight = read(chainId).then((settlers) => {
        cache.set(chainId, {at: now(), settlers});
        return settlers;
      }).finally(() => {
        flights.delete(chainId);
      });
      flights.set(chainId, flight);
      return flight;
    },
    known(chainId) {
      const hit = cache.get(chainId);
      return hit && now() - hit.at <= maxAge ? hit.settlers : [];
    },
  };
}

// ── Settler.execute calldata ────────────────────────────────────────────────

export interface SettlerAction {
  /** 4-byte action selector, lowercase. */
  selector: string;
  /** Byte offset, inside the `execute` arguments, of the action's first argument word. */
  argsStart: number;
  /** The action's declared byte length (selector included). The first action of a Permit2 quote declares more than is there: its signature is appended later. */
  declaredLength: number;
}

export interface SettlerExecute {
  /** Who Settler's slippage check pays. */
  recipient: string;
  /** The token that check measures (`0xEeee…` for the native coin). */
  buyToken: string;
  /** The least `recipient` receives, or the call reverts. */
  minAmountOut: bigint;
  /** 0x's trade id and affiliate tag (not checked). */
  zidAndAffiliate: string;
  actions: readonly SettlerAction[];
  /** Bytes of arguments after the 4-byte method selector. */
  bodyLength: number;
  /** The argument word at byte `offset`, as 64 hex characters; throws when it is out of range. */
  word(offset: number): string;
}

const MAX_CALLDATA_BYTES = 65_536;
const MAX_ACTIONS = 256;
const ACTIONS_OFFSET = 0xa0;

/**
 * Read `Settler.execute(slippage, actions, zidAndAffiliate)` calldata. Strict where it matters (method, the static
 * slippage tuple, the canonical position of the action array, every action inside the data) and tolerant where
 * Settler is: the data need not be a multiple of 32 bytes, and the first action may declare a length that runs past
 * the end (0x leaves room for the Permit2 signature there).
 */
export function decodeSettlerExecute(data: string): SettlerExecute {
  if (typeof data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) throw refuse("the transaction data is not hex bytes", "policy_refused");
  if (data.length > 2 + 2 * MAX_CALLDATA_BYTES) throw refuse("the transaction data is larger than any 0x swap", "policy_refused");
  if (data.length < 10 || data.slice(0, 10).toLowerCase() !== SETTLER_EXECUTE_SELECTOR) throw refuse("the transaction does not call Settler.execute", "policy_refused");
  const body = data.slice(10).toLowerCase();
  const bodyLength = body.length / 2;
  const word = (offset: number): string => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + 32 > bodyLength) throw refuse("the Settler call is cut short", "policy_refused");
    return body.slice(offset * 2, offset * 2 + 64);
  };
  const address = (offset: number, what: string): string => {
    const w = word(offset);
    if (!/^0{24}/.test(w)) throw refuse(`the Settler call's ${what} is not an address`, "policy_refused");
    return getAddress(`0x${w.slice(24)}`);
  };
  /** A word that must be a small non-negative integer (an offset, a length, a count). */
  const small = (offset: number, what: string): number => {
    const w = word(offset);
    if (!/^0{56}/.test(w)) throw refuse(`the Settler call's ${what} is out of range`, "policy_refused");
    return parseInt(w.slice(56), 16);
  };

  const recipient = address(0x00, "recipient");
  const buyToken = address(0x20, "buy token");
  const minAmountOut = BigInt(`0x${word(0x40)}`);
  if (small(0x60, "action array offset") !== ACTIONS_OFFSET) throw refuse("the Settler call does not place its actions where the ABI does", "policy_refused");
  const zidAndAffiliate = `0x${word(0x80)}`;
  const count = small(ACTIONS_OFFSET, "action count");
  if (count < 1 || count > MAX_ACTIONS) throw refuse(`the Settler call carries ${count} actions`, "policy_refused");
  const table = ACTIONS_OFFSET + 32;
  const actions: SettlerAction[] = [];
  for (let i = 0; i < count; i++) {
    const offset = small(table + 32 * i, "action offset");
    const at = table + offset;
    // Past the offset table, with room for the length word and a selector.
    if (offset < 32 * count || at + 36 > bodyLength) throw refuse(`action ${i} of the Settler call lies outside the data`, "policy_refused");
    const declaredLength = small(at, "action length");
    if (declaredLength < 4) throw refuse(`action ${i} of the Settler call has no selector`, "policy_refused");
    if (i > 0 && at + 32 + declaredLength > bodyLength) throw refuse(`action ${i} of the Settler call runs past the data`, "policy_refused");
    actions.push(Object.freeze({selector: `0x${body.slice((at + 32) * 2, (at + 36) * 2)}`, argsStart: at + 36, declaredLength}));
  }
  return Object.freeze({recipient, buyToken, minAmountOut, zidAndAffiliate, actions: Object.freeze(actions), bodyLength, word});
}

// ── the transaction, held to the request ────────────────────────────────────

/** What the user asked for — the only source of truth for the checks. */
export interface ZeroExExpectation {
  /** EVM chain id of the swap. */
  chainId: number;
  /**
   * The chain's entry in the table in force: its pins bound the target (a token sale: `previousLiveNonce` up to
   * `newestLiveNonce` plus the margin; a native-coin sale: exactly `newestLiveNonce` or `previousLiveNonce`). Default:
   * the default table's entry for `chainId`.
   */
  chain?: ZeroExChain | undefined;
  /** Settlers resolved from the registry for that chain ({@link SettlerResolver.resolve}). */
  settlers: readonly string[];
  /** The token sold: an ERC-20 address, or the zero address / `0xEeee…` for the native coin. */
  sellToken: string;
  /** The token bought, same convention. */
  buyToken: string;
  /** Exactly the input, base units. */
  sellAmount: bigint;
  /** Who must receive the output (the user's own address unless they named another). */
  recipient: string;
  /** The least the recipient must receive — the quote's minimum, already held to the requested slippage by the caller. */
  minBuyAmount: bigint;
  /** Clock for the Permit2 deadline (tests). */
  nowMs?: number;
}

/** The transaction fields the checks read (a quote's `txRequest` or a built `UnsignedTx`). */
export interface ZeroExTransaction {
  to?: string | undefined;
  data?: string | undefined;
  value?: string | undefined;
  chainId?: number | undefined;
  approvalAddress?: string | undefined;
  permit2Transfer?: string | undefined;
  gasLimit?: string | undefined;
}

/**
 * The most gas a 0x swap may be given (the padded limit: 0x's gas × 1.2 + 20,000). Unused gas is refunded, but a
 * reverting route burns up to the limit, so a quote that asks for a block's worth is refused. Settler swaps on the
 * first seven chains sit well under 2 million; on Monad the same swap takes 7–10 times as much, and on 2026-11-26 0x
 * sales of MON from about $10,000 asked for more than this allows (one cap for every chain; see the README).
 */
export const ZEROEX_MAX_GAS_LIMIT = 6_000_000n;

export interface ZeroExCheckedTransaction {
  execute: SettlerExecute;
  /** The locally rebuilt Permit2 payload of a token sale; absent for a native-coin sale. */
  permit2?: Permit2Transfer;
  /** Name of the Settler action that spends the Permit2 signature (token sales). */
  permitAction?: string;
}

/**
 * Hold a 0x transaction to the request, or throw {@link ZeroExTransactionError}. Checked:
 *
 *  1. `to` is one of the registry's Settlers, and a deployment inside the chain's pinned window
 *     (`previousLiveNonce` … `newestLiveNonce` + {@link ZEROEX_SETTLER_NONCE_MARGIN}); `chainId`, when present, is the
 *     swap's chain.
 *  2. `value` is the input for a native-coin sale and zero for a token sale; a sale that sends value goes only to the
 *     chain's `newestLiveNonce` or `previousLiveNonce` deployment — Settlers that were live when the table was pinned —
 *     never into the margin; a gas limit, when given, is at most {@link ZEROEX_MAX_GAS_LIMIT}.
 *  3. The method is `execute`, and its slippage tuple names the expected recipient, the requested buy token and
 *     exactly the expected minimum (never zero).
 *  4. Token sale: the allowance target is canonical Permit2; the Permit2 payload passes the core reader (Permit2
 *     domain on this chain, the sell token, exactly the input, this very Settler as spender) and is rebuilt locally,
 *     with a deadline at most {@link ZEROEX_MAX_PERMIT_SECONDS} away; the first action is a known Permit2-spending
 *     action carrying that same token, amount, nonce and deadline, and its signature slot points at the end of the
 *     data, where the signature is appended.
 *  5. Native-coin sale: no allowance target, no Permit2 payload, and the first action is `NATIVE_CHECK` — the only
 *     place Settler would spend a Permit2 signature holds none.
 *
 * Not checked: the actions after the first (the route), the first action's own `recipient` (where Permit2 sends the
 * input: the Settler or a pool) and `zidAndAffiliate`. Settler's slippage check bounds what they can do.
 */
export function checkZeroExTransaction(tx: ZeroExTransaction, expected: ZeroExExpectation): ZeroExCheckedTransaction {
  if (!Number.isSafeInteger(expected.chainId) || expected.chainId <= 0) throw refuse("the swap names no EVM chain");
  if (!ADDRESS.test(expected.recipient) || ZERO_ADDRESS.test(expected.recipient)) throw refuse("the swap names no recipient");
  if (!ADDRESS.test(expected.sellToken) || !ADDRESS.test(expected.buyToken)) throw refuse("the swap names no sell or buy token");
  if (expected.sellAmount <= 0n || expected.minBuyAmount <= 0n) throw refuse("the swap has no input or no minimum output");
  const nativeSell = isZeroExNative(expected.sellToken);
  const nativeBuy = isZeroExNative(expected.buyToken);
  if (nativeSell ? nativeBuy : !nativeBuy && same(expected.sellToken, expected.buyToken)) throw refuse("the swap sells and buys the same token");

  if (typeof tx.to !== "string" || !ADDRESS.test(tx.to)) throw refuse("the transaction has no target", "policy_refused");
  const to = tx.to;
  if (!expected.settlers.length) throw refuse(`the 0x Settler for chain ${expected.chainId} is not resolved`, "upstream_unavailable");
  if (!expected.settlers.some((s) => same(s, to))) throw refuse(`the transaction target ${to} is not a 0x Settler from the on-chain registry`, "vault_mismatch");
  if (tx.chainId !== undefined && tx.chainId !== expected.chainId) throw refuse(`the transaction is for chain ${String(tx.chainId).slice(0, 20)}, not ${expected.chainId}`, "vault_mismatch");
  // Whatever settler list the caller hands in, the target is held to the chain's pins: a deployment of the registry
  // between the previous one live at pin time and the newest one a token sale may use.
  const pin = expected.chain ?? zeroExChain(ZEROEX_CHAINS, expected.chainId);
  if (!pin) throw refuse(`chain ${expected.chainId} is not in the 0x chain table`, "unsupported_pair");
  const deployment = zeroExSettlerNonce(expected.chainId, to, pin.registry, tokenCeiling(pin));
  if (deployment === null || deployment < pin.previousLiveNonce) throw refuse(`the transaction target ${to} is not a 0x Settler deployment this module accepts on chain ${expected.chainId}`, "vault_mismatch");
  if (typeof tx.value !== "string" || !/^[0-9]{1,78}$/.test(tx.value)) throw refuse("the transaction value is not a decimal amount", "policy_refused");
  const value = BigInt(tx.value);
  if (value !== (nativeSell ? expected.sellAmount : 0n)) throw refuse(nativeSell ? "the transaction value is not the amount being sold" : "the transaction sends native coin with a token sale", "price_check_failed");
  // Value goes straight to the target: only to a Settler that was live when the table was pinned. A deployment inside
  // the margin may not exist yet (its code is the RPC's word) — what is sent there would be stranded, or swept by
  // whatever 0x deploys there later. Refused until the package (its pins) is updated.
  if (value > 0n && deployment !== pin.newestLiveNonce && deployment !== pin.previousLiveNonce) {
    throw refuse(deployment > pin.newestLiveNonce
      ? `the swap sends native coin to Settler deployment ${deployment} (${to}) on chain ${expected.chainId}, newer than the newest one live when this module's chain table was pinned (${pin.newestLiveNonce}) — a native-coin sale goes only to a pinned Settler: update @anywalletkit/protocol-swap2-0x`
      : `the swap sends native coin to Settler deployment ${deployment} (${to}) on chain ${expected.chainId}, which was not live when this module's chain table was pinned (${pin.newestLiveNonce} and ${pin.previousLiveNonce} were) — a native-coin sale goes only to a pinned Settler`, "vault_mismatch");
  }
  if (tx.gasLimit !== undefined && (typeof tx.gasLimit !== "string" || !/^[0-9]{1,12}$/.test(tx.gasLimit) || BigInt(tx.gasLimit) === 0n || BigInt(tx.gasLimit) > ZEROEX_MAX_GAS_LIMIT)) {
    throw refuse("the transaction asks for more gas than any 0x swap needs", "policy_refused");
  }
  if (typeof tx.data !== "string") throw refuse("the transaction has no data", "policy_refused");

  const execute = decodeSettlerExecute(tx.data);
  if (!same(execute.recipient, expected.recipient)) throw refuse(`the swap pays ${execute.recipient}, not the recipient of this swap`, "recipient_mismatch");
  if (nativeBuy ? !same(execute.buyToken, ZEROEX_NATIVE) : !same(execute.buyToken, expected.buyToken)) throw refuse(`the swap delivers ${execute.buyToken}, not the token asked for`, "price_check_failed");
  if (execute.minAmountOut !== expected.minBuyAmount) throw refuse(`the swap enforces a minimum of ${execute.minAmountOut}, not the quoted ${expected.minBuyAmount}`, "price_check_failed");
  const first = execute.actions[0]!;

  if (nativeSell) {
    if (tx.approvalAddress !== undefined) throw refuse("a native-coin sale asks for a token allowance", "policy_refused");
    if (tx.permit2Transfer !== undefined) throw refuse("a native-coin sale carries a Permit2 signature request", "policy_refused");
    // Action 0 is where Settler would spend a Permit2 signature (any earlier, unspent permit of this account): a native
    // sale opens with NATIVE_CHECK and nothing else.
    if (first.selector !== SETTLER_NATIVE_CHECK_SELECTOR) throw refuse(`the swap's first action ${first.selector} is not the native-value check a native-coin sale opens with`, "policy_refused");
    return {execute};
  }

  if (typeof tx.approvalAddress !== "string" || !same(tx.approvalAddress, ZEROEX_PERMIT2)) throw refuse("the allowance target is not canonical Permit2", "vault_mismatch");
  if (typeof tx.permit2Transfer !== "string") throw refuse("a token sale carries no Permit2 payload to sign", "policy_refused");
  const nowMs = expected.nowMs ?? Date.now();
  let permit2: Permit2Transfer;
  try {
    permit2 = readPermit2Transfer(tx.permit2Transfer, {
      chainId: expected.chainId,
      token: expected.sellToken,
      amount: expected.sellAmount,
      spender: to,
      nowMs,
    });
  } catch (err) {
    throw refuse((err instanceof Error ? err.message : "the Permit2 payload is refused").replace(/^swap2: /, ""), refusalOf(err)?.reason ?? "policy_refused");
  }
  if (permit2.deadline > BigInt(Math.floor(nowMs / 1000) + ZEROEX_MAX_PERMIT_SECONDS)) throw refuse(`the Permit2 deadline is more than ${ZEROEX_MAX_PERMIT_SECONDS} s away`, "policy_refused");

  const action = Object.prototype.hasOwnProperty.call(SETTLER_PERMIT_ACTIONS, first.selector) ? SETTLER_PERMIT_ACTIONS[first.selector] : undefined;
  if (!action) throw refuse(`the swap's first action ${first.selector} is not a Permit2 payment this module knows`, "policy_refused");
  const arg = (index: number) => execute.word(first.argsStart + 32 * index);
  // (address recipient, ((address token, uint256 amount), uint256 nonce, uint256 deadline), …): words 1–4.
  if (!/^0{24}/.test(arg(1)) || !same(`0x${arg(1).slice(24)}`, expected.sellToken)) throw refuse(`${action.name} pulls a token other than the one being sold`, "policy_refused");
  if (BigInt(`0x${arg(2)}`) !== expected.sellAmount) throw refuse(`${action.name} pulls an amount other than the input`, "policy_refused");
  if (BigInt(`0x${arg(3)}`) !== permit2.nonce || BigInt(`0x${arg(4)}`) !== permit2.deadline) throw refuse(`${action.name} carries a different permit than the one to be signed`, "policy_refused");
  const sigOffset = arg(action.sigWord);
  if (!/^0{56}/.test(sigOffset) || first.argsStart + parseInt(sigOffset.slice(56), 16) !== execute.bodyLength) {
    throw refuse(`${action.name} does not read its signature from the end of the data`, "policy_refused");
  }
  return {execute, permit2, permitAction: action.name};
}
