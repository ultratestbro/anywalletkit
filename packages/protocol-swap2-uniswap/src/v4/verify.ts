import {decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, type Hex} from "viem";
import {ccAsset, resolveAsset} from "@anywalletkit/swap2-assets";
import {refusalNotes, type Swap2RefusalInfo, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import {sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {
  SWAP_PROXY_ABI,
  SWAP_PROXY_EXECUTE_SELECTOR,
  UNISWAP_V4,
  UR_ABI,
  UR_COMMANDS,
  UR_EXECUTE_NO_DEADLINE_SELECTOR,
  UR_EXECUTE_SELECTOR,
  UR_EXECUTE_SIGNED_SELECTOR,
  UR_FLAG_ALLOW_REVERT,
  UR_FLAG_THIRD_PARTY,
  V4_ACTION_CONSTANTS,
  V4_ACTIONS,
  V4_EXACT_IN_ABI,
  V4_EXACT_IN_SINGLE_ABI,
  V4_LINKAGE_ABI,
  V4_NATIVE,
  V4_SETTLE_ABI,
  V4_SWAP_INPUT_ABI,
  V4_TAKE_ABI,
  uniswapV4DeploymentOf,
  type UniswapV4Deployment,
} from "./addresses.js";
import {encodeV4Swap, V4_MAX_HOPS, v4PoolsOfPath} from "./encode.js";
import {V4_MAX_LP_FEE, checkedMaxFeePips, isNativeCurrency, poolIdOf, sortCurrencies, v4PoolKeyProblem, type V4PoolKey} from "./pool.js";
import {KNOWN_TX_GAS_CAP} from "../impact.js";

/** Which v4 flows a check (or a provider) accepts: none, native input only, or native and token input. */
export type UniswapV4Mode = "off" | "native-in" | "all";

/** Seconds a v4 swap's deadline may lie ahead of now: the provider's `deadlineSeconds` default. */
export const V4_DEFAULT_DEADLINE_SECONDS = 600;
/** Clock skew allowed by default between the side that built the quote and the side that checks it (the deadline's
 *  upper bound); `clockSkewSeconds` sets another. */
export const V4_CLOCK_SKEW_SECONDS = 60;
/** The most clock skew a check may allow (`clockSkewSeconds`): an hour. */
export const V4_MAX_CLOCK_SKEW_SECONDS = 3_600;
/**
 * The per-transaction gas caps row 17 holds a quote's gas limit to: the provider's own table (`KNOWN_TX_GAS_CAP`,
 * src/impact.ts — 2^24 on Ethereum, OP, BNB, Unichain, World Chain, Base, Ink, Linea and Arc, 2^25 on Polygon, 30M on
 * Monad), one table for the build and the check. A limit above can never be mined.
 */
export const V4_KNOWN_TX_GAS_CAP: Readonly<Record<number, bigint>> = KNOWN_TX_GAS_CAP;
/** Catalog symbols a two-hop route may pass through, besides the native coin and the wrapped native (§6.5 row 8). */
export const V4_HOP_SYMBOLS = ["USDC", "USDT", "USDT0"] as const;

export interface UniswapV4VerifyOptions {
  /** The pinned table (default {@link UNISWAP_V4}). */
  deployments?: Readonly<Record<number, UniswapV4Deployment>>;
  /** Default "all": pins accept both flows a server may build; "native-in" refuses token input; "off" refuses all. */
  v4?: UniswapV4Mode;
  /** The shipped per-chain pool list. A pool must be in it or in `extraPools` (PoolId recomputed): provenance is never
   *  a server-supplied key alone. A chain with neither list refuses every v4 quote. A frozen list of frozen keys has its
   *  PoolIds cached; any other list is read anew on every call (a change to it is heard). */
  pools?: Readonly<Record<number, readonly V4PoolKey[]>>;
  /** The integrator's own pools (`v4ExtraPools`): hookless only, PoolId recomputed. */
  extraPools?: Readonly<Record<number, readonly V4PoolKey[]>>;
  /** Highest pool fee accepted, in pips (`v4MaxFeePips`: an integer 1..100,000, default 100,000 = 10%; the cap of owner
   *  decision 5 can be lowered, never raised — every pool, `extraPools` included, is held to it). */
  maxFeePips?: number;
  /** How far ahead the swap's deadline may be, in seconds (default 600: the provider builds every v4 deadline at most
   *  600 s ahead, whatever its `deadlineSeconds`). */
  deadlineSeconds?: number;
  /** Clock skew allowed on top of `deadlineSeconds` between the side that built the quote and this one (an integer
   *  0..3600; default {@link V4_CLOCK_SKEW_SECONDS}). */
  clockSkewSeconds?: number;
  /** Per chain, the currencies a two-hop route may pass through (replaces {@link v4HopTokens}' default set). */
  hopTokens?: Readonly<Record<number, readonly string[]>>;
  /** Opt-in (§7.2): refuse a quote whose impact measure G — the larger of `providerData.priceImpactBps` (the probe, fees
   *  excluded) and `providerData.valueLossBps` (the spot value loss, fees included), over the ones present — is at or
   *  above this, or that carries neither (or one that does not read as bps). Unset: impact is information, never a
   *  refusal. */
  maxPriceImpactBps?: number;
  /** Clock (unix ms), for tests. */
  now?: () => number;
}

/** A strictly decoded v4 swap call, before it is matched against a request. */
export interface DecodedV4Swap {
  flow: "native-in" | "swap-proxy";
  /** SwapProxy arguments (token input only): the router it forwards to, the token and the amount it pulls. */
  proxyRouter?: `0x${string}`;
  proxyToken?: `0x${string}`;
  proxyAmount?: bigint;
  deadline: bigint;
  /** The route's input currency (the swap's `currencyIn`, or the single pool's side `zeroForOne` names). */
  currencyIn: `0x${string}`;
  /** The pools in route order (from the PoolKey, or derived from the PathKeys). */
  pools: V4PoolKey[];
  /** Hop intermediates (path form; empty for a single pool). */
  intermediates: `0x${string}`[];
  /** The route's output currency (the other side of the single pool, or the last intermediate). */
  currencyOut: `0x${string}`;
  amountIn: bigint;
  amountOutMinimum: bigint;
  settle: {currency: `0x${string}`; amount: bigint; payerIsUser: boolean};
  take: {currency: `0x${string}`; recipient: `0x${string}`; amount: bigint};
}

/** The reasons of the texts the v4 checks returned, for a pins object's `reasonOf`. */
const notes = refusalNotes();
type Refused = {ok: false; text: string};
const no = (text: string, reason: Swap2RefusalReason): Refused => ({ok: false, text: notes.note(text, reason)});

/** The classification of a text {@link uniswapV4VerifyQuote} or {@link decodeV4SwapCall} returned. */
export function uniswapV4ReasonOf(text: string): Swap2RefusalInfo | undefined {
  return notes.reasonOf(text);
}

const lower = (h: string) => h.toLowerCase();
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x([0-9a-fA-F]{2})*$/;
const actionName = (a: number) => Object.entries(V4_ACTIONS).find(([, v]) => v === a)?.[0] ?? `0x${a.toString(16).padStart(2, "0")}`;
const commandName = (c: number) => Object.entries(UR_COMMANDS).find(([, v]) => v === (c & 0x3f))?.[0] ?? `0x${c.toString(16).padStart(2, "0")}`;
function bytesOf(hex: Hex): number[] {
  const out: number[] = [];
  for (let i = 2; i < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return out;
}
/** Decode, re-encode, compare: anything but the canonical encoding (trailing bytes, dirty padding, non-standard
 *  offsets, the other struct layout) is refused — the router's decoders are hand-written assembly with caller-controlled
 *  offsets, so a non-canonical blob could read differently there than here. */
function strictParams<T extends readonly unknown[]>(abi: Parameters<typeof decodeAbiParameters>[0], data: Hex): T | null {
  try {
    const values = decodeAbiParameters(abi, data);
    const again = encodeAbiParameters(abi, values as readonly unknown[] as never);
    return lower(again) === lower(data) ? (values as unknown as T) : null;
  } catch {
    return null;
  }
}

/**
 * Strict decode of a v4 swap call (§6.5 rows 2, 4, 5, 7): the selector is `UR.execute(bytes,bytes[],uint256)` or
 * `SwapProxy.execute`, every level is decoded with the pinned UR 2.1.x layout and re-encoded byte-equal (the outer call,
 * `inputs[0]`, the `(actions, params)` pair, each param), `commands` is exactly `0x10`, and the actions are exactly
 * `[SWAP_EXACT_IN_SINGLE | SWAP_EXACT_IN, SETTLE, TAKE]`. It does not judge targets, amounts or recipients against a
 * request — {@link uniswapV4VerifyQuote} does.
 */
export function decodeV4SwapCall(data: string): {ok: true; swap: DecodedV4Swap} | Refused {
  if (typeof data !== "string" || !HEX.test(data) || data.length < 10) return no("the call carries no calldata", "policy_refused");
  const selector = lower(data.slice(0, 10));
  if (selector === UR_EXECUTE_NO_DEADLINE_SELECTOR) return no("the call is execute(bytes,bytes[]) without a deadline — only execute(bytes,bytes[],uint256) is accepted", "policy_refused");
  if (selector === UR_EXECUTE_SIGNED_SELECTOR) return no("the call is executeSigned — only execute(bytes,bytes[],uint256) is accepted", "policy_refused");
  let commands: Hex, inputs: readonly Hex[], deadline: bigint;
  let flow: DecodedV4Swap["flow"];
  let router: `0x${string}` | undefined, proxyToken: `0x${string}` | undefined, proxyAmount: bigint | undefined;
  try {
    if (selector === UR_EXECUTE_SELECTOR) {
      const decoded = decodeFunctionData({abi: UR_ABI, data: data as Hex});
      if (decoded.functionName !== "execute") return no("the call is not UniversalRouter.execute", "policy_refused");
      const args = decoded.args as readonly [Hex, readonly Hex[], bigint];
      if (lower(encodeFunctionData({abi: UR_ABI, functionName: "execute", args})) !== lower(data)) return no("the router call is not canonically encoded (trailing or non-canonical bytes)", "policy_refused");
      [commands, inputs, deadline] = args;
      flow = "native-in";
    } else if (selector === SWAP_PROXY_EXECUTE_SELECTOR) {
      const decoded = decodeFunctionData({abi: SWAP_PROXY_ABI, data: data as Hex});
      const args = decoded.args as readonly [`0x${string}`, `0x${string}`, bigint, Hex, readonly Hex[], bigint];
      if (lower(encodeFunctionData({abi: SWAP_PROXY_ABI, functionName: "execute", args})) !== lower(data)) return no("the SwapProxy call is not canonically encoded (trailing or non-canonical bytes)", "policy_refused");
      [router, proxyToken, proxyAmount, commands, inputs, deadline] = [getAddress(args[0]), getAddress(args[1]), args[2], args[3], args[4], args[5]];
      flow = "swap-proxy";
    } else {
      return no(`the call's selector ${selector} is neither UniversalRouter.execute(bytes,bytes[],uint256) nor SwapProxy.execute`, "policy_refused");
    }
  } catch {
    return no("the call does not decode as UniversalRouter.execute / SwapProxy.execute", "policy_refused");
  }

  // §6.5 row 5: one command, V4_SWAP, no allow-revert or third-party bit.
  const cmds = bytesOf(commands);
  const flagged = cmds.find((c) => (c & (UR_FLAG_ALLOW_REVERT | UR_FLAG_THIRD_PARTY)) !== 0);
  if (flagged !== undefined) return no(`command 0x${flagged.toString(16).padStart(2, "0")} has the allow-revert (0x80) or third-party (0x40) bit — refused`, "policy_refused");
  if (cmds.length !== 1 || cmds[0] !== UR_COMMANDS.V4_SWAP) {
    const other = cmds.find((c) => c !== UR_COMMANDS.V4_SWAP);
    return no(other !== undefined ? `command ${commandName(other)} is not allowed — the only command is V4_SWAP` : `the plan has ${cmds.length} commands, not one V4_SWAP`, "policy_refused");
  }
  if (inputs.length !== 1) return no(`the plan has ${inputs.length} inputs for one command`, "policy_refused");

  // §6.5 rows 4 and 7: the V4_SWAP input, strictly, and its actions.
  const v4 = strictParams<readonly [Hex, readonly Hex[]]>(V4_SWAP_INPUT_ABI, inputs[0]!);
  if (!v4) return no("the V4_SWAP input is not canonically encoded", "policy_refused");
  const [actionsHex, params] = v4;
  const actions = bytesOf(actionsHex);
  if (actions.length !== params.length) return no("the V4_SWAP actions and params differ in length", "policy_refused");
  const shapeOk = actions.length === 3 && (actions[0] === V4_ACTIONS.SWAP_EXACT_IN_SINGLE || actions[0] === V4_ACTIONS.SWAP_EXACT_IN) && actions[1] === V4_ACTIONS.SETTLE && actions[2] === V4_ACTIONS.TAKE;
  if (!shapeOk) {
    const allowed = new Set<number>([V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SWAP_EXACT_IN, V4_ACTIONS.SETTLE, V4_ACTIONS.TAKE]);
    const off = actions.find((a) => !allowed.has(a));
    return no(off !== undefined ? `action ${actionName(off)} is not allowed — the only actions are a swap, SETTLE and TAKE` : `the actions [${actions.map(actionName).join(", ")}] are not [SWAP_EXACT_IN(_SINGLE), SETTLE, TAKE]`, "policy_refused");
  }

  let pools: V4PoolKey[], intermediates: `0x${string}`[], currencyIn: `0x${string}`, currencyOut: `0x${string}`, amountIn: bigint, amountOutMinimum: bigint;
  if (actions[0] === V4_ACTIONS.SWAP_EXACT_IN_SINGLE) {
    const decoded = strictParams<readonly [{poolKey: V4PoolKey; zeroForOne: boolean; amountIn: bigint; amountOutMinimum: bigint; minHopPriceX36: bigint; hookData: Hex}]>(V4_EXACT_IN_SINGLE_ABI, params[0]!);
    if (!decoded) return no("the SWAP_EXACT_IN_SINGLE params are not the UR 2.1.x layout, canonically encoded", "policy_refused");
    const p = decoded[0];
    if (p.minHopPriceX36 !== 0n) return no("the swap sets a per-hop minimum price (minHopPriceX36 must be 0)", "policy_refused");
    if (p.hookData !== "0x") return no("the swap carries hookData (hookless pools take none)", "policy_refused");
    const key = {currency0: getAddress(p.poolKey.currency0), currency1: getAddress(p.poolKey.currency1), fee: p.poolKey.fee, tickSpacing: p.poolKey.tickSpacing, hooks: getAddress(p.poolKey.hooks)};
    pools = [key];
    intermediates = [];
    currencyIn = p.zeroForOne ? key.currency0 : key.currency1;
    currencyOut = p.zeroForOne ? key.currency1 : key.currency0;
    amountIn = p.amountIn;
    amountOutMinimum = p.amountOutMinimum;
  } else {
    const decoded = strictParams<readonly [{currencyIn: `0x${string}`; path: readonly {intermediateCurrency: `0x${string}`; fee: number; tickSpacing: number; hooks: `0x${string}`; hookData: Hex}[]; minHopPriceX36: readonly bigint[]; amountIn: bigint; amountOutMinimum: bigint}]>(V4_EXACT_IN_ABI, params[0]!);
    if (!decoded) return no("the SWAP_EXACT_IN params are not the UR 2.1.x layout, canonically encoded", "policy_refused");
    const p = decoded[0];
    if (p.path.length < 1 || p.path.length > V4_MAX_HOPS) return no(`the path crosses ${p.path.length} pools, not 1–${V4_MAX_HOPS}`, "policy_refused");
    if (p.minHopPriceX36.length !== 0) return no("the swap sets per-hop minimum prices (minHopPriceX36 must be empty)", "policy_refused");
    if (p.path.some((h) => h.hookData !== "0x")) return no("a hop carries hookData (hookless pools take none)", "policy_refused");
    currencyIn = getAddress(p.currencyIn);
    intermediates = p.path.map((h) => getAddress(h.intermediateCurrency));
    const seen = new Set<string>([currencyIn, ...intermediates]);
    if (seen.size !== intermediates.length + 1) return no("the path visits a currency twice (a cycle)", "policy_refused");
    pools = v4PoolsOfPath(currencyIn, p.path);
    currencyOut = intermediates[intermediates.length - 1]!;
    amountIn = p.amountIn;
    amountOutMinimum = p.amountOutMinimum;
  }
  const settleArgs = strictParams<readonly [`0x${string}`, bigint, boolean]>(V4_SETTLE_ABI, params[1]!);
  if (!settleArgs) return no("the SETTLE params are not canonically encoded", "policy_refused");
  const takeArgs = strictParams<readonly [`0x${string}`, `0x${string}`, bigint]>(V4_TAKE_ABI, params[2]!);
  if (!takeArgs) return no("the TAKE params are not canonically encoded", "policy_refused");
  return {
    ok: true,
    swap: {
      flow,
      ...(router !== undefined ? {proxyRouter: router} : {}),
      ...(proxyToken !== undefined ? {proxyToken} : {}),
      ...(proxyAmount !== undefined ? {proxyAmount} : {}),
      deadline,
      currencyIn,
      pools,
      intermediates,
      currencyOut,
      amountIn,
      amountOutMinimum,
      settle: {currency: getAddress(settleArgs[0]), amount: settleArgs[1], payerIsUser: settleArgs[2]},
      take: {currency: getAddress(takeArgs[0]), recipient: getAddress(takeArgs[1]), amount: takeArgs[2]},
    },
  };
}

/** The currencies a two-hop route may pass through on a chain: the native coin and the wrapped native (where the
 *  native coin is not itself an ERC-20), the catalog's USDC / USDT / USDT0, or the caller's own list. */
export function v4HopTokens(chainId: number, d: UniswapV4Deployment, override?: readonly string[]): ReadonlySet<string> {
  if (override) return new Set(override.filter((a) => ADDRESS.test(a)).map((a) => getAddress(a)));
  const out = new Set<string>();
  if (d.nativeWrap !== false) out.add(getAddress(V4_NATIVE));
  if (d.weth) out.add(getAddress(d.weth));
  for (const sym of V4_HOP_SYMBOLS) {
    const c = ccAsset(`eip155:${chainId}`, sym)?.contract;
    if (c && ADDRESS.test(c)) out.add(getAddress(c));
  }
  return out;
}

/**
 * PoolIds per list, cached only for a list nobody can change afterwards: a frozen array of frozen keys (the shipped
 * `UNISWAP_V4_POOL_KEYS` lists, the pins' own copies of `v4ExtraPools`). Any other array is read anew on every
 * call (SEC-U4-R2-1): a cache keyed by a mutable array's identity kept accepting a pool the caller had since removed
 * from it — provenance failing open.
 */
const poolIdCache = new WeakMap<readonly V4PoolKey[], ReadonlySet<string>>();
function poolIds(list: readonly V4PoolKey[] | undefined): ReadonlySet<string> {
  if (!list) return new Set();
  const hit = poolIdCache.get(list);
  if (hit) return hit;
  const ids = new Set<string>();
  for (const key of list) {
    try {
      if (v4PoolKeyProblem(key, V4_MAX_LP_FEE) === null) ids.add(lower(poolIdOf(key)));
    } catch {
      /* a malformed listed key is not a pool */
    }
  }
  // Frozen is for good: a frozen array of frozen keys (whose fields are strings and numbers) reads the same forever.
  if (Object.isFrozen(list) && list.every((k) => Object.isFrozen(k))) poolIdCache.set(list, ids);
  return ids;
}
const own = <T>(rec: Readonly<Record<number, T>> | undefined, id: number): T | undefined =>
  rec && Object.prototype.hasOwnProperty.call(rec, id) ? rec[id] : undefined;

/** Addresses a swap must never pay: the router sentinels, the zero address and the pinned contracts (output paid to
 *  them is stranded or anyone's to sweep). */
function forbiddenRecipients(d: UniswapV4Deployment): ReadonlySet<string> {
  return new Set([V4_NATIVE, V4_ACTION_CONSTANTS.MSG_SENDER, V4_ACTION_CONSTANTS.ADDRESS_THIS, d.universalRouter, d.swapProxy, d.poolManager, d.positionManager, d.quoter, d.stateView, d.permit2].map((a) => getAddress(a)));
}

/**
 * The v4 swap a Uniswap quote's call makes, opened on the client against the app's own request — the whole on-device
 * check list of UNISWAP-V4-RESEARCH §6.5 that can be judged from the quote (rows 1–14, 17, 18; rows 15–16 are the
 * on-chain {@link v4DeploymentReads} / {@link v4DeploymentProblem} and the preflight `eth_call` of {@link v4PreflightCall}
 * classified by `classifyV4Revert`). Fail closed: the reason it fails, or null.
 *
 * Native input: `tx.to` is the chain's pinned Universal Router 2.1.2, `value == amountIn`, no approval. Token input
 * (SwapProxy, S1–S14): `tx.to` is the chain's pinned SwapProxy, its `router` the pinned UR, `token` the request's
 * catalog ERC-20, `amount == amountIn`, `value == 0`, `approvalAddress == SwapProxy`. Inside: `commands == 0x10`, the
 * actions `[0x06 | 0x07, 0x0b, 0x0e]` in the UR 2.1.x layout, ≤ 2 hookless pools from the pinned list (or
 * `extraPools`) with a fee ≤ `maxFeePips`, intermediates from the hop set, `SETTLE(currencyIn, amountIn, false)`,
 * `TAKE(currencyOut, destAddress, 0)`, `amountOutMinimum == minDestAmount`, a deadline in (now, now + deadlineSeconds],
 * and the whole call byte-equal to this module's own encoding of the decoded route. S14 (a native output to a recipient
 * that cannot take it) cannot be judged from calldata: the preflight `eth_call` reverts `NativeTransferFailed`, which
 * `classifyV4Revert` maps to `recipient_mismatch`.
 *
 * Without `options.pools` / `options.extraPools` for the chain every v4 quote is refused (pool provenance, row 9): the
 * caller binds the shipped pool list. `options.v4` defaults to "all" because these are the app's pins: an app that
 * bumped them accepts what the server's `v4` flag lets it build; the provider's own default stays "off".
 */
export function uniswapV4VerifyQuote(params: QuoteParams, quote: Quote, options: UniswapV4VerifyOptions = {}): string | null {
  try {
    return check(params, quote, options);
  } catch {
    return notes.note("the v4 quote could not be checked", "policy_refused");
  }
}

function check(params: QuoteParams, quote: Quote, options: UniswapV4VerifyOptions): string | null {
  const mode = options.v4 ?? "all";
  let maxFee: number;
  try {
    maxFee = checkedMaxFeePips(options.maxFeePips); // owner decision 5: 1..100,000, lowered but never raised
  } catch {
    return notes.note("v4MaxFeePips must be an integer in 1..100000", "policy_refused");
  }
  const deadlineS = options.deadlineSeconds ?? V4_DEFAULT_DEADLINE_SECONDS;
  const skewS = options.clockSkewSeconds ?? V4_CLOCK_SKEW_SECONDS;
  if (!Number.isInteger(deadlineS) || deadlineS <= 0) return notes.note("deadlineSeconds must be a positive integer", "policy_refused");
  if (!Number.isInteger(skewS) || skewS < 0 || skewS > V4_MAX_CLOCK_SKEW_SECONDS) return notes.note(`clockSkewSeconds must be an integer in 0..${V4_MAX_CLOCK_SKEW_SECONDS}`, "policy_refused");

  // Row 1: the chain, pinned and enabled.
  const id = /^eip155:[0-9]+$/.test(params.sourceChain) ? Number(params.sourceChain.slice(7)) : NaN;
  const d = uniswapV4DeploymentOf(id, options.deployments ?? UNISWAP_V4);
  if (!d || params.destChain !== params.sourceChain) return notes.note("not a same-chain swap on a pinned Uniswap v4 deployment", "unsupported_pair");
  if (mode === "off") return notes.note("Uniswap v4 is off", "policy_refused");
  if (d.quotable === false) return notes.note(`Uniswap v4 is not quoted on chain ${id}`, "unsupported_pair");
  if (d.routerBuild !== "2.1.2") return notes.note(`the pinned router build ${String(d.routerBuild)} is not 2.1.2`, "vault_mismatch");
  const tx = quote.txRequest;
  if (!tx || typeof tx.data !== "string" || typeof tx.to !== "string" || tx.serializedTx !== undefined) return notes.note("the quote carries no router call", "policy_refused");
  if (tx.permit2Transfer !== undefined) return notes.note("a v4 swap signs no Permit2 transfer", "policy_refused");
  if (tx.nativeFee !== undefined && tx.nativeFee !== "0") return notes.note("a v4 swap charges no native fee on top of the input", "policy_refused");
  if (tx.chainId !== undefined && tx.chainId !== id) return notes.note(`the transaction is for chain ${tx.chainId}, not ${id}`, "policy_refused");

  // The request, as the app made it.
  const src = sourceAssetOf(params);
  if (!src) return notes.note(`unknown source token ${params.sourceToken}`, "unsupported_pair");
  const nativeIn = !src.contract;
  const nativeOut = /^0x0+$/.test(params.destToken);
  if ((nativeIn || nativeOut) && d.nativeWrap === false) return notes.note("this chain's native coin is an ERC-20 — swap that instead", "unsupported_pair");
  if (nativeIn && nativeOut) return notes.note("native in and out is not a swap", "unsupported_pair");
  if (!nativeIn && mode === "native-in") return notes.note("Uniswap v4 token input is off (native input only)", "policy_refused");
  // S4: the SwapProxy pulls the token before the router locks, so only catalog tokens ride it (no callback tokens).
  if (!nativeIn && !resolveAsset(params.sourceChain, params.sourceToken)) return notes.note("the SwapProxy flow takes catalog tokens only", "unsupported_pair");
  if (!nativeOut && !ADDRESS.test(params.destToken)) return notes.note("destination token must be an EVM address", "unsupported_pair");
  if (!ADDRESS.test(params.destAddress)) return notes.note("recipient must be an EVM address", "recipient_mismatch");
  if (!nativeIn && !(typeof src.contract === "string" && ADDRESS.test(src.contract))) return notes.note(`unknown source token ${params.sourceToken}`, "unsupported_pair");
  const currencyIn = getAddress(nativeIn ? V4_NATIVE : src.contract!);
  const currencyOut = getAddress(nativeOut ? V4_NATIVE : params.destToken);
  if (currencyIn === currencyOut) return notes.note("same token in and out", "unsupported_pair");
  const recipient = getAddress(params.destAddress);
  if (forbiddenRecipients(d).has(recipient)) return notes.note(`the recipient ${recipient} is a router sentinel or a pinned Uniswap contract — output paid there is stranded`, "recipient_mismatch");
  if (!/^[0-9]+$/.test(params.amountIn) || !/^[0-9]+$/.test(quote.minDestAmount) || !/^[0-9]+$/.test(quote.sourceAmount)) return notes.note("the request or the quote does not carry integer amounts", "policy_refused");
  const amountIn = BigInt(params.amountIn);
  const minOut = BigInt(quote.minDestAmount);
  if (amountIn <= 0n) return notes.note("the input amount is zero", "policy_refused");
  if (minOut <= 0n) return notes.note("the quote's minimum output is zero", "price_check_failed");
  if (params.minAmountOut !== undefined && (!/^[0-9]+$/.test(params.minAmountOut) || minOut < BigInt(params.minAmountOut))) return notes.note("the quote's minimum is under the requested floor", "price_check_failed");
  // Row 14 / S5 / S13: the engine approves the quote's source amount; it must be the request's input exactly.
  if (BigInt(quote.sourceAmount) !== amountIn) return notes.note("the quote spends another amount than the request's input", "policy_refused");

  // Row 1 / S1: the target.
  const target = getAddress(nativeIn ? d.universalRouter : d.swapProxy);
  if (!ADDRESS.test(tx.to) || getAddress(tx.to) !== target) return notes.note(`the call targets ${tx.to}, not the pinned ${nativeIn ? "Universal Router 2.1.2" : "SwapProxy"}`, "vault_mismatch");
  // Rows 13–14 / S12–S13: value and approval.
  if (tx.value !== undefined && !/^[0-9]+$/.test(tx.value)) return notes.note("the transaction value is not an integer", "policy_refused");
  const value = BigInt(tx.value ?? "0");
  if (nativeIn ? value !== amountIn || tx.approvalAddress !== undefined : value !== 0n || typeof tx.approvalAddress !== "string" || !ADDRESS.test(tx.approvalAddress) || getAddress(tx.approvalAddress) !== getAddress(d.swapProxy)) {
    return notes.note(nativeIn ? "a native input is paid as exactly the input in value, with no approval" : "a token input attaches no value and approves the SwapProxy only", "policy_refused");
  }

  // Rows 2, 4, 5, 7: strict decode.
  const decoded = decodeV4SwapCall(tx.data);
  if (!decoded.ok) return decoded.text;
  const s = decoded.swap;
  if (s.flow !== (nativeIn ? "native-in" : "swap-proxy")) return notes.note(nativeIn ? "a native input calls the router directly" : "a token input goes through SwapProxy.execute", "policy_refused");
  if (!nativeIn) {
    // Row 3 / S3–S5: the SwapProxy's arguments.
    if (s.proxyRouter !== getAddress(d.universalRouter)) return notes.note(`the SwapProxy forwards to ${s.proxyRouter ?? "no router"}, not the pinned Universal Router 2.1.2`, "vault_mismatch");
    if (s.proxyToken !== currencyIn) return notes.note("the SwapProxy pulls another token than the request's input", "policy_refused");
    if (s.proxyAmount !== amountIn) return notes.note("the SwapProxy pulls another amount than the request's input", "policy_refused");
  }

  // Row 6 / S11: the deadline.
  const nowS = BigInt(Math.floor((options.now ?? Date.now)() / 1000));
  if (s.deadline <= nowS) return notes.note("the swap's deadline has passed", "quote_expired");
  if (s.deadline > nowS + BigInt(deadlineS + skewS)) return notes.note(`the swap's deadline is more than ${deadlineS} s ahead`, "policy_refused");

  // Row 8: the route's currencies.
  if (s.currencyIn !== currencyIn) return notes.note(isNativeCurrency(currencyIn) ? "the swap sells another currency than the native coin (never the wrapped token in its place)" : "the swap sells another currency than the request's input", "policy_refused");
  if (s.currencyOut !== currencyOut) return notes.note(isNativeCurrency(currencyOut) ? "the swap buys another currency than the native coin (never the wrapped token in its place)" : "the swap buys another currency than the request's output", "policy_refused");
  if (s.pools.length === 1) {
    const [c0, c1] = sortCurrencies(currencyIn, currencyOut);
    const k = s.pools[0]!;
    if (k.currency0 !== c0 || k.currency1 !== c1) return notes.note("the pool's currencies are not the pair in PoolKey order", "policy_refused");
  } else {
    const hops = own(options.hopTokens, id);
    const hopSet = v4HopTokens(id, d, hops);
    for (const mid of s.intermediates.slice(0, -1)) if (!hopSet.has(mid)) return notes.note(`the route passes through ${mid}, which is not a pinned hop currency`, "policy_refused");
  }
  // Row 9: every pool — hookless, fee cap, tick spacing, and in the pinned list (provenance).
  const listed = poolIds(own(options.pools, id));
  const extra = poolIds(own(options.extraPools, id));
  if (listed.size === 0 && extra.size === 0) return notes.note(`no pinned Uniswap v4 pool list for chain ${id}`, "policy_refused");
  for (const key of s.pools) {
    const problem = v4PoolKeyProblem(key, maxFee);
    if (problem) return notes.note(problem, "policy_refused");
    const pid = lower(poolIdOf(key));
    if (!listed.has(pid) && !extra.has(pid)) return notes.note(`the pool ${pid} is not in the pinned pool list`, "policy_refused");
  }
  // Row 10: amounts.
  if (s.amountIn !== amountIn) return notes.note("the swap's input is not the request's", "price_check_failed");
  if (s.amountOutMinimum !== minOut) return notes.note("the swap's minimum is not the quote's", "price_check_failed");
  // Row 11 / S8: exact SETTLE.
  if (s.settle.currency !== currencyIn) return notes.note("SETTLE pays another currency than the input", "policy_refused");
  if (s.settle.amount !== amountIn) {
    const what = s.settle.amount === V4_ACTION_CONSTANTS.OPEN_DELTA ? "OPEN_DELTA" : s.settle.amount === V4_ACTION_CONSTANTS.CONTRACT_BALANCE ? "CONTRACT_BALANCE" : String(s.settle.amount);
    return notes.note(`SETTLE pays ${what}, not exactly the input (unspent input would stay in the router)`, "policy_refused");
  }
  if (s.settle.payerIsUser) return notes.note("SETTLE pulls from the user (payerIsUser must be false)", "policy_refused");
  // Row 12 / S9: TAKE the whole output to the explicit recipient.
  if (s.take.currency !== currencyOut) return notes.note("TAKE takes another currency than the output", "policy_refused");
  if (s.take.recipient !== recipient) return notes.note(`TAKE pays ${s.take.recipient}, not the recipient`, "recipient_mismatch");
  if (s.take.amount !== 0n) return notes.note("TAKE names an amount (it must take the whole output, amount 0)", "policy_refused");

  // Row 4, whole call: byte-equal to this module's own encoding of the decoded route.
  const again = encodeV4Swap({chainId: id, currencyIn, currencyOut, pools: s.pools, amountIn, amountOutMinimum: minOut, recipient, deadline: s.deadline}, options.deployments ?? UNISWAP_V4);
  if (lower(again.data) !== lower(tx.data) || again.to !== target || again.value !== value) return notes.note("the call is not this module's canonical encoding of its own route", "policy_refused");

  // Row 17: a gas limit the chain can never mine.
  if (tx.gasLimit !== undefined) {
    if (!/^[0-9]+$/.test(tx.gasLimit) || BigInt(tx.gasLimit) <= 0n) return notes.note("the quote's gas limit is not a positive integer", "policy_refused");
    const cap = own(KNOWN_TX_GAS_CAP, id);
    if (cap !== undefined && BigInt(tx.gasLimit) > cap) return notes.note(`the quote's gas limit ${tx.gasLimit} is above the chain's per-transaction cap ${cap}`, "policy_refused");
  }
  // Row 18: impact is information unless the app set a limit.
  if (options.maxPriceImpactBps !== undefined) {
    const limit = options.maxPriceImpactBps;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) return notes.note("maxPriceImpactBps must be an integer in 1..10000", "policy_refused");
    // G = max(probe, spot) over the measures the quote carries (§7.2), as the provider gates: the probe alone is blind to
    // a pool parked past an empty range, and a gated quote whose probe could not run carries the spot measure alone.
    const pd = quote.providerData ?? {};
    const measured: number[] = [];
    for (const field of ["priceImpactBps", "valueLossBps"] as const) {
      const raw: unknown = pd[field];
      if (raw === undefined) continue;
      if (typeof raw !== "string" || !/^[0-9]{1,5}$/.test(raw)) return notes.note(`the quote carries no price-impact measure it can read (${field})`, "upstream_unavailable");
      measured.push(Number(raw));
    }
    if (measured.length === 0) return notes.note("the quote carries no price-impact measure", "upstream_unavailable");
    const bps = Math.max(...measured);
    if (bps >= limit) return notes.note(`loses ${(bps / 100).toFixed(2)}% of the value to price impact (limit ${(limit / 100).toFixed(2)}%)`, "insufficient_liquidity");
  }
  return null;
}

// ── Row 15: the deployment check, once per chain per session ─────────────────────────────────────────────────────

/** A JSON-RPC call (`eth_call` / `eth_getCode` at `latest`). */
export interface V4RpcCall {
  method: string;
  params: unknown[];
}

/** What a deployment check covers: by default the router, quoter, StateView and SwapProxy; `swapProxy: false` leaves
 *  the SwapProxy out (native input never calls it, so its build is not a fact the native-input path depends on). */
export interface V4DeploymentCheckOptions {
  swapProxy?: boolean;
}

/** The reads of the §6.5 row 15 deployment check, in order: `poolManager()` of the router, the quoter and the
 *  StateView, then the runtime code of the router and (unless `swapProxy: false`) the SwapProxy (their codehashes are
 *  pinned). */
export function v4DeploymentReads(d: UniswapV4Deployment, options: V4DeploymentCheckOptions = {}): V4RpcCall[] {
  const pm = encodeFunctionData({abi: V4_LINKAGE_ABI, functionName: "poolManager"});
  const call = (to: string): V4RpcCall => ({method: "eth_call", params: [{to, data: pm}, "latest"]});
  const reads: V4RpcCall[] = [call(d.universalRouter), call(d.quoter), call(d.stateView), {method: "eth_getCode", params: [d.universalRouter, "latest"]}];
  if (options.swapProxy !== false) reads.push({method: "eth_getCode", params: [d.swapProxy, "latest"]});
  return reads;
}

/** Why the answers to {@link v4DeploymentReads} (with the same options) do not describe the pinned deployment, or null.
 *  A missing answer is a failure, never a pass. */
export function v4DeploymentProblem(d: UniswapV4Deployment, answers: readonly unknown[], options: V4DeploymentCheckOptions = {}): string | null {
  const proxy = options.swapProxy !== false;
  if (answers.length !== (proxy ? 5 : 4)) return "the deployment check got no answer";
  const addr = (r: unknown) => (typeof r === "string" && /^0x[0-9a-fA-F]{64}$/.test(r) ? getAddress(`0x${r.slice(-40)}`) : null);
  const pm = getAddress(d.poolManager);
  const names = ["Universal Router", "V4Quoter", "StateView"];
  for (let i = 0; i < 3; i++) if (addr(answers[i]) !== pm) return `the ${names[i]} does not report the pinned PoolManager`;
  const hash = (r: unknown) => (typeof r === "string" && HEX.test(r) && r.length > 2 ? lower(keccak256(r as Hex)) : null);
  if (hash(answers[3]) !== lower(d.routerCodehash)) return "the Universal Router's code is not the pinned 2.1.2 build";
  if (proxy && hash(answers[4]) !== lower(d.swapProxyCodehash)) return "the SwapProxy's code is not the pinned build";
  return null;
}

// ── Row 16: the preflight eth_call ───────────────────────────────────────────────────────────────────────────────

/** The storage slot of `allowance[owner][spender]` in a Solidity `mapping(address => mapping(address => uint256))` at
 *  `mappingSlot` (Monad USDC: slot 10). For the Monad preflight without `eth_simulateV1` (decision 9): set that slot by
 *  `stateDiff` and `eth_call` / `eth_estimateGas` the exact SwapProxy call from the bare account. The slot of a given
 *  token is found at runtime (`eth_createAccessList` plus a read-back) — never assumed. */
export function erc20AllowanceSlot(owner: string, spender: string, mappingSlot: bigint): Hex {
  const inner = keccak256(encodeAbiParameters(SLOT_KEY_ABI, [getAddress(owner), mappingSlot]));
  return keccak256(encodeAbiParameters(SLOT_KEY_ABI_B32, [getAddress(spender), inner]));
}
const SLOT_KEY_ABI = [{type: "address"}, {type: "uint256"}] as const;
const SLOT_KEY_ABI_B32 = [{type: "address"}, {type: "bytes32"}] as const;

/** A `stateDiff` override that sets one storage word of `token` (e.g. the allowance slot) to `value`. */
export function v4StorageOverride(token: string, slot: Hex, value: bigint): Record<string, {stateDiff: Record<string, Hex>}> {
  return {[getAddress(token)]: {stateDiff: {[slot]: `0x${value.toString(16).padStart(64, "0")}`}}};
}

/** The `eth_call` (or `eth_estimateGas`) of the exact swap from its sender at `latest` (right before signing; for token
 *  input after the approval, or with the allowance set by `stateOverride` where `eth_simulateV1` is not served). Its
 *  revert data goes to `classifyV4Revert`; no answer is a refusal, never a pass. */
export function v4PreflightCall(tx: {to: string; data: string; value?: string}, from: string, options: {stateOverride?: Record<string, unknown>; method?: "eth_call" | "eth_estimateGas"} = {}): V4RpcCall {
  const value = BigInt(tx.value ?? "0");
  const params: unknown[] = [{from: getAddress(from), to: getAddress(tx.to), data: tx.data, value: `0x${value.toString(16)}`}, "latest"];
  if (options.stateOverride) params.push(options.stateOverride);
  return {method: options.method ?? "eth_call", params};
}
