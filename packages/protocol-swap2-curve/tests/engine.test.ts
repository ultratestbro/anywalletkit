// The provider through the swap2 engine: what gets approved and signed. USDT on Ethereum resets its allowance to 0
// first (the engine's rule), the approval is exactly the input to the pinned router, and the router call the account
// sends is the quoted one, after preflight re-checked it on chain.
import {afterEach, describe, expect, it, vi} from "vitest";
import type {Swap2ExecutionPlan} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {CurveSwap2Protocol} from "../src/protocol.js";
import {D1, ME, RPC, TABLES, USDC, USDT, rpcStub} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

function account(log: {kind: string; to: string; data?: string | undefined; value?: unknown}[], over: Record<string, unknown> = {}) {
  let n = 0;
  return {
    getAddress: async () => ME,
    getChainId: async () => 1,
    getBalance: async () => 10n ** 30n,
    sendTransaction: async (tx: {to: string; data?: string; value?: unknown}) => {
      n += 1;
      const kind = tx.data?.startsWith("0x095ea7b3") ? (tx.data.endsWith("0".repeat(64)) ? "revoke" : "approve") : "swap";
      log.push({kind, to: tx.to, data: tx.data, value: tx.value});
      return {hash: `0x${n}`};
    },
    waitForTransaction: async () => {},
    ...over,
  };
}

describe("Curve through the swap2 engine", () => {
  it("USDT → USDC on Ethereum: reset to 0, exact approve to the router, then the quoted exchange", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const log: {kind: string; to: string; data?: string | undefined}[] = [];
    const plans: Swap2ExecutionPlan[] = [];
    const p = new CurveSwap2Protocol(account(log) as never, {fromChain: "eip155:1", rpcUrls: RPC, ...TABLES, onWarning: () => {}, reviewExecution: async (plan) => { plans.push(plan); }});
    await p.swap2({fromToken: "USDT", toToken: USDC, toChain: 1, recipient: ME, fromTokenAmount: 1_000_000n, minAmountOut: 990_000n});
    expect(log.map((l) => l.kind)).toEqual(["revoke", "approve", "swap"]);
    expect(log[0]!.to.toLowerCase()).toBe(USDT.toLowerCase());
    expect(log[1]!.data).toBe(`0x095ea7b3${D1.router.slice(2).toLowerCase().padStart(64, "0")}${(1_000_000n).toString(16).padStart(64, "0")}`);
    expect(log[2]!.to).toBe(D1.router);
    expect(log[2]!.data!.slice(0, 10)).toBe("0xc872a3c5");
    expect(plans[0]!.approvals.map((a) => [a.spender, a.amount])).toEqual([[D1.router, 0n], [D1.router, 1_000_000n]]);
  });

  it("native ETH in: no approval, value is exactly the input", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const log: {kind: string; to: string; data?: string | undefined; value?: unknown}[] = [];
    const p = new CurveSwap2Protocol(account(log) as never, {fromChain: "eip155:1", rpcUrls: RPC, ...TABLES, onWarning: () => {}});
    await p.swap2({fromToken: "ETH", toToken: USDT, toChain: 1, recipient: ME, fromTokenAmount: 10n ** 18n, minAmountOut: 1n});
    expect(log.map((l) => l.kind)).toEqual(["swap"]);
    expect(BigInt(log[0]!.value as bigint)).toBe(10n ** 18n);
  });
});
