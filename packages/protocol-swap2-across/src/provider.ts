import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {refusal, refusalOf, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {ccAsset} from "@anywalletkit/swap2-assets";
import {describeAcrossActivity} from "./activity.js";
import {ACROSS_NATIVE, across as acrossCfg, acrossChain, acrossRouteOf} from "./config.js";
import {AcrossRefusal} from "./refusal.js";
import {acrossRpc, trackAcrossDeposit} from "./status.js";
import {ACROSS_MAX_FEE_BPS_LIMIT, acrossRequestOf, checkAcrossQuote, checkAcrossTxShape, parseAcrossIntentId, type AcrossRequest} from "./verify.js";

/**
 * Across Protocol — an intent bridge. ONE source transaction: `deposit(...)` on the source chain's SpokePool, whose
 * arguments name the recipient, the output token and amount, the destination chain and the fill deadline; a relayer
 * pays the recipient on the destination from its own funds, or the deposit is refunded to the depositor on the source
 * chain after the deadline.
 *
 *  - The deposit is built HERE (`build.ts`) from the pins and the user's request; a quote source only supplies the
 *    numbers (output amount, quote time, fill deadline, exclusivity), and `verify.ts` holds every argument to the
 *    request again at build time and right before signing. An ERC-20 input sets `approvalAddress` to the pinned
 *    SpokePool and the engine approves exactly the input amount.
 *  - EVM → EVM, exact input, the same asset on both sides (USDC, USDT / USDT0, ETH / WETH, WBTC), empty message only.
 *    Periphery calls (origin swaps, `depositNative`), CCTP / OFT routes, destination actions, speed-up signatures and
 *    integrator fees are refused by name.
 *  - Quoting arrives with the Across API V5 layer (a key from dashboard.across.to, server-side only). Until then the
 *    provider is disabled: `enabled()` is false and `getQuote` refuses (`quote-unavailable`, `policy_refused`).
 *  - Status is read on chain (`status.ts`): the deposit from the source receipt, its relay hash, the destination's
 *    `fillStatuses` — with an RPC URL per chain in `rpcUrls`. Display only, nothing is signed on its word.
 */

const EVM_PLACEHOLDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface AcrossProviderConfig {
  /**
   * JSON-RPC URLs per CAIP-2 chain, for status: the source chain's to read the deposit, the destination's to read its
   * fill. Without them a sent deposit stays "pending".
   */
  rpcUrls?: Readonly<Record<string, string>>;
  /** Fee cap in bps of the input that a deposit may leave to relayers (default 1000 = 10 %, at most 5000). */
  maxFeeBps?: number;
  /** Injectable for tests and for runtimes that bring their own. */
  fetchImpl?: typeof fetch;
}

export function acrossProvider(config: AcrossProviderConfig = {}): CrossChainProvider {
  config = Object.freeze({...config});
  const maxFeeBps = config.maxFeeBps;
  if (maxFeeBps !== undefined && (!Number.isInteger(maxFeeBps) || maxFeeBps < 0 || maxFeeBps > ACROSS_MAX_FEE_BPS_LIMIT)) {
    throw new Error(`across: maxFeeBps must be an integer between 0 and ${ACROSS_MAX_FEE_BPS_LIMIT}`);
  }
  const rpcUrls: Readonly<Record<string, string>> = Object.freeze(Object.assign(Object.create(null) as Record<string, string>, config.rpcUrls ?? {}));
  for (const [chain, url] of Object.entries(rpcUrls)) {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error(`across: the RPC URL for ${chain} must use http or https`);
  }
  const rpcFor = (caip2: string) => (Object.prototype.hasOwnProperty.call(rpcUrls, caip2) ? acrossRpc(rpcUrls[caip2]!, config.fetchImpl) : undefined);

  /**
   * The request a quote is checked against before a build or a signature: the one its `providerData` seals. (The
   * quoting layer will also keep the request each quote of this instance answered, as Relay's provider does, and
   * prefer it.)
   */
  function requestOf(quote: Quote): AcrossRequest {
    const pd = quote.providerData ?? {};
    const sealed: AcrossRequest = {
      sourceChain: pd.sourceChain ?? "", destChain: pd.destChain ?? "", sourceToken: pd.sourceToken ?? "", destToken: pd.destToken ?? "",
      amount: /^[1-9]\d{0,77}$/.test(pd.amount ?? "") ? BigInt(pd.amount!) : 0n,
      depositor: pd.depositor ?? "", recipient: pd.recipient ?? "",
      ...(/^\d{1,78}$/.test(pd.minAmountOut ?? "") ? {minAmountOut: BigInt(pd.minAmountOut!)} : {}),
      ...(maxFeeBps !== undefined ? {maxFeeBps} : {}),
    };
    // The pricing placeholder is never a party to a deposit, whatever flags the quote object carries.
    if (pd.placeholder === "1" || sealed.depositor.toLowerCase() === EVM_PLACEHOLDER.toLowerCase() || sealed.recipient.toLowerCase() === EVM_PLACEHOLDER.toLowerCase()) {
      throw new AcrossRefusal("request-invalid", "a quote priced without the real addresses is never built or signed — quote again with them", "policy_refused");
    }
    return sealed;
  }

  return {
    name: "across",
    describeActivity: describeAcrossActivity,
    // Dark until the quoting layer exists: nothing in this build can produce a quote to execute.
    enabled: () => false,
    supportsChain: (chain: string) => acrossCfg.supportsChain(chain),
    supportsChainPair: (from: string, to: string) => acrossCfg.supports(from, to),
    supportsRoute(from: Asset, to: Asset): boolean {
      if (!acrossCfg.supports(from.chain, to.chain)) return false;
      // The source is a catalog symbol (or a contract); the destination an address, zero for the native coin.
      let token: string;
      if (ADDRESS.test(from.token)) token = from.token;
      else {
        const asset = ccAsset(from.chain, from.token);
        if (!asset) return false;
        token = asset.contract ?? ACROSS_NATIVE;
      }
      return !("code" in acrossRouteOf(from.chain, token, to.chain, to.token));
    },

    async getQuote(params: QuoteParams): Promise<Quote | null> {
      const refuse = (reason: string, info?: Swap2RefusalInfo) => { params.onRefusal?.(reason, info); return null; };
      try {
        // The request is still read, so an unserved pair says why; a served one has no quote source in this build.
        acrossRequestOf(params, {
          ...(params.dry !== false ? {placeholder: EVM_PLACEHOLDER} : {}),
          ...(maxFeeBps !== undefined ? {maxFeeBps} : {}),
        });
      } catch (err) {
        if (err instanceof AcrossRefusal) return refuse(err.message, refusalOf(err));
        throw err;
      }
      const e = new AcrossRefusal("quote-unavailable", "quoting arrives with the Across API V5 layer — this build has no quote source", "policy_refused");
      return refuse(e.message, refusalOf(e));
    },

    /** The quote's own transaction — after the deposit it carries has been verified once more. */
    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const tx = quote.txRequest;
      if (!tx || !parseAcrossIntentId(quote.intentId)) throw refusal("policy_refused", "swap2: Across quote has no transaction request");
      const request = requestOf(quote);
      const v = checkAcrossQuote(request, quote);
      return {
        chain: request.sourceChain,
        to: v.deposit.to,
        value: v.deposit.value,
        data: v.deposit.data,
        chainId: v.deposit.chainId,
        ...(tx.gasLimit ? {gasLimit: tx.gasLimit} : {}),
        ...(v.deposit.approvalAddress ? {approvalAddress: v.deposit.approvalAddress} : {}),
      };
    },

    /** Right before signing: the whole verification again, against the request and the exact transaction about to be signed. */
    async preflightDeposit(quote: Quote, tx: UnsignedTx): Promise<void> {
      const request = requestOf(quote);
      if (tx.chain !== request.sourceChain) throw new AcrossRefusal("tx-chain", `the deposit is for ${tx.chain}, not ${request.sourceChain}`, "vault_mismatch");
      checkAcrossTxShape(tx);
      checkAcrossQuote(request, quote, tx);
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      const intent = parseAcrossIntentId(ref.intentId);
      if (!intent) return {state: "failed"};
      const source = acrossChain(`eip155:${intent.sourceChainId}`);
      const dest = acrossChain(`eip155:${intent.destChainId}`);
      if (!source || !dest || source === dest) return {state: "failed"};
      // Nothing was sent yet.
      if (!ref.sourceTxHash) return {state: "pending"};
      const sourceRpc = rpcFor(source.caip2);
      const destRpc = rpcFor(dest.caip2);
      const t = await trackAcrossDeposit({sourceTxHash: ref.sourceTxHash, source, dest, ...(sourceRpc ? {sourceRpc} : {}), ...(destRpc ? {destRpc} : {})});
      return t.status;
    },
  };
}
