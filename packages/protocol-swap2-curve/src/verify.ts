import {decodeFunctionResult, encodeFunctionData, keccak256, type Hex as ViemHex} from "viem";
import {sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import {slippageFloor} from "@anywalletkit/protocol-swap2-core/validate";
import type {Quote, QuoteParams, RemotePins, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {refusal, refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import {ADDRESS_PROVIDER_ABI, COINS_INT, COINS_UINT, EXCHANGE_SELECTOR, VERSION_ABI, decodeExchange, encodeGetDy, type DecodedExchange} from "./abi.js";
import {CURVE_DEPLOYMENTS, ZERO_ADDRESS, chainIdOf, deploymentOf, type CurveDeployment} from "./deployments.js";
import {CURVE_POOLS} from "./pools/index.js";
import type {CurveChainPools, CurvePool, Hex} from "./pools/types.js";
import {checkRoute, poolIndex, routePools} from "./routes.js";
import {ethCall, rpcClient, wordAddress, wordUint, type RpcCall} from "./rpc.js";
import {curveIntentChain} from "./intent.js";
import {curveAutoSlippageBps, curveImpactBps} from "./slippage.js";
import {notes, noted} from "./reasons.js";

export interface CurveTables {
  /** Override the deployments (tests). */
  deployments?: Readonly<Record<number, CurveDeployment>>;
  /** Override the pool allowlist (tests). */
  pools?: Readonly<Record<number, CurveChainPools>>;
}

const lc = (a: string) => a.toLowerCase();
const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const own = <T>(o: Readonly<Record<number, T>>, k: number): T | undefined => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/**
 * The check of a Curve quote's router call against the app's own request, with the tables it uses. The returned
 * function is {@link curveVerifyQuote} for the shipped tables: synchronous, no I/O — the allowlist is static.
 */
export function curveQuoteCheck(tables: CurveTables = {}): (params: QuoteParams, quote: Quote) => string | null {
  const deployments = tables.deployments ?? CURVE_DEPLOYMENTS;
  const pools = tables.pools ?? CURVE_POOLS;
  return function verify(params: QuoteParams, quote: Quote): string | null {
    const chainId = chainIdOf(params.sourceChain);
    const d = deploymentOf(deployments, chainId);
    if (!d || params.destChain !== params.sourceChain) return noted("not a same-chain swap on a pinned Curve router", "unsupported_pair");
    const tx = quote.txRequest;
    if (!tx?.data || !tx.to || tx.serializedTx !== undefined) return noted("the quote carries no router call", "policy_refused");
    if (!isAddress(tx.to) || lc(tx.to) !== lc(d.router)) return noted(`the call targets ${tx.to}, not the Curve router`, "vault_mismatch");
    if (tx.chainId !== undefined && tx.chainId !== chainId) return noted(`the call is for chain ${tx.chainId}`, "policy_refused");
    // The chain the build's on-chain checks and the receipt tracking run on (`curve:<chainId>:…`): this request's.
    if (curveIntentChain(quote.intentId) !== chainId) return noted(`the quote names ${String(quote.intentId).slice(0, 40)}, not a curve:${chainId} swap`, "policy_refused");
    const src = sourceAssetOf(params);
    if (!src) return noted(`unknown source token ${params.sourceToken}`, "unsupported_pair");
    const nativeIn = !src.contract;
    const nativeOut = /^0x0+$/.test(params.destToken);
    if (!nativeOut && !isAddress(params.destToken)) return noted("destination token must be an EVM address", "unsupported_pair");
    if (!isAddress(params.destAddress)) return noted("recipient must be an EVM address", "recipient_mismatch");
    if ((!nativeIn && lc(src.contract!) === lc(d.eth)) || (!nativeOut && lc(params.destToken) === lc(d.eth))) return noted("the router's native sentinel is not a token", "unsupported_pair");
    const tokenIn = nativeIn ? d.eth : src.contract!;
    const tokenOut = nativeOut ? d.eth : params.destToken;
    let amountIn: bigint, minOut: bigint, value: bigint;
    try {
      amountIn = BigInt(params.amountIn);
      minOut = BigInt(quote.minDestAmount);
      value = BigInt(tx.value ?? "0");
    } catch {
      return noted("the request does not name amounts", "policy_refused");
    }
    if (nativeIn ? value !== amountIn || tx.approvalAddress !== undefined
      : value !== 0n || !tx.approvalAddress || !isAddress(tx.approvalAddress) || lc(tx.approvalAddress) !== lc(d.router)) {
      return noted(nativeIn ? "a native input is paid as exactly the input in value, with no approval" : "a token input attaches no value and approves exactly the Curve router", "policy_refused");
    }
    const call = decodeExchange(d.family, tx.data);
    if (!call) return noted("the router call is not exchange(route, params, amount, min, receiver)", "policy_refused");
    if (call.selector !== EXCHANGE_SELECTOR[d.family]) return noted(`selector ${call.selector} is not the explicit-receiver exchange ${EXCHANGE_SELECTOR[d.family]}`, "policy_refused");
    if (!call.receiver || lc(call.receiver) !== lc(params.destAddress)) return noted(`the swap pays ${call.receiver ?? "the sender"}, not the recipient`, "recipient_mismatch");
    if (call.pools && call.pools.some((p) => lc(p) !== lc(ZERO_ADDRESS))) return noted("the call names zap pools this module never uses", "policy_refused");
    if (call.amount !== amountIn) return noted(`the swap sells ${call.amount}, not the ${amountIn} input`, "policy_refused");
    if (call.minDy <= 0n) return noted("the swap has no minimum (min_dy 0)", "price_check_failed");
    if (call.minDy !== minOut) return noted(`the swap's minimum ${call.minDy} is not the quote's ${minOut}`, "price_check_failed");
    if (quote.providerData?.minOut !== undefined && quote.providerData.minOut !== minOut.toString()) return noted("the quote's facts disagree on the minimum", "price_check_failed");
    return checkRoute(chainId, d, own(pools, chainId), call, tokenIn, tokenOut);
  };
}

/**
 * The swap a Curve quote's router call makes, opened on the client against the app's own request: the explicit-receiver
 * `exchange` on the chain's pinned Router NG (`0xc872a3c5` on `[5][5]` routers, `0xfd44959c` on `[4][5]`), selling
 * exactly the input of the source token (the router's native sentinel for a native input, paid as exactly that
 * `value`; a token input attaches no value and approves exactly the router), for the destination token, with
 * `min_dy` the quote's minimum (never 0), paid to the recipient, no zap pools, and a route that `checkRoute` accepts:
 * allowlisted pools only, their pinned coins, swap types 1/2 (8 through the pinned wrapped native, 9 only on router
 * v1.2 through scrvUSD). The reason it fails, or null.
 */
export const curveVerifyQuote: (params: QuoteParams, quote: Quote) => string | null = curveQuoteCheck();

/**
 * The Router NG a Curve swap calls and approves on a chain (the shipped {@link CURVE_DEPLOYMENTS} table), and
 * {@link curveVerifyQuote} — the app's pins for `remoteProvider({name: "curve", baseUrl, ...curvePins})`. For the build
 * checked on chain as well (router code hash, fresh `get_dy`, pool coins), use {@link curveRemotePins}.
 */
export const curvePins: RemotePins = Object.freeze({
  callTargets: (chain: string): readonly string[] => routerFor(CURVE_DEPLOYMENTS, chain),
  spenders: (chain: string): readonly string[] => routerFor(CURVE_DEPLOYMENTS, chain),
  verifyQuote: curveVerifyQuote,
  // The reason of each text verifyQuote returned (remoteProvider puts it on its refusal).
  reasonOf: notes.reasonOf,
});

function routerFor(deployments: Readonly<Record<number, CurveDeployment>>, chain: string): readonly string[] {
  const d = deploymentOf(deployments, chainIdOf(chain));
  return d ? [d.router] : [];
}

export interface CurveOnChainOptions extends CurveTables {
  rpcUrls: Readonly<Record<number, readonly string[]>>;
  /** Told when the chain's AddressProvider lists another router than the pinned one (never acted on). Default console.warn. */
  onWarning?: (message: string) => void;
}

/**
 * On-chain checks shared by the provider and {@link curveRemotePins}: the pinned router's code hash and version (once
 * per chain; the AddressProvider's id 2 only compared), and a sealed quote re-checked right before broadcast.
 */
export function curveOnChain(opts: CurveOnChainOptions) {
  const deployments = opts.deployments ?? CURVE_DEPLOYMENTS;
  const pools = opts.pools ?? CURVE_POOLS;
  const rpc = rpcClient(opts.rpcUrls);
  const warn = opts.onWarning ?? ((m: string) => console.warn(m));
  const verified = new Map<number, Promise<void>>();

  /** The pinned router is still the code we pinned, at the version we pinned. */
  function verifyDeployment(chainId: number): Promise<void> {
    let p = verified.get(chainId);
    if (!p) {
      const d = deploymentOf(deployments, chainId);
      p = (async () => {
        if (!d) throw refusal("unsupported_pair", `curve: no pinned router on chain ${chainId}`);
        const [code, version, listed] = await rpc(chainId, [
          {method: "eth_getCode", params: [d.router, "latest"]},
          ethCall(d.router, encodeFunctionData({abi: VERSION_ABI, functionName: "version"})),
          ethCall(d.addressProvider, encodeFunctionData({abi: ADDRESS_PROVIDER_ABI, functionName: "get_address", args: [2n]})),
        ]);
        if (typeof code !== "string" || code.length <= 2 || lc(keccak256(code as ViemHex)) !== lc(d.codeHash)) {
          throw refusal("vault_mismatch", `curve: the router on chain ${chainId} is not the pinned code (code hash mismatch) — refusing`);
        }
        let v = "";
        try { v = typeof version === "string" ? decodeFunctionResult({abi: VERSION_ABI, functionName: "version", data: version as ViemHex}) : ""; } catch { /* below */ }
        if (v !== d.version) throw refusal("vault_mismatch", `curve: the router on chain ${chainId} reports version ${v || "none"}, not ${d.version} — refusing`);
        // The AddressProvider is informational (its admin may change any id): a different id 2 is a signal for the
        // module watch, never a router to use.
        const ap = wordAddress(listed);
        if (ap && ap !== lc(d.addressProviderRouter) && ap !== lc(d.router)) {
          warn(`curve: the AddressProvider on ${d.label} lists router ${ap} (id 2); this module keeps the pinned ${d.router}`);
        }
      })();
      p.catch(() => verified.delete(chainId));
      verified.set(chainId, p);
    }
    return p;
  }

  /**
   * A sealed quote right before broadcast (or a remote build on the client): the transaction is byte for byte the
   * quote's router call, the route passes `checkRoute`, the router was verified as the pinned code and version (once
   * per chain per process — it is immutable), every hop pool still has its pinned code and coins (re-read each time),
   * and a fresh `get_dy` of that exact route still pays at least the minimum. The reason it fails, or null.
   */
  async function checkSealed(quote: Quote, tx: UnsignedTx): Promise<string | null> {
    const r = await inspectSealed(quote, tx, false);
    return typeof r === "string" ? r : null;
  }

  /**
   * {@link checkSealed}, and what it read when it passes: the fresh `get_dy` of the exact route at the sealed amount,
   * the call's minimum and, with `probe`, the same route at 1/1000 of the amount (null when it reverts).
   */
  async function inspectSealed(quote: Quote, tx: UnsignedTx, probe: boolean): Promise<string | {out: bigint; probeOut: bigint | null; amount: bigint; minDy: bigint}> {
    const chainId = curveIntentChain(quote.intentId);
    const d = chainId === null ? undefined : deploymentOf(deployments, chainId);
    if (chainId === null || !d) return noted("the quote is not a Curve swap on a pinned chain", "policy_refused");
    const quoted = quote.txRequest;
    if (!quoted?.data || !quoted.to || !tx.data) return noted("the quote or the transaction carries no router call", "policy_refused");
    if (tx.data.length !== quoted.data.length || lc(tx.data) !== lc(quoted.data)) return noted("the transaction is not the quoted router call", "policy_refused");
    if (!isAddress(tx.to) || lc(tx.to) !== lc(d.router) || lc(quoted.to) !== lc(d.router)) return noted(`the transaction calls ${tx.to}, not the Curve router`, "vault_mismatch");
    if ((tx.value ?? "0") !== (quoted.value ?? "0")) return noted("the transaction's value is not the quote's", "policy_refused");
    if ((tx.chainId !== undefined && tx.chainId !== chainId) || (quoted.chainId !== undefined && quoted.chainId !== chainId)) return noted(`the transaction is not for chain ${chainId}`, "policy_refused");
    if ((tx.approvalAddress ?? "").toLowerCase() !== (quoted.approvalAddress ?? "").toLowerCase()) return noted("the transaction's approval is not the quote's", "vault_mismatch");
    const call = decodeExchange(d.family, quoted.data);
    if (!call || call.selector !== EXCHANGE_SELECTOR[d.family]) return noted("the quoted call is not the explicit-receiver exchange", "policy_refused");
    if (call.minDy <= 0n) return noted("the swap has no minimum (min_dy 0)", "price_check_failed");
    const last = lastToken(call);
    const reason = checkRoute(chainId, d, own(pools, chainId), call, call.route[0]!, last);
    if (reason) return reason;
    await verifyDeployment(chainId);
    const index = poolIndex(chainId, d, own(pools, chainId));
    const hops = routePools(call).map((a) => index.get(lc(a))!);
    const reads = poolCalls(hops);
    const calls: RpcCall[] = [ethCall(d.router, encodeGetDy(d.family, call, call.amount)), ...reads];
    const probeIn = call.amount / 1000n;
    const probeAt = calls.length;
    if (probe && probeIn > 0n) calls.push(ethCall(d.router, encodeGetDy(d.family, call, probeIn)));
    const res = await rpc(chainId, calls);
    const poolReason = await poolsReason(chainId, hops, res.slice(1, 1 + reads.length));
    if (poolReason) return poolReason;
    const out = wordUint(res[0]);
    if (out === null) return noted("the router no longer quotes this route", "simulation_failed");
    if (out < call.minDy) return noted(`price moved — the pools now pay ${out}, under your minimum ${call.minDy}`, "price_check_failed");
    return {out, probeOut: probe && probeIn > 0n ? wordUint(res[probeAt]) : null, amount: call.amount, minDy: call.minDy};
  }

  /** Per pool: its code, then `coins(uint256)` for each pinned coin. */
  function poolCalls(list: readonly CurvePool[]): RpcCall[] {
    return list.flatMap((pool) => [
      {method: "eth_getCode", params: [pool.address, "latest"]},
      ...pool.coins.map((_, k) => ethCall(pool.address, `${COINS_UINT}${k.toString(16).padStart(64, "0")}`)),
    ]);
  }

  /** The answers to {@link poolCalls} held to the pins (`coins(int128)` asked where `coins(uint256)` reverts). */
  async function poolsReason(chainId: number, list: readonly CurvePool[], res: readonly unknown[]): Promise<string | null> {
    let at = 0;
    const retry: {pool: CurvePool; k: number}[] = [];
    for (const pool of list) {
      const code = res[at++];
      // eth_getCode does not revert: no string means the read itself failed, which says nothing about the pool.
      if (typeof code !== "string") return noted(`could not read pool ${pool.name} (${pool.address}) over RPC`, "upstream_unavailable");
      if (code.length <= 2 || lc(keccak256(code as ViemHex)) !== lc(pool.codeHash)) return noted(`pool ${pool.name} (${pool.address}) is not the pinned code`, "vault_mismatch");
      for (let k = 0; k < pool.coins.length; k++) {
        const coin = wordAddress(res[at++]);
        if (coin === null) retry.push({pool, k});
        else if (coin !== lc(pool.coins[k]!)) return noted(`pool ${pool.name} now reports coin ${k} = ${coin}, not the pinned ${pool.coins[k]}`, "vault_mismatch");
      }
    }
    if (retry.length) {
      // The oldest stable pools take coins(int128).
      const again = await rpc(chainId, retry.map(({pool, k}) => ethCall(pool.address, `${COINS_INT}${k.toString(16).padStart(64, "0")}`)));
      for (const [n, {pool, k}] of retry.entries()) {
        const coin = wordAddress(again[n]);
        if (coin !== lc(pool.coins[k]!)) return noted(`pool ${pool.name} does not report its pinned coin ${k}`, "vault_mismatch");
      }
    }
    return null;
  }

  /**
   * Allowlisted pools as a sealed quote's preflight reads them, without a route: each still has its pinned code and
   * coins. The reason the first one fails, or null (a failed read throws). For live checks over a whole allowlist.
   */
  async function checkPools(chainId: number, list: readonly CurvePool[]): Promise<string | null> {
    return list.length ? poolsReason(chainId, list, await rpc(chainId, poolCalls(list))) : null;
  }

  return {rpc, verifyDeployment, checkSealed, inspectSealed, checkPools};
}

function lastToken(call: DecodedExchange): Hex {
  let k = 0;
  while (k < 5 && lc(call.route[2 * k + 1]!) !== lc(ZERO_ADDRESS)) k++;
  return call.route[2 * k]!;
}

/**
 * How far the device's own auto slippage may sit under the backend's before a remote build's minimum counts as too low:
 * the backend sized it from its probe at quote time, the device from a fresh one, and half the impact moves it.
 */
export const CURVE_AUTO_SLIPPAGE_DRIFT_BPS = 5;

export interface CurveRemotePinsOptions extends CurveOnChainOptions {
  /** The backend provider's `defaultSlippageBps`, when it sets one (a build's minimum is bounded by it). Default: auto slippage. */
  defaultSlippageBps?: number;
}

/**
 * {@link curvePins} plus `verifyBuild`: a remote Curve build checked on the client — {@link curveVerifyQuote} on the
 * request it answered, then on chain (over the app's own RPCs) the pinned router (code and version, once per chain),
 * each hop pool's pinned code and coins, and a fresh `get_dy` of the exact route at or above the minimum. The quote's
 * figures are then held to that fresh `get_dy` (§5.3 C9: the minimum is the device's own): `destAmount` no more than the
 * slippage above it, and `min_dy` no more than the slippage below it (or below `destAmount`, if lower) — the request's
 * `slippageBps`, else `defaultSlippageBps`, else the provider's auto slippage re-derived here from a fresh 1/1000 probe
 * (plus {@link CURVE_AUTO_SLIPPAGE_DRIFT_BPS}). A backend naming `min_dy = 1` or an inflated output is refused.
 * `remoteProvider({name: "curve", baseUrl, ...curveRemotePins({rpcUrls})})`.
 */
export function curveRemotePins(opts: CurveRemotePinsOptions): RemotePins & {verifyBuild(quote: Quote, tx: UnsignedTx, params?: QuoteParams): Promise<string | null>} {
  const deployments = opts.deployments ?? CURVE_DEPLOYMENTS;
  const fixedSlippage = opts.defaultSlippageBps;
  if (fixedSlippage !== undefined && (!Number.isInteger(fixedSlippage) || fixedSlippage <= 0 || fixedSlippage >= 5_000)) throw new Error("curve: defaultSlippageBps must be 1..4999");
  const verifyQuote = curveQuoteCheck(opts);
  const chain = curveOnChain(opts);
  return Object.freeze({
    callTargets: (c: string): readonly string[] => routerFor(deployments, c),
    spenders: (c: string): readonly string[] => routerFor(deployments, c),
    verifyQuote,
    // The reason of each text verifyQuote / verifyBuild returned (remoteProvider puts it on its refusal).
    reasonOf: notes.reasonOf,
    async verifyBuild(quote: Quote, tx: UnsignedTx, params?: QuoteParams): Promise<string | null> {
      if (!params) return noted("the request this quote answered is unknown", "policy_refused");
      const reason = verifyQuote(params, quote);
      if (reason) return reason;
      try {
        const auto = params.slippageBps === undefined && fixedSlippage === undefined;
        const seen = await chain.inspectSealed(quote, tx, auto);
        if (typeof seen === "string") return seen;
        const {out, probeOut, amount, minDy} = seen;
        let dest: bigint;
        try { dest = BigInt(quote.destAmount); } catch { return noted("the quote names no output", "upstream_unavailable"); }
        const bps = params.slippageBps ?? fixedSlippage ?? Math.min(9_999, curveAutoSlippageBps(params, curveImpactBps(amount, out, probeOut)) + CURVE_AUTO_SLIPPAGE_DRIFT_BPS);
        if (slippageFloor(dest, bps) > out) return noted(`the quote promises ${dest}, more than ${bps} bps above the ${out} the pools pay now`, "price_check_failed");
        const fresh = dest < out ? dest : out;
        if (minDy < slippageFloor(fresh, bps)) return noted(`the swap's minimum ${minDy} is more than ${bps} bps under the ${fresh} the pools pay now`, "price_check_failed");
        return null;
      } catch (e) {
        return noted(e instanceof Error ? e.message.replace(/^curve: /, "") : String(e), refusalOf(e));
      }
    },
  });
}

