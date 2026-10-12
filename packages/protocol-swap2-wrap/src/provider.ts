import {decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, type Hex} from "viem";
import {ccAsset} from "@forgewallet/swap2-assets";
import {evmRef, isEvm, timeoutSignal} from "@forgewallet/protocol-swap2-core/util";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@forgewallet/protocol-swap2-core/types";

/**
 * The chain's canonical wrapped native token (WETH9-style `deposit()` /
 * `withdraw(uint256)`). Every entry was checked on-chain 2026-10-12: symbol,
 * 18 decimals, non-zero supply, and `deposit()` succeeding for a funded sender.
 * The provider re-checks symbol + decimals once per chain before quoting.
 */
export const WRAPPED_NATIVE: Readonly<Record<number, {address: `0x${string}`; symbol: string}>> = Object.freeze({
  1: {address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH"},
  10: {address: "0x4200000000000000000000000000000000000006", symbol: "WETH"},
  56: {address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", symbol: "WBNB"},
  100: {address: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", symbol: "WXDAI"},
  130: {address: "0x4200000000000000000000000000000000000006", symbol: "WETH"},
  137: {address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", symbol: "WPOL"},
  143: {address: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", symbol: "WMON"},
  999: {address: "0x5555555555555555555555555555555555555555", symbol: "WHYPE"},
  324: {address: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91", symbol: "WETH"},
  4326: {address: "0x4200000000000000000000000000000000000006", symbol: "WETH"},
  9745: {address: "0x6100E367285b01F48D07953803A2d8dCA5D19873", symbol: "WXPL"},
  59144: {address: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f", symbol: "WETH"},
  8453: {address: "0x4200000000000000000000000000000000000006", symbol: "WETH"},
  42161: {address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", symbol: "WETH"},
  43114: {address: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", symbol: "WAVAX"},
  80094: {address: "0x6969696969696969696969696969696969696969", symbol: "WBERA"},
  534352: {address: "0x5300000000000000000000000000000000000004", symbol: "WETH"},
});

const WETH_ABI = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
/** deposit/withdraw on WETH9 cost ~30-45k; a generous cap, the account still estimates. */
const GAS_LIMIT = "90000";

export interface WrapProviderConfig {
  enabled?: boolean;
  /** JSON-RPC endpoints per EVM chain id (on-chain token check + receipt tracking). */
  rpcUrls: Readonly<Record<number, readonly string[]>>;
  /** Override the wrapped tokens (tests, new chains). Still verified on-chain before use. */
  wrapped?: Readonly<Record<number, {address: `0x${string}`; symbol: string}>>;
}

/**
 * Native ↔ wrapped native as a swap2 venue: `deposit()` with value to wrap,
 * `withdraw(amount)` to unwrap. 1:1, no pool, no slippage, no approval. WETH9
 * credits and pays `msg.sender`, so the recipient must be the sender — a wrap
 * "to someone else" is refused rather than silently paid to the wrong place.
 */
export function wrapProvider(config: WrapProviderConfig): CrossChainProvider {
  const wrapped = config.wrapped ?? WRAPPED_NATIVE;
  const verified = new Map<number, Promise<void>>();

  const chainIdOf = (caip2: string): number | null => {
    if (!isEvm(caip2)) return null;
    const id = evmRef(caip2);
    return wrapped[id] && config.rpcUrls[id]?.length ? id : null;
  };

  async function rpc(chainId: number, method: string, params: unknown[]): Promise<unknown> {
    let lastErr: unknown;
    for (const url of config.rpcUrls[chainId] ?? []) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {"content-type": "application/json"},
          body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
          signal: timeoutSignal(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {result?: unknown; error?: {message?: string}};
        if (body.error) throw new Error(body.error.message ?? "rpc error");
        return body.result ?? null;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`wrap: no RPC answered on chain ${chainId} (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`);
  }

  function verify(chainId: number): Promise<void> {
    let p = verified.get(chainId);
    if (!p) {
      const w = wrapped[chainId]!;
      p = (async () => {
        const read = async (fn: "symbol" | "decimals") =>
          decodeFunctionResult({abi: WETH_ABI, functionName: fn, data: (await rpc(chainId, "eth_call", [{to: w.address, data: encodeFunctionData({abi: WETH_ABI, functionName: fn})}, "latest"])) as Hex});
        const [symbol, decimals] = await Promise.all([read("symbol"), read("decimals")]);
        if (symbol !== w.symbol || Number(decimals) !== 18) throw new Error(`wrap: ${w.address} on chain ${chainId} is not ${w.symbol} — refusing`);
      })();
      p.catch(() => verified.delete(chainId));
      verified.set(chainId, p);
    }
    return p;
  }

  return {
    name: "wrap",
    supportsSameChain: true,
    enabled: () => config.enabled ?? true,
    supportsChain: (caip2: string) => chainIdOf(caip2) !== null,
    supportsChainPair: (from: string, to: string) => from === to && chainIdOf(from) !== null,
    supportsRoute(from: Asset, to: Asset): boolean {
      return from.chain === to.chain && chainIdOf(from.chain) !== null;
    },

    async getQuote(params: QuoteParams): Promise<Quote | null> {
      const refuse = (why: string): null => {
        params.onRefusal?.(`wrap: ${why}`);
        return null;
      };
      if (params.flex) return refuse("amount-flexible deposits are not supported");
      if (params.sourceChain !== params.destChain) return refuse("same-chain only");
      const chainId = chainIdOf(params.sourceChain);
      if (chainId === null) return refuse(`no wrapped native token or RPC for ${params.sourceChain}`);
      const w = wrapped[chainId]!;
      const src = ccAsset(params.sourceChain, params.sourceToken);
      if (!src) return refuse(`unknown source token ${params.sourceToken}`);
      const nativeIn = !src.contract;
      const srcIsWrapped = !!src.contract && /^0x[0-9a-fA-F]{40}$/.test(src.contract) && getAddress(src.contract) === getAddress(w.address);
      const nativeOut = /^0x0+$/.test(params.destToken);
      const destIsWrapped = /^0x[0-9a-fA-F]{40}$/.test(params.destToken) && !nativeOut && getAddress(params.destToken) === getAddress(w.address);
      const wrap = nativeIn && destIsWrapped;
      const unwrap = srcIsWrapped && nativeOut;
      if (!wrap && !unwrap) return refuse(`only ${w.symbol.slice(1)} ↔ ${w.symbol}`);
      // WETH9 credits / pays msg.sender: the recipient can only be the sender.
      if (params.refundAddress && /^0x[0-9a-fA-F]{40}$/.test(params.refundAddress) && getAddress(params.refundAddress) !== getAddress(params.destAddress)) {
        return refuse("wrapping pays the sender's own address — send the result separately");
      }
      let amount: bigint;
      try {
        amount = BigInt(params.amountIn);
      } catch {
        return refuse("amount is not an integer");
      }
      if (amount <= 0n) return refuse("amount must be positive");
      if (params.minAmountOut !== undefined && amount < BigInt(params.minAmountOut)) return refuse(`floor breach (min=${amount} < floor=${params.minAmountOut})`);
      try {
        await verify(chainId);
      } catch (e) {
        return refuse(e instanceof Error ? e.message.replace(/^wrap: /, "") : String(e));
      }
      const data = wrap ? encodeFunctionData({abi: WETH_ABI, functionName: "deposit"}) : encodeFunctionData({abi: WETH_ABI, functionName: "withdraw", args: [amount]});
      return {
        provider: "wrap",
        intentId: `wrap:${chainId}`,
        depositAddress: "",
        depositMemo: null,
        txRequest: {to: w.address, data, value: wrap ? amount.toString() : "0", chainId, gasLimit: GAS_LIMIT},
        sourceAmount: amount.toString(),
        destAmount: amount.toString(),
        minDestAmount: amount.toString(),
        feeUsd: 0,
        etaSeconds: 15,
        reliability: 0.995,
        validUntilMs: Date.now() + 5 * 60_000,
        providerData: {action: wrap ? "wrap" : "unwrap", token: w.address},
      };
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const tx = quote.txRequest;
      if (!tx?.to || !tx.data) throw new Error("swap2: wrap quote has no transaction request");
      return {chain: "", to: tx.to, value: tx.value ?? "0", data: tx.data, ...(tx.chainId !== undefined ? {chainId: tx.chainId} : {}), ...(tx.gasLimit ? {gasLimit: tx.gasLimit} : {})};
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      if (!ref.sourceTxHash) return {state: "pending"};
      const chainId = Number(ref.intentId.split(":")[1]);
      if (!wrapped[chainId] || !config.rpcUrls[chainId]?.length) return {state: "pending"};
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
