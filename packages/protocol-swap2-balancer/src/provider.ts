import {decodeFunctionData, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, type Hex} from "viem";
import {ccAsset} from "@forgewallet/swap2-assets";
import {evmRef, isEvm, timeoutSignal} from "@forgewallet/protocol-swap2-core/util";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@forgewallet/protocol-swap2-core/types";

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
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {result?: unknown; error?: {message?: string}};
        if (body.error) throw Object.assign(new Error(body.error.message ?? "rpc error"), {rpc: true});
        return body.result ?? null;
      } catch (e) {
        if ((e as {rpc?: boolean}).rpc) throw e; // a revert is an answer, not a dead endpoint
        lastErr = e;
      }
    }
    throw new Error(`balancer: no RPC answered on chain ${chainId} (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`);
  }

  /** The Vault is deployed here and wraps through the WETH we pinned. */
  function verify(chainId: number): Promise<void> {
    let p = verified.get(chainId);
    if (!p) {
      p = (async () => {
        const raw = (await rpc(chainId, "eth_call", [{to: BALANCER_V2_VAULT, data: encodeFunctionData({abi: VAULT_ABI, functionName: "WETH"})}, "latest"])) as Hex;
        const weth = decodeFunctionResult({abi: VAULT_ABI, functionName: "WETH", data: raw});
        if (getAddress(weth) !== getAddress(BALANCER_V2_CHAINS[chainId]!.weth)) throw new Error(`balancer: the Vault on chain ${chainId} is not the pinned deployment — refusing`);
      })();
      p.catch(() => verified.delete(chainId));
      verified.set(chainId, p);
    }
    return p;
  }

  /** Vault.queryBatchSwap on chain: the asset deltas this exact batch would produce. */
  async function query(chainId: number, swaps: readonly Step[], assets: readonly Hex[], funds: Funds): Promise<readonly bigint[]> {
    const data = encodeFunctionData({abi: VAULT_ABI, functionName: "queryBatchSwap", args: [0, swaps, assets, funds]});
    const raw = (await rpc(chainId, "eth_call", [{to: BALANCER_V2_VAULT, data}, "latest"])) as Hex;
    return decodeFunctionResult({abi: VAULT_ABI, functionName: "queryBatchSwap", data: raw});
  }

  return {
    name: "balancer",
    supportsSameChain: true,
    enabled: () => config.enabled ?? true,
    supportsChain: (caip2: string) => chainIdOf(caip2) !== null,
    supportsChainPair: (from: string, to: string) => from === to && chainIdOf(from) !== null,
    supportsRoute: (from: Asset, to: Asset) => from.chain === to.chain && chainIdOf(from.chain) !== null,

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      const refuse = (why: string): null => {
        params.onRefusal?.(`balancer: ${why}`);
        return null;
      };
      if (params.flex) return refuse("amount-flexible deposits are not supported");
      if (params.sourceChain !== params.destChain) return refuse("same-chain swaps only");
      const chainId = chainIdOf(params.sourceChain);
      if (chainId === null) return refuse(`no Balancer v2 Vault or RPC for ${params.sourceChain}`);
      const chain = BALANCER_V2_CHAINS[chainId]!;
      const src = ccAsset(params.sourceChain, params.sourceToken);
      if (!src) return refuse(`unknown source token ${params.sourceToken}`);
      const nativeIn = !src.contract;
      const nativeOut = /^0x0+$/.test(params.destToken);
      if (!nativeOut && !/^0x[0-9a-fA-F]{40}$/.test(params.destToken)) return refuse("destination token must be an EVM address");
      if (!/^0x[0-9a-fA-F]{40}$/.test(params.destAddress)) return refuse("recipient must be an EVM address");
      let amountIn: bigint;
      try {
        amountIn = BigInt(params.amountIn);
      } catch {
        return refuse("amount is not an integer");
      }
      if (amountIn <= 0n) return refuse("amount must be positive");
      const tokenIn = getAddress(nativeIn ? chain.weth : src.contract!);
      const tokenOut = getAddress(nativeOut ? chain.weth : params.destToken);
      if (tokenIn === tokenOut) return refuse(nativeIn || nativeOut ? "that is a wrap/unwrap, not a swap" : "same token in and out");

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
        if (!res.ok) return refuse(`SOR answered HTTP ${res.status}`);
        const body = (await res.json()) as {data?: {sorGetSwapPaths?: {protocolVersion?: number; paths?: SorPath[]}}; errors?: {message?: string}[]};
        const paths = body.data?.sorGetSwapPaths?.paths ?? [];
        if (body.errors?.length) return refuse(`SOR: ${body.errors[0]?.message?.slice(0, 120) ?? "error"}`);
        if (!paths.length || paths.some((p) => p.protocolVersion !== 2 || p.pools.length === 0 || p.tokens.length !== p.pools.length + 1)) {
          return refuse("no Balancer v2 pool route for this pair and amount");
        }
        if (paths.reduce((s, p) => s + BigInt(p.inputAmountRaw), 0n) !== amountIn) return refuse("the SOR split does not add up to the amount");

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
          if (getAddress(p.tokens[0]!.address) !== tokenIn || getAddress(p.tokens[p.tokens.length - 1]!.address) !== tokenOut) return refuse("the SOR path does not start/end at the requested tokens");
          p.pools.forEach((pool, i) => {
            if (!/^0x[0-9a-fA-F]{64}$/.test(pool)) throw new Error("balancer: malformed pool id from the SOR");
            swaps.push({poolId: pool as Hex, assetInIndex: indexOf(p.tokens[i]!.address), assetOutIndex: indexOf(p.tokens[i + 1]!.address), amount: i === 0 ? BigInt(p.inputAmountRaw) : 0n, userData: "0x"});
          });
        }
        const inIdx = Number(indexOf(tokenIn));
        const outIdx = Number(indexOf(tokenOut));
        // The Vault's ETH sentinel: native in/out wraps/unwraps through its WETH.
        if (nativeIn || nativeOut) {
          const wethIdx = assets.findIndex((a) => a === getAddress(chain.weth));
          if (paths.some((p) => p.tokens.slice(1, -1).some((t) => getAddress(t.address) === getAddress(chain.weth)))) return refuse("this route passes through the wrapped native — pick the wrapped token instead");
          if (wethIdx >= 0) assets[wethIdx] = ZERO as Hex;
        }
        const sender = getAddress(params.refundAddress && /^0x[0-9a-fA-F]{40}$/.test(params.refundAddress) ? params.refundAddress : params.destAddress);
        const recipient = getAddress(params.destAddress);
        const funds: Funds = {sender, fromInternalBalance: false, recipient, toInternalBalance: false};

        // 3) Price it on-chain — this, not the SOR's number, is the quote.
        const deltas = await query(chainId, swaps, assets, funds);
        const paid = deltas[inIdx]!;
        const out = -deltas[outIdx]!;
        if (paid !== amountIn) return refuse(`the Vault would take ${paid}, not ${amountIn}`);
        if (out <= 0n) return refuse("the Vault prices this route at zero output");
        if (deltas.some((d, i) => i !== inIdx && i !== outIdx && d !== 0n)) return refuse("the batch leaves an intermediate balance — refusing");

        const bps = params.slippageBps ?? slippageDefault;
        const minOut = (out * BigInt(10_000 - bps)) / 10_000n;
        if (params.minAmountOut !== undefined && minOut < BigInt(params.minAmountOut)) return refuse(`floor breach (min=${minOut} < floor=${params.minAmountOut})`);
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
          providerData: {paths: String(paths.length), hops: String(swaps.length), minOut: minOut.toString()},
        };
      } catch (e) {
        return refuse(e instanceof Error ? e.message.replace(/^balancer: /, "") : String(e));
      }
    },

    /** Re-price the exact signed batch right before broadcast; refuse when the pools now pay under the minimum. */
    async preflightDeposit(quote: Quote, tx: UnsignedTx): Promise<void> {
      const chainId = Number(quote.intentId.split(":")[1]);
      const minOut = quote.providerData?.minOut;
      if (!BALANCER_V2_CHAINS[chainId] || !minOut || !tx.data) return;
      const call = decodeFunctionData({abi: VAULT_ABI, data: tx.data as Hex});
      if (call.functionName !== "batchSwap") throw new Error("balancer: the transaction is not a Vault batchSwap");
      const [, swaps, assets, funds, limits] = call.args;
      const outIdx = limits.findIndex((l) => l < 0n);
      const deltas = await query(chainId, swaps, assets, funds);
      const out = -deltas[outIdx]!;
      if (out < BigInt(minOut)) throw new Error(`balancer: price moved — the pools now pay ${out}, under your minimum ${minOut}. Nothing was sent; refresh the quote.`);
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const tx = quote.txRequest;
      if (!tx?.to || !tx.data) throw new Error("swap2: Balancer quote has no transaction request");
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
