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
 *    stored payload (`claimSwap2`);
 *  - `send(...)` on a Legacy Mesh OFT (Ethereum, Arbitrum, Celo) is a send
 *    into Tron / TON: "Bridged USDT0 → USDT", the destination named from the
 *    calldata's eid.
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {calledContract, chainLabel, describeSwapLike, matchesCall} from "@anywalletkit/protocol-swap2-core/activity";
import {decodeFunctionData, parseAbi, type Hex} from "viem";
import {USDT0_BY_EID, USDT0_CHAINS, type Usdt0Chain} from "./config.js";
import {USDT0_MESH_DESTINATION_BY_EID, meshSourceFor, type Usdt0MeshDestination} from "./mesh.js";

const SEND_ABI = parseAbi([
  "struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; }",
  "struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }",
  "function send(SendParam sp, MessagingFee fee, address refundAddress)",
]);

export const USDT0_MODULE = "@anywalletkit/protocol-swap2-usdt0";

/** send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address) — IOFT */
export const USDT0_SEND = "0xc7c7f5b3";
/** lzReceive((uint32,bytes32,uint64),address,bytes32,bytes,bytes) — EndpointV2 */
export const LZ_RECEIVE = "0x0c0c389e";

const ZERO = "0x0000000000000000000000000000000000000000";

/** The symbol the catalog uses on each deployment: USDT where the OFT wraps Tether's USDT, USDT0 elsewhere. */
function symbolFor(chain: Usdt0Chain): string {
  return chain.adapter || [42161, 10, 137].includes(chain.chainId) ? "USDT" : "USDT0";
}

/** `send(SendParam, …)` → the destination eid (the first word of the tuple), null when the calldata is absent or foreign. */
function sendDstEid(tx: ChainTx): number | null {
  const data = tx.call?.data;
  if (!data || data.length < 10 + 64 * 2) return null;
  try {
    const [sp] = decodeFunctionData({abi: SEND_ABI, data: data as Hex}).args as unknown as [{dstEid: number}];
    return sp.dstEid;
  } catch {
    return null;
  }
}
/** `send(SendParam, …)` → the destination deployment, null when the calldata is absent or foreign. */
function sendDestination(tx: ChainTx): Usdt0Chain | null {
  const eid = sendDstEid(tx);
  return eid === null ? null : USDT0_BY_EID[eid] ?? null;
}
/** A Legacy Mesh `send` → its Tron / TON destination, null when the calldata is absent or names another eid. */
function meshDestination(tx: ChainTx): Usdt0MeshDestination | null {
  const eid = sendDstEid(tx);
  return eid !== null && Object.prototype.hasOwnProperty.call(USDT0_MESH_DESTINATION_BY_EID, eid) ? USDT0_MESH_DESTINATION_BY_EID[eid]! : null;
}
const lc = (a: string) => a.toLowerCase();

export function describeUsdt0Activity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
  const mesh = meshSourceFor(tx.chain);
  if (mesh && matchesCall(tx, [mesh.oft], [USDT0_SEND])) {
    // As for an OFT send: the native value is the LayerZero fee (plus the refunded headroom), not a swapped asset.
    const item = describeSwapLike(tx, ctx, {protocol: USDT0_MODULE, subtitle: `USDT0 Legacy Mesh · ${chainLabel(tx.chain)}`, kind: "bridge", outVerb: "Bridged"});
    if (!item) return null;
    const native = item.assetsOut.filter((a) => a.token === null).reduce((sum, a) => sum + a.amount, 0n);
    item.assetsOut = item.assetsOut.filter((a) => a.token !== null);
    if (native > 0n) item.fee = (item.fee ?? 0n) + native;
    const srcSym = item.assetsOut[0]?.symbol ?? (mesh.chainId === 42161 ? "USDT0" : "USDT");
    const dst = meshDestination(tx);
    if (dst) {
      item.title = `Bridged ${srcSym} → USDT`;
      item.subtitle = `USDT0 Legacy Mesh · ${chainLabel(tx.chain)} → ${dst.name}`;
    } else item.title = `Bridged ${srcSym}`;
    return item;
  }
  const chain = USDT0_CHAINS[tx.chain];
  if (!chain) return null;
  const subtitle = `USDT0 · ${chainLabel(tx.chain)}`;
  if (matchesCall(tx, [chain.oft], [USDT0_SEND])) {
    // The native value is the LayerZero messaging fee (plus the headroom the
    // endpoint refunds), not an asset the owner swapped away: it rides in `fee`
    // next to the gas, and the title names both ends when the calldata says
    // where the tokens go.
    const dst = sendDestination(tx);
    const item = describeSwapLike(tx, ctx, {protocol: USDT0_MODULE, subtitle, kind: "bridge", outVerb: "Bridged"});
    if (!item) return null;
    const native = item.assetsOut.filter((a) => a.token === null).reduce((sum, a) => sum + a.amount, 0n);
    item.assetsOut = item.assetsOut.filter((a) => a.token !== null);
    if (native > 0n) item.fee = (item.fee ?? 0n) + native;
    const srcSym = item.assetsOut[0]?.symbol ?? symbolFor(chain);
    if (dst) {
      item.title = `Bridged ${srcSym} → ${symbolFor(dst)}`;
      item.subtitle = `USDT0 · ${chainLabel(tx.chain)} → ${dst.name}`;
    } else item.title = `Bridged ${srcSym}`;
    return item;
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
