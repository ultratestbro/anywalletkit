import {decodeFunctionResult, encodeFunctionData, keccak256, type Hex as ViemHex} from "viem";
import {sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import type {Quote, QuoteParams, RemotePins, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {ADDRESS_PROVIDER_ABI, COINS_INT, COINS_UINT, EXCHANGE_SELECTOR, VERSION_ABI, decodeExchange, encodeGetDy, type DecodedExchange} from "./abi.js";
import {CURVE_DEPLOYMENTS, ZERO_ADDRESS, chainIdOf, deploymentOf, type CurveDeployment} from "./deployments.js";
import {CURVE_POOLS} from "./pools/index.js";
import type {CurveChainPools, Hex} from "./pools/types.js";
import {checkRoute, poolIndex, routePools} from "./routes.js";
import {ethCall, rpcClient, wordAddress, wordUint, type RpcCall} from "./rpc.js";

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
    if (!d || params.destChain !== params.sourceChain) return "not a same-chain swap on a pinned Curve router";
    const tx = quote.txRequest;
    if (!tx?.data || !tx.to || tx.serializedTx !== undefined) return "the quote carries no router call";
    if (!isAddress(tx.to) || lc(tx.to) !== lc(d.router)) return `the call targets ${tx.to}, not the Curve router`;
    if (tx.chainId !== undefined && tx.chainId !== chainId) return `the call is for chain ${tx.chainId}`;
    // The chain the build's on-chain checks and the receipt tracking run on (`curve:<chainId>`): this request's.
    if (quote.intentId !== `curve:${chainId}`) return `the quote names ${String(quote.intentId).slice(0, 40)}, not curve:${chainId}`;
    const src = sourceAssetOf(params);
    if (!src) return `unknown source token ${params.sourceToken}`;
    const nativeIn = !src.contract;
    const nativeOut = /^0x0+$/.test(params.destToken);
    if (!nativeOut && !isAddress(params.destToken)) return "destination token must be an EVM address";
    if (!isAddress(params.destAddress)) return "recipient must be an EVM address";
    if ((!nativeIn && lc(src.contract!) === lc(d.eth)) || (!nativeOut && lc(params.destToken) === lc(d.eth))) return "the router's native sentinel is not a token";
    const tokenIn = nativeIn ? d.eth : src.contract!;
    const tokenOut = nativeOut ? d.eth : params.destToken;
    let amountIn: bigint, minOut: bigint, value: bigint;
    try {
      amountIn = BigInt(params.amountIn);
      minOut = BigInt(quote.minDestAmount);
      value = BigInt(tx.value ?? "0");
    } catch {
      return "the request does not name amounts";
    }
    if (nativeIn ? value !== amountIn || tx.approvalAddress !== undefined
      : value !== 0n || !tx.approvalAddress || !isAddress(tx.approvalAddress) || lc(tx.approvalAddress) !== lc(d.router)) {
      return nativeIn ? "a native input is paid as exactly the input in value, with no approval" : "a token input attaches no value and approves exactly the Curve router";
    }
    const call = decodeExchange(d.family, tx.data);
    if (!call) return "the router call is not exchange(route, params, amount, min, receiver)";
    if (call.selector !== EXCHANGE_SELECTOR[d.family]) return `selector ${call.selector} is not the explicit-receiver exchange ${EXCHANGE_SELECTOR[d.family]}`;
    if (!call.receiver || lc(call.receiver) !== lc(params.destAddress)) return `the swap pays ${call.receiver ?? "the sender"}, not the recipient`;
    if (call.pools && call.pools.some((p) => lc(p) !== lc(ZERO_ADDRESS))) return "the call names zap pools this module never uses";
    if (call.amount !== amountIn) return `the swap sells ${call.amount}, not the ${amountIn} input`;
    if (call.minDy <= 0n) return "the swap has no minimum (min_dy 0)";
    if (call.minDy !== minOut) return `the swap's minimum ${call.minDy} is not the quote's ${minOut}`;
    if (quote.providerData?.minOut !== undefined && quote.providerData.minOut !== minOut.toString()) return "the quote's facts disagree on the minimum";
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
        if (!d) throw new Error(`curve: no pinned router on chain ${chainId}`);
        const [code, version, listed] = await rpc(chainId, [
          {method: "eth_getCode", params: [d.router, "latest"]},
          ethCall(d.router, encodeFunctionData({abi: VERSION_ABI, functionName: "version"})),
          ethCall(d.addressProvider, encodeFunctionData({abi: ADDRESS_PROVIDER_ABI, functionName: "get_address", args: [2n]})),
        ]);
        if (typeof code !== "string" || code.length <= 2 || lc(keccak256(code as ViemHex)) !== lc(d.codeHash)) {
          throw new Error(`curve: the router on chain ${chainId} is not the pinned code (code hash mismatch) — refusing`);
        }
        let v = "";
        try { v = typeof version === "string" ? decodeFunctionResult({abi: VERSION_ABI, functionName: "version", data: version as ViemHex}) : ""; } catch { /* below */ }
        if (v !== d.version) throw new Error(`curve: the router on chain ${chainId} reports version ${v || "none"}, not ${d.version} — refusing`);
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
   * quote's router call, the route passes `checkRoute`, the router is still the pinned code, every hop pool still has
   * its pinned code and coins, and a fresh `get_dy` of that exact route still pays at least the minimum. The reason it
   * fails, or null.
   */
  async function checkSealed(quote: Quote, tx: UnsignedTx): Promise<string | null> {
    const chainId = Number(quote.intentId.split(":")[1]);
    const d = deploymentOf(deployments, chainId);
    if (!d || quote.intentId !== `curve:${chainId}`) return "the quote is not a Curve swap on a pinned chain";
    const quoted = quote.txRequest;
    if (!quoted?.data || !quoted.to || !tx.data) return "the quote or the transaction carries no router call";
    if (tx.data.length !== quoted.data.length || lc(tx.data) !== lc(quoted.data)) return "the transaction is not the quoted router call";
    if (!isAddress(tx.to) || lc(tx.to) !== lc(d.router) || lc(quoted.to) !== lc(d.router)) return `the transaction calls ${tx.to}, not the Curve router`;
    if ((tx.value ?? "0") !== (quoted.value ?? "0")) return "the transaction's value is not the quote's";
    if ((tx.chainId !== undefined && tx.chainId !== chainId) || (quoted.chainId !== undefined && quoted.chainId !== chainId)) return `the transaction is not for chain ${chainId}`;
    if ((tx.approvalAddress ?? "").toLowerCase() !== (quoted.approvalAddress ?? "").toLowerCase()) return "the transaction's approval is not the quote's";
    const call = decodeExchange(d.family, quoted.data);
    if (!call || call.selector !== EXCHANGE_SELECTOR[d.family]) return "the quoted call is not the explicit-receiver exchange";
    if (call.minDy <= 0n) return "the swap has no minimum (min_dy 0)";
    const last = lastToken(call);
    const reason = checkRoute(chainId, d, own(pools, chainId), call, call.route[0]!, last);
    if (reason) return reason;
    await verifyDeployment(chainId);
    const index = poolIndex(chainId, d, own(pools, chainId));
    const hops = routePools(call).map((a) => index.get(lc(a))!);
    const calls: RpcCall[] = [ethCall(d.router, encodeGetDy(d.family, call, call.amount))];
    for (const pool of hops) {
      calls.push({method: "eth_getCode", params: [pool.address, "latest"]});
      pool.coins.forEach((_, k) => calls.push(ethCall(pool.address, `${COINS_UINT}${k.toString(16).padStart(64, "0")}`)));
    }
    const res = await rpc(chainId, calls);
    let at = 1;
    const retry: {pool: typeof hops[number]; k: number}[] = [];
    for (const pool of hops) {
      const code = res[at++];
      if (typeof code !== "string" || code.length <= 2 || lc(keccak256(code as ViemHex)) !== lc(pool.codeHash)) return `pool ${pool.name} (${pool.address}) is not the pinned code`;
      for (let k = 0; k < pool.coins.length; k++) {
        const coin = wordAddress(res[at++]);
        if (coin === null) retry.push({pool, k});
        else if (coin !== lc(pool.coins[k]!)) return `pool ${pool.name} now reports coin ${k} = ${coin}, not the pinned ${pool.coins[k]}`;
      }
    }
    if (retry.length) {
      // The oldest stable pools take coins(int128).
      const again = await rpc(chainId, retry.map(({pool, k}) => ethCall(pool.address, `${COINS_INT}${k.toString(16).padStart(64, "0")}`)));
      for (const [n, {pool, k}] of retry.entries()) {
        const coin = wordAddress(again[n]);
        if (coin !== lc(pool.coins[k]!)) return `pool ${pool.name} does not report its pinned coin ${k}`;
      }
    }
    const out = wordUint(res[0]);
    if (out === null) return "the router no longer quotes this route";
    if (out < call.minDy) return `price moved — the pools now pay ${out}, under your minimum ${call.minDy}`;
    return null;
  }

  return {rpc, verifyDeployment, checkSealed};
}

function lastToken(call: DecodedExchange): Hex {
  let k = 0;
  while (k < 5 && lc(call.route[2 * k + 1]!) !== lc(ZERO_ADDRESS)) k++;
  return call.route[2 * k]!;
}

/**
 * {@link curvePins} plus `verifyBuild`: a remote Curve build checked on the client — {@link curveVerifyQuote} on the
 * request it answered, then on chain (over the app's own RPCs) the pinned router code, each hop pool's pinned code and
 * coins, and a fresh `get_dy` of the exact route at or above the minimum.
 * `remoteProvider({name: "curve", baseUrl, ...curveRemotePins({rpcUrls})})`.
 */
export function curveRemotePins(opts: CurveOnChainOptions): RemotePins & {verifyBuild(quote: Quote, tx: UnsignedTx, params?: QuoteParams): Promise<string | null>} {
  const deployments = opts.deployments ?? CURVE_DEPLOYMENTS;
  const verifyQuote = curveQuoteCheck(opts);
  const chain = curveOnChain(opts);
  return Object.freeze({
    callTargets: (c: string): readonly string[] => routerFor(deployments, c),
    spenders: (c: string): readonly string[] => routerFor(deployments, c),
    verifyQuote,
    async verifyBuild(quote: Quote, tx: UnsignedTx, params?: QuoteParams): Promise<string | null> {
      if (!params) return "the request this quote answered is unknown";
      const reason = verifyQuote(params, quote);
      if (reason) return reason;
      try {
        return await chain.checkSealed(quote, tx);
      } catch (e) {
        return e instanceof Error ? e.message.replace(/^curve: /, "") : String(e);
      }
    },
  });
}

