import {LIFI_SOLANA_CAIP2, lifi as lifiCfg} from "./config.js";
import {describeLifiActivity} from "./activity.js";
import {ccAsset} from "@forgewallet/swap2-assets";
import {timeoutSignal} from "@forgewallet/protocol-swap2-core/util";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@forgewallet/protocol-swap2-core/types";

/**
 * LI.FI meta-aggregator — the CALLDATA execution model: the quote returns a
 * `transactionRequest` the USER'S WALLET must execute. There is no deposit
 * address — a plain transfer to `transactionRequest.to` would lose funds, so
 * the client branches on `quote.txRequest`. Live-verified shapes (2026-07):
 * EVM → {to, data, value, chainId, gasLimit}; Solana → {data: base64 tx}, a
 * fully built v0 transaction (Jupiter route) the account signs after proving
 * its balance effects (`serializedTx`). Tron returns a raw protobuf we can't
 * hand to wallets yet — Tron stays on the direct NEAR Intents route (LI.FI
 * routes it through NEAR anyway, so nothing is lost).
 */

const DEFAULT_LIFI_BASE = "https://li.quest/v1";

/** Our CAIP-2 → LI.FI chain ids. */
const LIFI_CHAIN: Record<string, string> = {
  "eip155:1": "1",
  "eip155:8453": "8453",
  "eip155:56": "56",
  "eip155:137": "137",
  "eip155:42161": "42161",
  "eip155:10": "10",
  "eip155:100": "100",
  "eip155:143": "143",
  "eip155:130": "130",
  "eip155:999": "999",
  "eip155:4663": "4663",
  // 2026-08 sweep additions (all live on li.quest/v1/chains).
  "eip155:43114": "43114",
  "eip155:534352": "534352",
  "eip155:80094": "80094",
  // 2026-10-12: zkSync Era, Celo, MegaETH (live on li.quest/v1/chains).
  "eip155:324": "324",
  "eip155:42220": "42220",
  "eip155:4326": "4326",
  "eip155:9745": "9745",
  "eip155:59144": "59144",
  "eip155:146": "146",
  // 2026-10-13: World Chain, Sei, Ink, Plume, X Layer (live on li.quest/v1/chains).
  "eip155:480": "480",
  "eip155:1329": "1329",
  "eip155:57073": "57073",
  "eip155:98866": "98866",
  "eip155:196": "196",
  [LIFI_SOLANA_CAIP2]: "1151111081099710",
};
const CAIP2_BY_LIFI_CHAIN: Record<string, string> = Object.fromEntries(Object.entries(LIFI_CHAIN).map(([caip2, id]) => [id, caip2]));

const EVM_ZERO = "0x0000000000000000000000000000000000000000";
/** LI.FI's native-SOL token id (the System program address). */
const SOLANA_NATIVE = "11111111111111111111111111111111";
const EVM_PLACEHOLDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
/** Dry-quote sender on Solana: the publicly known BIP-39 "abandon" account 0. */
const SOLANA_PLACEHOLDER = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const isSolana = (chain: string) => chain === LIFI_SOLANA_CAIP2;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Chain-aware address equality: EVM case-insensitive, Solana exact base58. */
function sameChainAddress(chain: string, actual: string | undefined, expected: string): boolean {
  if (isSolana(chain)) return !!actual && BASE58.test(actual) && actual === expected;
  return sameAddress(actual, expected);
}
/** The engine's native sentinel (`0x0…`) in the chain's own notation. */
function nativeFor(chain: string, token: string): string {
  if (/^0x0+$/.test(token) || token === SOLANA_NATIVE) return isSolana(chain) ? SOLANA_NATIVE : EVM_ZERO;
  return token;
}
/** LI.FI's documented Diamond entry point on most supported EVM networks. */
const LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
/**
 * Chains where the Diamond lives at a different address — from
 * github.com/lifinance/contracts `deployments/<chain>.json` (`LiFiDiamond`).
 * On these chains ONLY that address is the entry point; the canonical one is
 * not deployed there and is therefore not trusted.
 */
