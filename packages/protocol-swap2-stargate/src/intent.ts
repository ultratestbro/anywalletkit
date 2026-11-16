import {getAddress, zeroAddress, type Address} from "viem";
import {ccAsset, ccAssetByToken} from "@anywalletkit/swap2-assets";
import {destinationAmount, sourceMinimum, splitSourceAmount} from "./amounts.js";
import type {StargateMode, StargateQuote} from "./quote.js";
import type {StargateDeployment, StargateRegistry} from "./registry.js";
import {assertStargate, nonzeroAddress} from "./rpc.js";

export interface StargateIntent {
  source: StargateDeployment;
  destination: StargateDeployment;
  mode: StargateMode;
  sender: Address;
  recipient: Address;
  amount: bigint;
  minimum: bigint;
  nativeDrop: bigint;
}

/** Resolve catalog identity first: USDC.e/USDT0 must never alias a different contract. */
export function stargateToken(chain: string, token: string): string | undefined {
  if (/^0x[0-9a-fA-F]{40}$/.test(token)) return token;
  const asset = ccAsset(chain, token) ?? ccAssetByToken(chain, token);
  return asset ? asset.contract ?? zeroAddress : undefined;
}

/** Self-contained tracking identity survives app restarts and remote server intent sealing. */
export function stargateIntent(q: StargateQuote): string {
  return ["stargate", "1", q.source.eid, q.destination.eid, q.source.assetId, q.mode, q.sender.toLowerCase(), q.recipient.toLowerCase(), q.requestedAmount, q.minimumDestinationAmount, q.nativeDrop].join(":");
}

export function parseStargateIntent(id: string, registry: StargateRegistry): StargateIntent {
  // The swap2 server appends its authenticated envelope after '~'. It does not change route identity.
  const fields = id.split("~", 1)[0]!.split(":");
  const [tag, version, srcEid, dstEid, assetId, mode, sender, recipient, amountText, minText, dropText] = fields;
  assertStargate(fields.length === 11 && tag === "stargate" && version === "1" && (mode === "taxi" || mode === "bus"), "invalid intent identity");
  assertStargate([srcEid, dstEid, assetId, amountText, minText, dropText].every((v) => typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v)), "invalid intent amounts");
  assertStargate(sender && recipient && nonzeroAddress(sender) && nonzeroAddress(recipient), "invalid intent actors");
  const source = registry.deployments.find((d) => String(d.eid) === srcEid && String(d.assetId) === assetId);
  const destination = registry.deployments.find((d) => String(d.eid) === dstEid && String(d.assetId) === assetId);
  assertStargate(source && destination && registry.route(source.chain, source.token, destination.chain, destination.token), "unreviewed intent route");
  const amount = BigInt(amountText!), minimum = BigInt(minText!), nativeDrop = BigInt(dropText!);
  assertStargate(splitSourceAmount(amount, source.localDecimals, source.sharedDecimals).amountSD > 0n && minimum > 0n && nativeDrop < (1n << 128n), "invalid intent bounds");
  assertStargate(destinationAmount(sourceMinimum(minimum, source.localDecimals, destination.localDecimals, source.sharedDecimals), source.localDecimals, destination.localDecimals, source.sharedDecimals) === minimum, "unaligned intent minimum");
  return {source, destination, mode, sender: getAddress(sender), recipient: getAddress(recipient), amount, minimum, nativeDrop};
}
