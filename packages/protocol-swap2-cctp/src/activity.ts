/**
 * Activity recognition for Circle CCTP V2 on every domain in `config.ts`:
 * `depositForBurn` on TokenMessengerV2 is our source leg ("Bridged USDC"), and
 * `receiveMessage` on MessageTransmitterV2 is the claim that mints on the
 * destination ("Received USDC via CCTP") — whoever paid the gas, the USDC lands
 * on the `mintRecipient`. Both are `bridge`; the other leg's hash is only known
 * through the kit's journal / Circle's attestation API, so `related` stays empty.
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {chainLabel, describeSwapLike, matchesCall} from "@anywalletkit/protocol-swap2-core/activity";
import {CCTP_DOMAINS} from "./config.js";

export const CCTP_MODULE = "@anywalletkit/protocol-swap2-cctp";

/** depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32) — TokenMessengerV2 */
export const CCTP_DEPOSIT_FOR_BURN = "0x8e0250ee";
/** receiveMessage(bytes,bytes) — MessageTransmitterV2 */
export const CCTP_RECEIVE_MESSAGE = "0x57ecfd28";

export function describeCctpActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
  const domain = CCTP_DOMAINS[tx.chain];
  if (!domain) return null;
  const subtitle = `CCTP · ${chainLabel(tx.chain)}`;
  if (matchesCall(tx, [domain.tokenMessenger], [CCTP_DEPOSIT_FOR_BURN])) {
    return describeSwapLike(tx, ctx, {protocol: CCTP_MODULE, subtitle, kind: "bridge", title: "Bridged USDC"});
  }
  if (matchesCall(tx, [domain.messageTransmitter], [CCTP_RECEIVE_MESSAGE])) {
    return describeSwapLike(tx, ctx, {protocol: CCTP_MODULE, subtitle, kind: "bridge", title: "Received USDC via CCTP"});
  }
  return null;
}