const LIFI_DIAMONDS: Readonly<Record<string, string>> = {
  "eip155:4663": "0xB477751B76CF82d00a686A1232f5fCD772414Af3", // Robinhood Chain (deployments/robinhood.json, verified 2026-10-09)
  "eip155:999": "0x0a0758d937d1059c356D4714e57F5df0239bce1A", // HyperEVM (deployments/hyperevm.json, verified 2026-10-09)
  "eip155:143": "0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37", // Monad (deployments/monad.json, verified 2026-10-11)
  "eip155:130": "0x864b314D4C5a0399368609581d3E8933a63b9232", // Unichain (deployments/unichain.json, verified 2026-10-11)
  "eip155:80094": "0xf909c4Ae16622898b885B89d7F839E0244851c66", // Berachain (deployments/berachain.json, verified 2026-10-11)
  "eip155:324": "0x341e94069f53234fE6DabeF707aD424830525715", // zkSync Era (deployments/zksync.json, matches a live quote 2026-10-12)
  "eip155:9745": "0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37", // Plasma (deployments/plasma.json, 2026-10-13)
  "eip155:59144": "0xDE1E598b81620773454588B85D6b5D4eEC32573e", // Linea (deployments/linea.json, 2026-10-13)
  "eip155:57073": "0x864b314D4C5a0399368609581d3E8933a63b9232", // Ink (deployments/ink.json, 2026-10-13)
  "eip155:98866": "0x6f5C8Bb0C5Fe4ECeAC40EE1C238EaB6bbb29761c", // Plume (deployments/plume.json, 2026-10-13)
  "eip155:4326": "0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37", // MegaETH (deployments/megaeth.json, matches a live quote 2026-10-12)
};
const diamondFor = (chain: string): string => LIFI_DIAMONDS[chain] ?? LIFI_DIAMOND;
const DEFAULT_QUOTE_TTL_MS = 55_000;

function normalizeAddress(value: string | undefined): string | null {
  return value && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
}

function sameAddress(actual: string | undefined, expected: string): boolean {
  return normalizeAddress(actual) === normalizeAddress(expected);
}

function isHexData(value: string | undefined): value is string {
  return !!value && /^0x(?:[0-9a-fA-F]{2})+$/.test(value);
}

function trustedAddress(
  chain: string,
  address: string | undefined,
  configured: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const normalized = normalizeAddress(address);
  if (!normalized) return false;
  return normalizeAddress(diamondFor(chain)) === normalized || configured.get(chain)?.has(normalized) === true;
}

function trustMap(input: Readonly<Record<string, readonly string[]>> | undefined, label: string): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  for (const [chain, addresses] of Object.entries(input ?? {})) {
    const normalized = new Set<string>();
    for (const address of addresses) {
      const value = normalizeAddress(address);
      if (!value) throw new Error(`lifi: invalid ${label} address for ${chain}`);
      normalized.add(value);
    }
    out.set(chain, normalized);
  }
  return out;
}

/** LI.FI token id on the source chain: contract, or the chain's native id. */
function lifiToken(sourceChain: string, symbol: string): string | null {
  const asset = ccAsset(sourceChain, symbol);
  if (!asset) return null;
  if (asset.contract) return asset.contract;
  return isSolana(sourceChain) ? SOLANA_NATIVE : EVM_ZERO;
}

function headers(key: string | undefined): Record<string, string> {
  const h: Record<string, string> = {accept: "application/json"};
  if (key) h["x-lifi-api-key"] = key;
  return h;
}

/** Explicit constructor configuration; no deployment environment is read. */
export interface LifiProviderConfig {
  enabled?: boolean;
  /** LI.FI REST base URL. Explicitly injectable for proxies and tests. */
  apiUrl?: string;
  apiKey?: string;
  integrator?: string;
  /** Additional audited LI.FI entry points for networks whose Diamond differs. */
  trustedTransactionTargets?: Readonly<Record<string, readonly string[]>>;
  /** Additional audited ERC-20 spenders returned by LI.FI for direct routes. */
  trustedApprovalAddresses?: Readonly<Record<string, readonly string[]>>;
  /** Fail-closed local lifetime for the provider's documented ~60s quote window. */
  quoteTtlMs?: number;
  /**
   * Slippage sent when the caller names none (bps, default 50 = LI.FI's own
   * documented default). Left unset, LI.FI picks it per request and it swings
   * (0.9%–6% within a minute on Base ETH → Robinhood, 2026-10-12): the display
   * quote's minimum then sits above the live one and the execution floor
   * refuses a route that hasn't moved.
   */
  defaultSlippageBps?: number;
}

