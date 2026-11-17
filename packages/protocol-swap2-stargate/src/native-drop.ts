import {pad, parseEventLogs, type Hex, type TransactionReceipt} from "viem";
import {EXECUTOR_ABI} from "./abi.js";
import {sameAddress} from "./rpc.js";
import type {StargateTaxiProof} from "./tracking.js";

/** Reviewed Base executor; metadata never changes these pins at runtime. See recovery fixtures. */
export const STARGATE_TAXI_EXECUTORS: Readonly<Record<string, readonly Hex[]>> = Object.freeze({
  "eip155:8453": Object.freeze(["0x2cca08ae69e0c44b18a57ab2a87644234daebae4" as Hex]),
});

/** An executor drop can succeed even if lzReceive fails, or run in a separate transaction. */
export function stargateTaxiNativeDrop(p: StargateTaxiProof, receipt: TransactionReceipt, executors: readonly Hex[]): boolean {
  if (receipt.status !== "success" || p.intent.nativeDrop <= 0n) return false;
  const i = p.intent;
  const events = parseEventLogs({abi: EXECUTOR_ABI, eventName: "NativeDropApplied", logs: receipt.logs.filter((l) => executors.some((a) => sameAddress(a, l.address))), strict: true});
  for (const {args} of events) {
    if (args.origin.srcEid !== i.source.eid || args.origin.nonce !== p.nonce || !sameAddress(args.origin.sender, pad(i.source.tokenMessaging, {size: 32})) || args.dstEid !== i.destination.eid || !sameAddress(args.oapp, i.destination.tokenMessaging) || args.params.length !== args.success.length) continue;
    let received = 0n;
    for (let index = 0; index < args.params.length; index++) {
      const drop = args.params[index]!;
      if (args.success[index] && sameAddress(drop.receiver, i.recipient)) received += drop.amount;
    }
    if (received >= i.nativeDrop) return true;
  }
  return false;
}
