/**
 * Activity recognition for 0x: a `Settler.execute` call to a 0x Settler on a chain the module serves
 * → `swap`, "Swapped A → B" from the owner's net transfers.
 *
 * 0x replaces its Settler contracts regularly (the registry names the one in force), so past swaps
 * were sent to addresses no pinned list can hold. Every Settler, past or present, is however an
 * address the registry deploys to (CREATE3, see `zeroExSettlerNonce`), which is computed offline: a
 * transaction is recognized by its target being one, by the method (`execute`, selector `0x1fff991f`)
 * and, when its calldata is there, by that calldata reading as a Settler call. A contract that only
 * copies the selector is not labelled a 0x swap. This only labels history; nothing is signed on it.
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {callSelector, chainLabel, describeSwapLike} from "@anywalletkit/protocol-swap2-core/activity";
import {ZEROEX_CHAINS, ZEROEX_SETTLER_NONCE_MARGIN, zeroExChain, zeroExChainId} from "./chains.js";
import {SETTLER_EXECUTE_SELECTOR, decodeSettlerExecute, zeroExSettlerNonce} from "./settler.js";

export const ZEROEX_MODULE = "@anywalletkit/protocol-swap2-0x";

export function describeZeroExActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
  const chainId = zeroExChainId(tx.chain);
  const chain = zeroExChain(ZEROEX_CHAINS, chainId);
  if (!chain) return null;
  if (callSelector(tx) !== SETTLER_EXECUTE_SELECTOR) return null;
  const target = tx.call?.to ?? tx.to;
  // Any deployment up to the newest one the chain accepts (past swaps went to older Settlers too); bounded by the pin,
  // an address that is no Settler costs a few dozen derivations.
  if (typeof target !== "string" || zeroExSettlerNonce(chainId, target, chain.registry, chain.newestLiveNonce + ZEROEX_SETTLER_NONCE_MARGIN) === null) return null;
  const data = tx.call?.data;
  if (typeof data === "string" && data.length > 10) {
    try {
      decodeSettlerExecute(data);
    } catch {
      return null;
    }
  }
  return describeSwapLike(tx, ctx, {protocol: ZEROEX_MODULE, subtitle: `0x · ${chainLabel(tx.chain)}`, kind: "swap"});
}