export function lifiProvider(config: LifiProviderConfig = {}): CrossChainProvider {
  config = Object.freeze({...config});
  const apiKey = () => config.apiKey;
  const integrator = () => config.integrator ?? "";
  const parsedApiUrl = new URL(config.apiUrl ?? DEFAULT_LIFI_BASE);
  if (parsedApiUrl.protocol !== "https:" && parsedApiUrl.protocol !== "http:") {
    throw new Error("lifi: apiUrl must use http or https");
  }
  const apiBase = parsedApiUrl.toString().replace(/\/$/, "");
  const trustedTransactionTargets = trustMap(config.trustedTransactionTargets, "transaction target");
  const trustedApprovalAddresses = trustMap(config.trustedApprovalAddresses, "approval");
  const quoteTtlMs = config.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS;
  const defaultSlippageBps = config.defaultSlippageBps ?? 50;
  if (!Number.isInteger(defaultSlippageBps) || defaultSlippageBps <= 0 || defaultSlippageBps >= 10_000) {
    throw new Error("lifi: defaultSlippageBps must be an integer between 1 and 9999");
  }
  if (!Number.isInteger(quoteTtlMs) || quoteTtlMs <= 0 || quoteTtlMs > 60_000) {
    throw new Error("lifi: quoteTtlMs must be an integer between 1 and 60000");
  }
  return {
    name: "lifi",
    describeActivity: (tx, ctx) => describeLifiActivity(tx, ctx, (chain, address) => trustedAddress(chain, address, trustedTransactionTargets)),
    supportsSameChain: true,
    enabled: () => config.enabled ?? true,

    // Capability discovery comes from the provider itself, so it can run alone
    // or inside the optional aggregator without a central capability table.
    supportsChain: (chain: string) => lifiCfg.supportsChain(chain),
    supportsChainPair: (fromChain: string, toChain: string) => lifiCfg.supports(fromChain, toChain),
    supportsRoute(from: Asset, to: Asset): boolean {
      // EVM only: LI.FI's Solana/Tron legs come back as provider-serialized
      // transactions, which the swap2 engine does not execute yet.
      return !!LIFI_CHAIN[from.chain] && !!LIFI_CHAIN[to.chain];
    },

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      if (params.flex) return null; // calldata model — the amount is baked in
      const fromChain = LIFI_CHAIN[params.sourceChain];
      const toChain = LIFI_CHAIN[params.destChain];
      if (!fromChain || !toChain) return null;
      const fromToken = lifiToken(params.sourceChain, params.sourceToken);
      if (!fromToken) return null;

      const solanaSource = isSolana(params.sourceChain);
      const fromAddress = params.refundAddress ?? (solanaSource ? SOLANA_PLACEHOLDER : EVM_PLACEHOLDER);

      // LI.FI applies `slippage` to EACH step of a multi-step route (bridge +
      // destination swap), so its minimum can sit ~2× the requested slippage
      // under the quote (seen 2026-10-10 on 479 of 4 000 matrix quotes), and
      // it truncates toAmountMin to a few significant digits. The engine
      // rejects a floor below the requested one, so the quote is asked once
      // more with the slippage scaled down to land the floor inside it.
      const slippageBps = params.slippageBps ?? defaultSlippageBps;
      let sentSlippage: number | undefined = slippageBps / 10_000;
      let deadline: AbortSignal | undefined;
      for (let attempt = 0; attempt < 2; attempt++) try {
        const url = new URL(`${apiBase}/quote`);
        url.searchParams.set("fromChain", fromChain);
        url.searchParams.set("toChain", toChain);
        url.searchParams.set("fromToken", fromToken);
        // Native dest is chain-notation-specific: EVM zero address vs the
        // Solana system program — sending the EVM zero to an SVM dest 400s.
        url.searchParams.set("toToken", nativeFor(params.destChain, params.destToken));
        url.searchParams.set("fromAmount", params.amountIn);
        url.searchParams.set("fromAddress", fromAddress);
        const toAddress = params.destAddress || fromAddress;
        url.searchParams.set("toAddress", toAddress);
        const integratorId = integrator().trim();
        if (integratorId) url.searchParams.set("integrator", integratorId);
        if (sentSlippage !== undefined) {
          url.searchParams.set("slippage", String(sentSlippage));
        }
        deadline = signal ? undefined : timeoutSignal(12_000);
        const res = await fetch(url, {headers: headers(apiKey()), signal: signal ?? deadline!});
        if (!res.ok) {
          // LI.FI's 404 "No available quotes for the requested transfer" and
          // 400 validation messages are the caller's answer, not a silent null.
          const body = (await res.json().catch(() => null)) as {message?: unknown; errors?: {filteredOut?: {reason?: unknown}[]}} | null;
          // When every candidate route was dropped for the same reason (Sei: "wallet is not linked to
          // the original SEI address"), that reason is the real answer — the message alone is generic.
          const reasons = [...new Set((body?.errors?.filteredOut ?? []).map((f) => f.reason).filter((r): r is string => typeof r === "string"))];
          const why = reasons.length === 1 ? ` (${reasons[0]!.slice(0, 200)})` : "";
          params.onRefusal?.(`lifi: ${typeof body?.message === "string" ? body.message.slice(0, 200) : `HTTP ${res.status}`}${why}`);
          return null;
        }
        const q = (await res.json()) as {
          type?: string;
          id?: string;
          action?: {
            fromToken?: {address?: string; chainId?: number};
            toToken?: {address?: string; chainId?: number};
            fromAmount?: string;
            fromChainId?: number;
            toChainId?: number;
            slippage?: number;
            fromAddress?: string;
            toAddress?: string;
          };
          estimate?: {
            fromAmount?: string;
            toAmount?: string;
            toAmountMin?: string;
            executionDuration?: number;
            approvalAddress?: string;
            feeCosts?: {amountUSD?: string}[];
            gasCosts?: {amountUSD?: string}[];
          };
          transactionRequest?: {
            to?: string;
            data?: string;
            value?: string;
            chainId?: number;
            gasLimit?: string;
            from?: string;
          };
        };
        const receivedAt = Date.now();
        const action = q.action;
        const est = q.estimate;
        const tr = q.transactionRequest;
        const expectedToToken = nativeFor(params.destChain, params.destToken);
        const expectedFromChain = Number(fromChain);
        const expectedToChain = Number(toChain);
        if (
          q.type !== "lifi" || !q.id || !action || !est?.toAmount || !est.fromAmount || !tr ||
          action.fromChainId !== expectedFromChain || action.toChainId !== expectedToChain ||
          action.fromToken?.chainId !== expectedFromChain || action.toToken?.chainId !== expectedToChain ||
          !sameChainAddress(params.sourceChain, action.fromToken?.address, fromToken) ||
          !sameChainAddress(params.destChain, action.toToken?.address, expectedToToken) ||
          action.fromAmount !== params.amountIn || est.fromAmount !== params.amountIn ||
          !sameChainAddress(params.sourceChain, action.fromAddress, fromAddress) ||
          !sameChainAddress(params.destChain, action.toAddress, toAddress)
        ) return null;
        // Source-VM execution payload. EVM: calldata to a trusted target.
        // Solana: a base64 transaction the account proves before signing —
        // there is no target to trust here, the balance proof replaces it.
        if (solanaSource) {
          if (!tr.data || tr.data.length < 64 || tr.data.length % 4 !== 0 || !BASE64.test(tr.data)) return null;
          if (tr.to !== undefined || tr.value !== undefined || tr.gasLimit !== undefined) return null;
          // `estimate.approvalAddress` is ignored for a Solana source: LI.FI
          // returns its EVM diamond here on Mayan routes too (seen 2026-10-09,
          // SOL → Base USDC via mayanFastMCTP), and Solana has no allowances —
          // the account's post-state balance proof is the guard, not an
          // approval target. It is never propagated.
        } else if (
          !isHexData(tr.data) || !normalizeAddress(tr.to) || !normalizeAddress(tr.from) ||
          tr.chainId !== expectedFromChain || !tr.value || !tr.gasLimit ||
          !trustedAddress(params.sourceChain, tr.to, trustedTransactionTargets) ||
          !sameAddress(tr.from, fromAddress)
        ) return null;
        if (
          sentSlippage !== undefined &&
          (typeof action.slippage !== "number" || Math.abs(action.slippage - sentSlippage) > 1e-12)
        ) return null;

        const sourceIsToken = fromToken !== EVM_ZERO && fromToken !== SOLANA_NATIVE;
        if (solanaSource) {
          // No allowances on Solana; nothing to trust beyond the balance proof.
        } else if (sourceIsToken) {
          if (!trustedAddress(params.sourceChain, est.approvalAddress, trustedApprovalAddresses)) return null;
        } else if (est.approvalAddress !== undefined) {
          // LI.FI started returning an approvalAddress for NATIVE sources too
          // (seen 2026-09 on every ETH-source quote, e.g. ETH → Robinhood via
          // relay: approvalAddress = the diamond the tx already calls). An
          // approval is meaningless for the native asset, so it is not a
          // reason to refuse the quote — but it must still be a trusted
          // target, and it is never propagated for a native source.
          if (!trustedAddress(params.sourceChain, est.approvalAddress, trustedApprovalAddresses)) return null;
        }

        let txRequest: NonNullable<Quote["txRequest"]>;
        if (solanaSource) {
          // `value` declares what the account may let the tx take in native
          // coin: the input for a SOL source, nothing for a token source.
          txRequest = {serializedTx: tr.data!, value: sourceIsToken ? "0" : params.amountIn};
        } else {
          try {
            if (BigInt(tr.value!) < 0n || BigInt(tr.gasLimit!) <= 0n) return null;
          } catch {
            return null;
          }
          // Some bridges charge a native messaging fee inside `value`: for a
          // token source the whole value is that fee; for a native source it
          // is whatever exceeds the input (seen 2026-10-10: DAI Optimism →
          // Base, POL Polygon → Optimism). Declared here, sealed with the
          // quote, bounded by the engine — never silently attached.
          const value = BigInt(tr.value!);
          const nativeFee = sourceIsToken ? value : value > BigInt(params.amountIn) ? value - BigInt(params.amountIn) : 0n;
          if (!sourceIsToken && value < BigInt(params.amountIn)) return null;
          txRequest = {
            to: tr.to!,
            data: tr.data!,
            value: value.toString(),
            chainId: tr.chainId!,
            gasLimit: BigInt(tr.gasLimit!).toString(),
            ...(sourceIsToken && est.approvalAddress ? {approvalAddress: est.approvalAddress} : {}),
            ...(nativeFee > 0n ? {nativeFee: nativeFee.toString()} : {}),
          };
        }

        // Route fees only (bridge / protocol / integrator). The source
        // transaction's gas is the network fee the wallet shows on its own line —
        // counting it here too made LI.FI look dearer than on-chain venues whose
        // fee excludes gas (2026-10-13).
        const feeUsd = (est.feeCosts ?? []).reduce((a, f) => a + Number(f.amountUSD ?? 0), 0);

        // The optimistic output is not a safety floor. A quote without the
        // provider's minimum cannot satisfy an exact-input execution contract.
        if (!est.toAmountMin) return null;
        const minDestAmount = est.toAmountMin;
        if (sentSlippage !== undefined) {
          const dest = BigInt(est.toAmount);
          const min = BigInt(minDestAmount);
          if (dest > 0n && min < (dest * BigInt(10_000 - slippageBps)) / 10_000n) {
            const effective = Number(((dest - min) * 1_000_000n) / dest) / 1_000_000;
            const requested = slippageBps / 10_000;
            const scaled: number = Math.floor(((sentSlippage * requested) / effective) * 0.995 * 1_000_000) / 1_000_000;
            if (attempt === 0 && effective > 0 && scaled > 0) {
              sentSlippage = scaled;
              continue;
            }
            params.onRefusal?.(
              `lifi: this route's minimum is ${(effective * 100).toFixed(2)}% under the quote (LI.FI applies slippage on every step) — more than the requested ${slippageBps / 100}%`,
            );
            return null;
          }
        }
        if (params.minAmountOut !== undefined && BigInt(minDestAmount) < BigInt(params.minAmountOut)) {
          params.onRefusal?.(`lifi: floor breach (min=${minDestAmount} < floor=${params.minAmountOut})`);
          return null;
        }
        return {
          provider: "lifi",
          // Status is tracked by SOURCE TX HASH + the chain pair.
          intentId: `lifi:${fromChain}:${toChain}`,
          depositAddress: "",
          depositMemo: null,
          txRequest,
          sourceAmount: est.fromAmount,
          destAmount: est.toAmount,
          minDestAmount,
          feeUsd,
          etaSeconds: est.executionDuration ?? 120,
          reliability: 0.97,
          // LI.FI documents an approximately 60-second lifetime. Use a slightly
          // shorter local deadline and re-quote again at execution time.
          validUntilMs: receivedAt + quoteTtlMs,
        };
      } catch {
        // Our own 12 s deadline (not the caller's signal): say so instead of a silent null.
        if (deadline?.aborted) params.onRefusal?.("lifi: no quote within 12 s");
        return null;
      }
      return null;
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const tx = quote.txRequest;
      if (!tx) throw new Error("swap2: LI.FI quote has no transaction request");
      // The intent id carries the LI.FI source chain; a serialized leg names
      // its chain so the engine can refuse a mismatched account.
      const [, fromChain] = quote.intentId.split(":");
      return {
        chain: tx.serializedTx ? CAIP2_BY_LIFI_CHAIN[fromChain ?? ""] ?? "" : "",
        to: tx.to ?? "",
        value: tx.value ?? "0",
        ...(tx.data ? {data: tx.data} : {}),
        ...(tx.chainId !== undefined ? {chainId: tx.chainId} : {}),
        ...(tx.gasLimit ? {gasLimit: tx.gasLimit} : {}),
        ...(tx.approvalAddress ? {approvalAddress: tx.approvalAddress} : {}),
        ...(tx.serializedTx ? {serializedTx: tx.serializedTx} : {}),
      };
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      if (!ref.sourceTxHash) return {state: "pending"}; // not broadcast yet
      const [, fromChain, toChain] = ref.intentId.split(":");
      try {
        const url = new URL(`${apiBase}/status`);
        url.searchParams.set("txHash", ref.sourceTxHash);
        if (fromChain) url.searchParams.set("fromChain", fromChain);
        if (toChain) url.searchParams.set("toChain", toChain);
        const res = await fetch(url, {headers: headers(apiKey()), signal: timeoutSignal(12_000)});
        if (!res.ok) return {state: "pending"};
        const s = (await res.json()) as {status?: string; substatus?: string; receiving?: {txHash?: string}};
        const map: Record<string, IntentStatus["state"]> = {
          DONE: "completed",
          FAILED: "failed",
          PENDING: "pending",
          NOT_FOUND: "pending",
        };
        // LI.FI reports refunds and partial fills as top-level DONE. Treating
        // those as completed would falsely claim that the destination was fully
        // funded. Keep the explicit partial/refund lifecycle states.
        const state = s.substatus === "REFUNDED"
          ? "refunded"
          : s.substatus === "EXPIRED"
            ? "expired"
            : s.substatus === "NOT_PROCESSABLE_REFUND_NEEDED"
              ? "action-required"
              : s.substatus === "REFUND_IN_PROGRESS"
                ? "refund-pending"
                : s.status === "DONE" && s.substatus === "PARTIAL"
                  ? "partial"
                  : map[s.status ?? "PENDING"] ?? "pending";
        const depositReceived = state === "pending" && s.status === "PENDING";
        const destTxHash = typeof s.receiving?.txHash === "string" && s.receiving.txHash.length > 0
          ? s.receiving.txHash
          : undefined;
        return {
          state,
          depositReceived,
          ...(destTxHash ? {destTxHash} : {}),
        };
      } catch {
        return {state: "pending"};
      }
    },
  };
}
