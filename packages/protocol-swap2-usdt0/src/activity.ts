/**
 * Activity recognition for USDT0 on every chain in `config.ts`:
 *  - `send(...)` on the chain's OFT is our source leg ("Bridged USDT0", or
 *    "Bridged USDT" on Ethereum where the adapter locks plain USDT);
 *  - the inbound leg is the executor's delivery — the user signs nothing, so
 *    it is recognized by its effect: the chain's USDT0 minted to the owner
 *    (from the zero address), or USDT released by the Ethereum adapter to the
 *    owner, inside a transaction that did NOT call the token itself (a plain
 *    transfer is not a bridge);
 *  - `lzReceive` on the LayerZero endpoint is the owner's own retry of a
 *    stored payload (`claimSwap2`).
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@forgewallet/core";
import {calledContract, chainLabel, describeSwapLike, matchesCall} from "@forgewallet/protocol-swap2-core/activity";
import {USDT0_CHAINS} from "./config.js";

export const USDT0_MODULE = "@forgewallet/protocol-swap2-usdt0";

/** send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address) — IOFT */
export const USDT0_SEND = "0xc7c7f5b3";
/** lzReceive((uint32,bytes32,uint64),address,bytes32,bytes,bytes) — EndpointV2 */
export const LZ_RECEIVE = "0x0c0c389e";

const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (a: string) => a.toLowerCase();

export function describeUsdt0Activity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
  const chain = USDT0_CHAINS[tx.chain];
  if (!chain) return null;
  const subtitle = `USDT0 · ${chainLabel(tx.chain)}`;
  if (matchesCall(tx, [chain.oft], [USDT0_SEND])) {
    return describeSwapLike(tx, ctx, {protocol: USDT0_MODULE, subtitle, kind: "bridge", outVerb: "Bridged"});
  }
  if (matchesCall(tx, [chain.endpoint], [LZ_RECEIVE])) {
    return describeSwapLike(tx, ctx, {protocol: USDT0_MODULE, subtitle, kind: "bridge", inSuffix: "via LayerZero"});
  }
  // Delivery by the LayerZero executor: the token moves out of nowhere (mint)
  // or out of the adapter into the owner, and the call target is not the token.
  const called = calledContract(tx);
  if (called && called === lc(chain.token)) return null;
  const own = new Set([...ctx.own].map(lc));
  const origin = chain.adapter ? lc(chain.oft) : ZERO;
  const delivered = tx.transfers.some((t) => t.token !== null && lc(t.token) === lc(chain.token) && lc(t.from) === origin && own.has(lc(t.to)));
  if (!delivered || own.has(lc(tx.from))) return null;
  return describeSwapLike(tx, ctx, {protocol: USDT0_MODULE, subtitle, kind: "bridge", inSuffix: "via LayerZero", counterparty: chain.oft});
}
