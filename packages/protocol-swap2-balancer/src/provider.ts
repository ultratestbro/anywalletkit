import type {RemotePins} from "@anywalletkit/protocol-swap2-core/types";
import {decodeFunctionData, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, type Hex} from "viem";
import {describeBalancerActivity} from "./activity.js";
import {evmRef, isEvm, timeoutSignal, sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import {httpRefusal, refusal, refusalNotes, refusalOf, withReason, type Swap2RefusalInfo, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {bigintToNumber} from "@anywalletkit/core";

/**
 * Balancer v2 — the cp0x permissionless Balancer venue (balancer.cp0x.com).
 *
 * Discovery only from the API: Balancer's SOR (`sorGetSwapPaths`, v2 pools)
 * suggests the path. Everything on the money path is on-chain: the Vault
 * prices that exact path (`queryBatchSwap` via eth_call), the quote uses the
 * Vault's number, and `batchSwap` carries `limits` (in ≤ amountIn, out ≥ min)
 * plus a deadline — the Vault itself refuses anything worse. Native coins use
 * the Vault's own ETH sentinel (address 0): it wraps/unwraps through WETH.
 */

const ZERO = "0x0000000000000000000000000000000000000000";
/** The same Balancer v2 Vault address on every chain it is deployed on. */
export const BALANCER_V2_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const DEFAULT_API = "https://api-v3.balancer.fi/";
const DEFAULT_SLIPPAGE_BPS = 50;
const DEFAULT_TTL_MS = 300_000;
const DEFAULT_DEADLINE_S = 600;
/** Most pool hops one batch may carry: the SOR's splits are a handful; a batch past this is refused at quote and at preflight. */
export const BALANCER_MAX_SWAPS = 16;
/** The reasons of the texts {@link balancerVerifyQuote} returned, for `balancerPins.reasonOf`. */
const notes = refusalNotes();

/** Chains where the v2 Vault is live, with the SOR API name and the Vault's WETH() (verified on-chain 2026-10-13). */
export const BALANCER_V2_CHAINS: Readonly<Record<number, {api: string; weth: `0x${string}`}>> = Object.freeze({
  1: {api: "MAINNET", weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"},
  10: {api: "OPTIMISM", weth: "0x4200000000000000000000000000000000000006"},
  100: {api: "GNOSIS", weth: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d"},
  137: {api: "POLYGON", weth: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"},
  146: {api: "SONIC", weth: "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38"},
  8453: {api: "BASE", weth: "0x4200000000000000000000000000000000000006"},
  9745: {api: "PLASMA", weth: "0x6100E367285b01F48D07953803A2d8dCA5D19873"},
  42161: {api: "ARBITRUM", weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"},
  43114: {api: "AVALANCHE", weth: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7"},
});

const SWAP_STEP = "(bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)";
const FUNDS = "(address sender, bool fromInternalBalance, address recipient, bool toInternalBalance)";
const VAULT_ABI = parseAbi([
  `function queryBatchSwap(uint8 kind, ${SWAP_STEP}[] swaps, address[] assets, ${FUNDS} funds) returns (int256[] assetDeltas)`,
  `function batchSwap(uint8 kind, ${SWAP_STEP}[] swaps, address[] assets, ${FUNDS} funds, int256[] limits, uint256 deadline) payable returns (int256[] assetDeltas)`,
  "function WETH() view returns (address)",
]);

type Step = {poolId: Hex; assetInIndex: bigint; assetOutIndex: bigint; amount: bigint; userData: Hex};
type Funds = {sender: Hex; fromInternalBalance: boolean; recipient: Hex; toInternalBalance: boolean};

export interface BalancerProviderConfig {
  enabled?: boolean;
  /** JSON-RPC endpoints per EVM chain id (on-chain pricing + receipts). */
  rpcUrls: Readonly<Record<number, readonly string[]>>;
  /** Balancer API (SOR) base URL — discovery only. */
  apiUrl?: string;
  defaultSlippageBps?: number;
  quoteTtlMs?: number;
  deadlineSeconds?: number;
}

interface SorPath {
  pools: string[];
  tokens: {address: string; decimals: number}[];
  inputAmountRaw: string;
  outputAmountRaw: string;
  protocolVersion: number;
}

/** Base units → the decimal string the SOR expects ("1.5"). */
function human(amount: bigint, decimals: number): string {
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function balancerProvider(config: BalancerProviderConfig): CrossChainProvider {
  const api = config.apiUrl ?? DEFAULT_API;
  const slippageDefault = config.defaultSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const ttl = config.quoteTtlMs ?? DEFAULT_TTL_MS;
  const deadlineS = config.deadlineSeconds ?? DEFAULT_DEADLINE_S;
  const verified = new Map<number, Promise<void>>();

  const chainIdOf = (caip2: string): number | null => {
    if (!isEvm(caip2)) return null;
    const id = evmRef(caip2);
    return BALANCER_V2_CHAINS[id] && config.rpcUrls[id]?.length ? id : null;
  };

  async function rpc(chainId: number, method: string, params: unknown[]): Promise<unknown> {
    let lastErr: unknown;
    for (const url of config.rpcUrls[chainId] ?? []) {
      try {
        const res = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}), signal: timeoutSignal(12_000)});
        if (!res.ok) {
          const error = new Error(`HTTP ${res.status}`);
          const info = httpRefusal(res.status, res.headers?.get?.("retry-after"));
          throw info ? withReason(error, info) : error;
        }
        const body = (await res.json()) as {result?: unknown; error?: {code?: unknown; message?: string}};
        if (body.error) throw Object.assign(new Error(body.error.message ?? "rpc error"), {rpc: true, rpcCode: body.error.code});
        return body.result ?? null;
      } catch (e) {
        if ((e as {rpc?: boolean}).rpc) throw e; // a revert is an answer, not a dead endpoint
        lastErr = e;
      }
    }
    // Every endpoint failed: the last one's own classification (a 429, a rejected key), else unavailable.
    throw withReason(new Error(`balancer: no RPC answered on chain ${chainId} (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`), refusalOf(lastErr) ?? "upstream_unavailable");
  }

  /** The Vault is deployed here and wraps through the WETH we pinned. */
  function verify(chainId: number): Promise<void> {
    let p = verified.get(chainId);
    if (!p) {
      p = (async () => {
        const raw = (await rpc(chainId, "eth_call", [{to: BALANCER_V2_VAULT, data: encodeFunctionData({abi: VAULT_ABI, functionName: "WETH"})}, "latest"])) as Hex;
        const weth = decodeFunctionResult({abi: VAULT_ABI, functionName: "WETH", data: raw});
        if (getAddress(weth) !== getAddress(BALANCER_V2_CHAINS[chainId]!.weth)) throw refusal("vault_mismatch", `balancer: the Vault on chain ${chainId} is not the pinned deployment — refusing`);
      })();
      p.catch(() => verified.delete(chainId));
      verified.set(chainId, p);
    }
    return p;
  }

  /**
   * Vault.queryBatchSwap on chain: the asset deltas this exact batch would produce. A JSON-RPC error that says the
   * call reverted (code 3, Nethermind's -32015, a "revert" message) is the Vault reverting the batch
   * (`simulation_failed`); any other JSON-RPC error ("header not found", "missing trie node", a limit, an internal
   * error) and an answer that does not decode are the node's (`upstream_unavailable`).
   */
  async function query(chainId: number, swaps: readonly Step[], assets: readonly Hex[], funds: Funds): Promise<readonly bigint[]> {
    const data = encodeFunctionData({abi: VAULT_ABI, functionName: "queryBatchSwap", args: [0, swaps, assets, funds]});
    let raw: Hex;
    try {
      raw = (await rpc(chainId, "eth_call", [{to: BALANCER_V2_VAULT, data}, "latest"])) as Hex;
    } catch (e) {
      if (!(e instanceof Error) || !(e as {rpc?: boolean}).rpc) throw e;
      const code = (e as {rpcCode?: unknown}).rpcCode;
      throw withReason(e, code === 3 || code === -32015 || /revert/i.test(e.message) ? "simulation_failed" : "upstream_unavailable");
    }
    try {
      return decodeFunctionResult({abi: VAULT_ABI, functionName: "queryBatchSwap", data: raw});
    } catch (e) {
      throw e instanceof Error ? withReason(e, "upstream_unavailable") : e;
    }
  }

  return {
    name: "balancer",
    describeActivity: describeBalancerActivity,
    supportsSameChain: true,
    enabled: () => config.enabled ?? true,
    supportsChain: (caip2: string) => chainIdOf(caip2) !== null,
    supportsChainPair: (from: string, to: string) => from === to && chainIdOf(from) !== null,
    supportsRoute: (from: Asset, to: Asset) => from.chain === to.chain && chainIdOf(from.chain) !== null,

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      const refuse = (why: string, info?: Swap2RefusalReason | Swap2RefusalInfo): null => {
        params.onRefusal?.(`balancer: ${why}`, typeof info === "string" ? {reason: info} : info);
        return null;
      };
      if (params.flex) return refuse("amount-flexible deposits are not supported", "unsupported_pair");
      if (params.sourceChain !== params.destChain) return refuse("same-chain swaps only", "unsupported_pair");
      const chainId = chainIdOf(params.sourceChain);
      if (chainId === null) return refuse(`no Balancer v2 Vault or RPC for ${params.sourceChain}`, "unsupported_pair");
      const chain = BALANCER_V2_CHAINS[chainId]!;
      const src = sourceAssetOf(params);
      if (!src) return refuse(`unknown source token ${params.sourceToken}`, "unsupported_pair");
      const nativeIn = !src.contract;
      const nativeOut = /^0x0+$/.test(params.destToken);
      if (!nativeOut && !/^0x[0-9a-fA-F]{40}$/.test(params.destToken)) return refuse("destination token must be an EVM address", "unsupported_pair");
      if (!/^0x[0-9a-fA-F]{40}$/.test(params.destAddress)) return refuse("recipient must be an EVM address", "recipient_mismatch");
      let amountIn: bigint;
      try {
        amountIn = BigInt(params.amountIn);
      } catch {
        return refuse("amount is not an integer");
      }
      if (amountIn <= 0n) return refuse("amount must be positive");
      const tokenIn = getAddress(nativeIn ? chain.weth : src.contract!);
      const tokenOut = getAddress(nativeOut ? chain.weth : params.destToken);
      if (tokenIn === tokenOut) return refuse(nativeIn || nativeOut ? "that is a wrap/unwrap, not a swap" : "same token in and out", "unsupported_pair");

      try {
        await verify(chainId);
        // 1) Discovery: the SOR's v2 paths (never trusted for price).
        // Values are inlined (this API ignores GraphQL variables); all are validated
        // addresses / a decimal number / a fixed enum, so nothing user-shaped is spliced.
        const query_ = `query { sorGetSwapPaths(chain: ${chain.api}, swapAmount: "${human(amountIn, src.decimals)}", swapType: EXACT_IN, tokenIn: "${tokenIn}", tokenOut: "${tokenOut}", useProtocolVersion: 2) { protocolVersion paths { pools tokens { address decimals } inputAmountRaw outputAmountRaw protocolVersion } } }`;
        const res = await fetch(api, {
          method: "POST",
          headers: {"content-type": "application/json"},
          body: JSON.stringify({query: query_}),
          signal: signal ?? timeoutSignal(12_000),
        });
        // 429 / 401 / 403 / 408 / 425 / 5xx by status; another 4xx says nothing without the body (a 404 is a misconfigured apiUrl).
        if (!res.ok) return refuse(`SOR answered HTTP ${res.status}`, httpRefusal(res.status, res.headers?.get?.("retry-after")));
        const body = (await res.json()) as {data?: {sorGetSwapPaths?: {protocolVersion?: number; paths?: SorPath[]}}; errors?: {message?: string}[]};
        const paths = body.data?.sorGetSwapPaths?.paths ?? [];
        if (body.errors?.length) return refuse(`SOR: ${body.errors[0]?.message?.slice(0, 120) ?? "error"}`, "upstream_unavailable");
        if (!paths.length || paths.some((p) => p.protocolVersion !== 2 || p.pools.length === 0 || p.tokens.length !== p.pools.length + 1)) {
          return refuse("no Balancer v2 pool route for this pair and amount", "no_route");
        }
        if (paths.reduce((s, p) => s + BigInt(p.inputAmountRaw), 0n) !== amountIn) return refuse("the SOR split does not add up to the amount", "price_check_failed");

        // 2) Build the batch from the suggested paths.
        const assets: Hex[] = [];
        const indexOf = (a: string) => {
          const addr = getAddress(a);
          let i = assets.findIndex((x) => x === addr);
          if (i < 0) i = assets.push(addr) - 1;
          return BigInt(i);
        };
        const swaps: Step[] = [];
        for (const p of paths) {
          if (getAddress(p.tokens[0]!.address) !== tokenIn || getAddress(p.tokens[p.tokens.length - 1]!.address) !== tokenOut) return refuse("the SOR path does not start/end at the requested tokens", "policy_refused");
          p.pools.forEach((pool, i) => {
            if (!/^0x[0-9a-fA-F]{64}$/.test(pool)) throw refusal("upstream_unavailable", "balancer: malformed pool id from the SOR");
            swaps.push({poolId: pool as Hex, assetInIndex: indexOf(p.tokens[i]!.address), assetOutIndex: indexOf(p.tokens[i + 1]!.address), amount: i === 0 ? BigInt(p.inputAmountRaw) : 0n, userData: "0x"});
          });
        }
        if (swaps.length > BALANCER_MAX_SWAPS) return refuse(`the SOR route has ${swaps.length} pool hops, more than ${BALANCER_MAX_SWAPS}`, "policy_refused");
        const inIdx = bigintToNumber(indexOf(tokenIn));
        const outIdx = bigintToNumber(indexOf(tokenOut));
        // The Vault's ETH sentinel: native in/out wraps/unwraps through its WETH.
        if (nativeIn || nativeOut) {
          const wethIdx = assets.findIndex((a) => a === getAddress(chain.weth));
          if (paths.some((p) => p.tokens.slice(1, -1).some((t) => getAddress(t.address) === getAddress(chain.weth)))) return refuse("this route passes through the wrapped native — pick the wrapped token instead", "unsupported_pair");
          if (wethIdx >= 0) assets[wethIdx] = ZERO as Hex;
        }
        const sender = getAddress(params.refundAddress && /^0x[0-9a-fA-F]{40}$/.test(params.refundAddress) ? params.refundAddress : params.destAddress);
        const recipient = getAddress(params.destAddress);
        const funds: Funds = {sender, fromInternalBalance: false, recipient, toInternalBalance: false};

        // 3) Price it on-chain — this, not the SOR's number, is the quote.
        const deltas = await query(chainId, swaps, assets, funds);
        const paid = deltas[inIdx]!;
        const out = -deltas[outIdx]!;
        if (paid !== amountIn) return refuse(`the Vault would take ${paid}, not ${amountIn}`, "price_check_failed");
        if (out <= 0n) return refuse("the Vault prices this route at zero output", "amount_too_small");
        if (deltas.some((d, i) => i !== inIdx && i !== outIdx && d !== 0n)) return refuse("the batch leaves an intermediate balance — refusing", "policy_refused");

        const bps = params.slippageBps ?? slippageDefault;
        const minOut = (out * BigInt(10_000 - bps)) / 10_000n;
        if (params.minAmountOut !== undefined && minOut < BigInt(params.minAmountOut)) return refuse(`floor breach (min=${minOut} < floor=${params.minAmountOut})`, "price_check_failed");
        const limits = assets.map((_, i) => (i === inIdx ? amountIn : i === outIdx ? -minOut : 0n));
        const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineS);
        const data = encodeFunctionData({abi: VAULT_ABI, functionName: "batchSwap", args: [0, swaps, assets, funds, limits, deadline]});
        const gasLimit = 160_000n + 95_000n * BigInt(swaps.length);
        return {
          provider: "balancer",
          intentId: `balancer:${chainId}`,
          depositAddress: "",
          depositMemo: null,
          txRequest: {
            to: BALANCER_V2_VAULT,
            data,
            value: nativeIn ? amountIn.toString() : "0",
            chainId,
            gasLimit: gasLimit.toString(),
            ...(nativeIn ? {} : {approvalAddress: BALANCER_V2_VAULT}),
          },
          sourceAmount: amountIn.toString(),
          destAmount: out.toString(),
          minDestAmount: minOut.toString(),
          feeUsd: 0,
          etaSeconds: 15,
          reliability: 0.97,
          validUntilMs: Date.now() + ttl,
          // Pool swap fees are inside the Vault-priced output; no fee is added on top.
          providerData: {paths: String(paths.length), hops: String(swaps.length), minOut: minOut.toString(), poolFee: "pools"},
        };
      } catch (e) {
        // Classified where thrown (the Vault check, the node, a revert); anything else is the SOR or the node
        // answering in another shape, or the network — never the caller's own abort.
        return refuse(e instanceof Error ? e.message.replace(/^balancer: /, "") : String(e), refusalOf(e) ?? (signal?.aborted ? undefined : "upstream_unavailable"));
      }
    },

    /**
     * Re-price the exact signed batch right before broadcast; refuse when the pools now pay under the minimum.
     * Only the quote's own batch is decoded and priced: behind a backend, `tx` is the client's and only the
     * quote is sealed, so a client's batch (any size, any pools) never reaches the decoder or the RPC
     * (scan 2026-10-27 modules, F24).
     */
    async preflightDeposit(quote: Quote, tx: UnsignedTx): Promise<void> {
      const chainId = Number(quote.intentId.split(":")[1]);
      const minOut = quote.providerData?.minOut;
      if (!BALANCER_V2_CHAINS[chainId] || !minOut || !tx.data) return;
      const quoted = quote.txRequest?.data;
      if (!quoted || tx.data.length !== quoted.length || tx.data.toLowerCase() !== quoted.toLowerCase()) {
        throw refusal("policy_refused", "balancer: the transaction is not the quoted batch. Nothing was sent; refresh the quote.");
      }
      const call = decodeFunctionData({abi: VAULT_ABI, data: quoted as Hex});
      if (call.functionName !== "batchSwap") throw refusal("policy_refused", "balancer: the transaction is not a Vault batchSwap");
      const [, swaps, assets, funds, limits] = call.args;
      if (swaps.length === 0 || swaps.length > BALANCER_MAX_SWAPS) throw refusal("policy_refused", `balancer: the batch has ${swaps.length} pool hops, not 1–${BALANCER_MAX_SWAPS}`);
      if (swaps.some((step) => step.userData !== "0x")) throw refusal("policy_refused", "balancer: the batch carries pool userData this module never sends");
      const outIdx = limits.findIndex((l) => l < 0n);
      const deltas = await query(chainId, swaps, assets, funds);
      const out = -deltas[outIdx]!;
      if (out < BigInt(minOut)) throw refusal("price_check_failed", `balancer: price moved — the pools now pay ${out}, under your minimum ${minOut}. Nothing was sent; refresh the quote.`);
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const tx = quote.txRequest;
      if (!tx?.to || !tx.data) throw refusal("policy_refused", "swap2: Balancer quote has no transaction request");
      return {chain: "", to: tx.to, value: tx.value ?? "0", data: tx.data, ...(tx.chainId !== undefined ? {chainId: tx.chainId} : {}), ...(tx.gasLimit ? {gasLimit: tx.gasLimit} : {}), ...(tx.approvalAddress ? {approvalAddress: tx.approvalAddress} : {})};
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      if (!ref.sourceTxHash) return {state: "pending"};
      const chainId = Number(ref.intentId.split(":")[1]);
      if (!BALANCER_V2_CHAINS[chainId] || !config.rpcUrls[chainId]?.length) return {state: "pending"};
      try {
        const receipt = (await rpc(chainId, "eth_getTransactionReceipt", [ref.sourceTxHash])) as {status?: string} | null;
        if (!receipt) return {state: "pending"};
        return receipt.status === "0x1" ? {state: "completed", destTxHash: ref.sourceTxHash} : {state: "failed"};
      } catch {
        return {state: "pending"};
      }
    },
  };
}

/**
 * The batch a Balancer quote's Vault call makes, opened on the client against the app's own request (scan 2026-10-28,
 * F2): only `batchSwap` of kind GIVEN_IN on the Vault, with no internal balances and no pool `userData`, at most
 * {@link BALANCER_MAX_SWAPS} hops; funds taken from the sender the provider names (the refund address, else the
 * recipient) and paid to the recipient; every swap that brings in an amount sells the source token (the Vault's ETH
 * sentinel for a native input), the amounts adding up to exactly the input; one hop delivers the destination token;
 * and the limits allow paying exactly the input and receiving at least the quote's minimum, nothing of anything else.
 * `manageUserBalance`, `swap`, `setRelayerApproval` and every other Vault call are refused. The reason it fails, or null.
 */
export function balancerVerifyQuote(params: QuoteParams, quote: Quote): string | null {
  const id = /^eip155:[0-9]+$/.test(params.sourceChain) ? Number(params.sourceChain.slice(7)) : NaN;
  const chain = Object.prototype.hasOwnProperty.call(BALANCER_V2_CHAINS, id) ? BALANCER_V2_CHAINS[id] : undefined;
  if (!chain || params.destChain !== params.sourceChain) return notes.note("not a same-chain swap on a Balancer v2 chain", "unsupported_pair");
  const tx = quote.txRequest;
  if (!tx?.data || !tx.to || tx.serializedTx !== undefined) return notes.note("the quote carries no Vault call", "policy_refused");
  if (getAddress(tx.to) !== BALANCER_V2_VAULT) return notes.note(`the call targets ${tx.to}, not the Vault`, "vault_mismatch");
  const src = sourceAssetOf(params);
  if (!src) return notes.note(`unknown source token ${params.sourceToken}`, "unsupported_pair");
  const nativeIn = !src.contract;
  const nativeOut = /^0x0+$/.test(params.destToken);
  let tokenIn: Hex, tokenOut: Hex, sender: Hex, recipient: Hex, amountIn: bigint, minOut: bigint;
  try {
    tokenIn = getAddress(nativeIn ? ZERO : src.contract!);
    tokenOut = getAddress(nativeOut ? ZERO : params.destToken);
    recipient = getAddress(params.destAddress);
    sender = getAddress(params.refundAddress && /^0x[0-9a-fA-F]{40}$/.test(params.refundAddress) ? params.refundAddress : params.destAddress);
    amountIn = BigInt(params.amountIn);
    minOut = BigInt(quote.minDestAmount);
  } catch {
    return "the request does not name EVM tokens, a recipient and amounts";
  }
  if (nativeIn ? BigInt(tx.value ?? "0") !== amountIn || tx.approvalAddress !== undefined
    : BigInt(tx.value ?? "0") !== 0n || !tx.approvalAddress || getAddress(tx.approvalAddress) !== BALANCER_V2_VAULT) {
    return notes.note(nativeIn ? "a native input is paid as exactly the input in value, with no approval" : "a token input attaches no value and approves the Vault", "policy_refused");
  }
  let call: ReturnType<typeof decodeFunctionData<typeof VAULT_ABI>>;
  try { call = decodeFunctionData({abi: VAULT_ABI, data: tx.data as Hex}); } catch { return notes.note("the Vault call is not batchSwap", "policy_refused"); }
  if (call.functionName !== "batchSwap") return notes.note(`${call.functionName} is not batchSwap`, "policy_refused");
  const [kind, swaps, assets, funds, limits] = call.args;
  if (kind !== 0) return notes.note("the batch is not GIVEN_IN", "policy_refused");
  if (swaps.length === 0 || swaps.length > BALANCER_MAX_SWAPS) return notes.note(`the batch has ${swaps.length} pool hops, not 1–${BALANCER_MAX_SWAPS}`, "policy_refused");
  if (funds.fromInternalBalance || funds.toInternalBalance) return notes.note("the batch uses Vault internal balances", "policy_refused");
  // One text for two checks: paying another recipient is recipient_mismatch; debiting another account only is a batch shape this module never signs.
  if (getAddress(funds.sender) !== sender || getAddress(funds.recipient) !== recipient) return notes.note(`the batch takes from ${funds.sender} and pays ${funds.recipient}, not this account and the recipient`, getAddress(funds.recipient) !== recipient ? "recipient_mismatch" : "policy_refused");
  const list = assets.map((a) => getAddress(a));
  if (new Set(list).size !== list.length) return notes.note("the batch names an asset twice", "policy_refused");
  if ((nativeIn || nativeOut) && list.includes(getAddress(chain.weth))) return notes.note("a native swap passes through the wrapped native", "policy_refused");
  const inIdx = list.indexOf(tokenIn);
  const outIdx = list.indexOf(tokenOut);
  if (inIdx < 0 || outIdx < 0 || inIdx === outIdx) return notes.note("the batch does not trade the requested tokens", "policy_refused");
  if (limits.length !== list.length || limits.some((l, i) => l !== (i === inIdx ? amountIn : i === outIdx ? -minOut : 0n))) {
    return notes.note("the limits are not exactly the input in and the quote's minimum out", "price_check_failed");
  }
  let given = 0n;
  for (const step of swaps) {
    if (step.userData !== "0x") return notes.note("the batch carries pool userData this module never sends", "policy_refused");
    if (step.assetInIndex >= BigInt(list.length) || step.assetOutIndex >= BigInt(list.length) || step.assetInIndex === step.assetOutIndex) return notes.note("a hop names no valid asset pair", "policy_refused");
    if (step.amount > 0n) {
      if (step.assetInIndex !== BigInt(inIdx)) return notes.note("a hop brings in an amount of another asset than the input", "policy_refused");
      given += step.amount;
    }
  }
  if (given !== amountIn) return notes.note(`the hops sell ${given}, not the ${amountIn} input`, "price_check_failed");
  if (!swaps.some((step) => step.assetOutIndex === BigInt(outIdx))) return notes.note("no hop delivers the destination token", "policy_refused");
  if (call.args[5] <= BigInt(Math.floor(Date.now() / 1000))) return notes.note("the batch deadline has passed", "quote_expired");
  return null;
}

/**
 * The Balancer V2 Vault a swap calls and approves on the chains this provider serves, and {@link balancerVerifyQuote}
 * — the app's pins for `remoteProvider({name: "balancer", baseUrl, ...balancerPins})` (scan 2026-10-27 modules,
 * F8/F16; scan 2026-10-28, F2). `reasonOf` classifies the texts `balancerVerifyQuote` returned.
 */
export const balancerPins: RemotePins = Object.freeze({
  callTargets: (chain: string): readonly string[] => balancerVaultFor(chain),
  spenders: (chain: string): readonly string[] => balancerVaultFor(chain),
  verifyQuote: balancerVerifyQuote,
  reasonOf: (refusal: string) => notes.reasonOf(refusal),
});
function balancerVaultFor(chain: string): readonly string[] {
  const id = /^eip155:[0-9]+$/.test(chain) ? Number(chain.slice(7)) : NaN;
  return Object.prototype.hasOwnProperty.call(BALANCER_V2_CHAINS, id) ? [BALANCER_V2_VAULT] : [];
}
