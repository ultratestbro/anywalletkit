import {activityBase, type ActivityAsset, type ActivityItem, type ChainTx, type DescribeActivityContext} from "@anywalletkit/core";
import {chainLabel} from "@anywalletkit/protocol-swap2-core/activity";
import {decodeFunctionData, parseEventLogs, type Hex, type TransactionReceipt} from "viem";
import {STARGATE_ABI, TOKEN_MESSAGING_ABI} from "./abi.js";
import {stargateRegistry} from "./deployments.js";
import type {StargateDeployment, StargateRegistry} from "./registry.js";
import {checkStargateReceipt} from "./tracking.js";
import {sameAddress} from "./rpc.js";

export const STARGATE_MODULE = "@anywalletkit/protocol-swap2-stargate";
const obj = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
/** history-evm RPC/Alchemy enrichment stores the original receipt in raw.tx.receipt. */
function historyReceipt(tx: ChainTx): TransactionReceipt | null {
  try {
    const r = obj(obj(obj(tx.raw)?.tx)?.receipt);
    if (!r || tx.status !== "confirmed" || (r.status !== "0x1" && r.status !== "success") || !Array.isArray(r.logs) || r.logs.length > 10_000 || typeof r.blockHash !== "string") return null;
    const blockNumber = BigInt(String(r.blockNumber));
    if (tx.block !== undefined && tx.block !== blockNumber) return null;
    const logs = r.logs.map((value) => {
      const l = obj(value)!;
      const logIndex = typeof l.logIndex === "number" ? l.logIndex : typeof l.logIndex === "string" && /^0x[0-9a-f]+$/i.test(l.logIndex) ? parseInt(l.logIndex, 16) : -1;
      if (!Number.isSafeInteger(logIndex) || logIndex < 0 || l.removed !== false || typeof l.address !== "string" || !/^0x[0-9a-f]{40}$/i.test(l.address) || typeof l.data !== "string" || !Array.isArray(l.topics)) throw new Error("invalid log");
      return {...l, blockNumber: BigInt(String(l.blockNumber)), logIndex};
    });
    const receipt = {...r, status: "success", blockNumber, logs} as unknown as TransactionReceipt;
    checkStargateReceipt(receipt, tx.hash as Hex, r.blockHash as Hex);
    return receipt;
  } catch { return null; }
}
function add(assets: ActivityAsset[], deployment: StargateDeployment, amount: bigint) {
  if (amount <= 0n) return;
  const token = deployment.kind === "native" ? null : deployment.token;
  const existing = assets.find((a) => a.token === token);
  if (existing) existing.amount += amount;
  else assets.push({token, amount, symbol: deployment.symbol, decimals: deployment.localDecimals});
}

/** Local bridge legs only: this hook never declares that the cross-chain intent completed. */
export function describeStargateActivity(tx: ChainTx, ctx: DescribeActivityContext, registry: StargateRegistry = stargateRegistry): ActivityItem | null {
  try {
    const deployments = registry.deployments.filter((d) => d.chain === tx.chain);
    if (!deployments.length) return null;
    const own = new Set([...ctx.own].map((a) => a.toLowerCase()));
    const receipt = historyReceipt(tx);
    const subtitle = `Stargate · ${chainLabel(tx.chain)}`;
    if (receipt) {
      const assetsIn: ActivityAsset[] = [], assetsOut: ActivityAsset[] = [];
      let bus = false;
      for (const d of deployments) {
        const events = parseEventLogs({abi: STARGATE_ABI, logs: receipt.logs.filter((l) => sameAddress(l.address, d.address)), strict: true});
        for (const event of events) {
          if (event.eventName === "OFTSent" && own.has(event.args.fromAddress.toLowerCase())) {
            add(assetsOut, d, event.args.amountSentLD);
            if (/^0x0{64}$/.test(event.args.guid)) bus = true;
          } else if (event.eventName === "OFTReceived" && own.has(event.args.toAddress.toLowerCase())) add(assetsIn, d, event.args.amountReceivedLD);
        }
      }
      if (assetsOut.length || assetsIn.length) {
        const item = activityBase(tx, "bridge", assetsOut.length ? `${bus ? "Queued" : "Bridged"} ${assetsOut.map((a) => a.symbol).join(", ")}${bus ? " via Stargate Bus" : ""}` : `Received ${assetsIn.map((a) => a.symbol).join(", ")} via Stargate`, {protocol: STARGATE_MODULE, subtitle, assetsIn, assetsOut});
        if (!own.has(tx.from.toLowerCase())) delete item.fee;
        return item;
      }
      if (own.has(tx.from.toLowerCase()) && tx.to && deployments.some((d) => sameAddress(d.tokenMessaging, tx.to!))) {
        const driven = parseEventLogs({abi: TOKEN_MESSAGING_ABI, eventName: "BusDriven", logs: receipt.logs.filter((l) => sameAddress(l.address, tx.to!)), strict: true});
        if (driven.length) return activityBase(tx, "bridge", "Advanced Stargate Bus", {protocol: STARGATE_MODULE, subtitle, ...(tx.fee === undefined ? {} : {fee: tx.fee + tx.nativeValue})});
      }
      return null;
    }
    // Pending/failed direct calls are recognizable without inventing a successful payout.
    if (tx.status === "confirmed" || !own.has(tx.from.toLowerCase()) || !tx.to || !tx.call?.data) return null;
    const d = deployments.find((d) => sameAddress(d.address, tx.to!));
    if (!d) return null;
    const decoded = decodeFunctionData({abi: STARGATE_ABI, data: tx.call.data as Hex});
    if (decoded.functionName !== "sendToken") return null;
    return activityBase(tx, "bridge", tx.status === "failed" ? "Failed Stargate transfer" : "Pending Stargate transfer", {protocol: STARGATE_MODULE, subtitle});
  } catch { return null; }
}
