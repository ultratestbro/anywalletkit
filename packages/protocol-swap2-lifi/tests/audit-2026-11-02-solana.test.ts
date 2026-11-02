// A LI.FI Solana → EVM bridge: the API's metadata (action.toAddress) said the user's recipient, but nothing read the
// bytes the wallet signs for it, and the engine asked the account only for a SOL-out ceiling. Now the engine hands the
// account `bridgeOut` {destChain, recipient, …} to prove, which it does for Mayan's orders (the other Solana bridges
// and the provider's own checks: audit-2026-11-02-r3-solana-bridges.test.ts).
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {LifiSwap2Protocol} from "../src/protocol.js";

afterEach(() => vi.unstubAllGlobals());

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RECIPIENT = "0x3333333333333333333333333333333333333333";

type Live = {name: string; params: QuoteParams; response: {tool?: string; transactionRequest?: {data?: string}}};
const live = (JSON.parse(readFileSync(new URL("./fixtures-live-2026-11-02.json", import.meta.url), "utf8")) as {corridors: Live[]}).corridors
  .filter((c) => c.params.sourceChain === "solana:mainnet");

function account(sender: string, seen: {wire: string; expect: unknown}[]) {
  return {
    chain: "solana:mainnet",
    getAddress: async () => sender,
    getBalance: async () => 10_000_000_000n,
    sendTransaction: async () => { throw new Error("must not send a plain tx"); },
    transfer: async () => { throw new Error("must not transfer"); },
    sendSerializedTransaction: async (wire: string, expect: unknown) => { seen.push({wire, expect}); return {hash: "5".repeat(87)}; },
  };
}

describe("audit 2026-11-02: a LI.FI bridge out of Solana is bound to the reviewed recipient", () => {
  it("a live Mayan route reaches the account with the destination chain and the recipient to prove", async () => {
    const c = live.find((k) => k.name === "w-sol-base-usdc-mayan")!;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(c.response)));
    const seen: {wire: string; expect: unknown}[] = [];
    const p = new LifiSwap2Protocol(account(c.params.refundAddress!, seen) as never, {fromChain: "solana:mainnet"});
    await p.swap2({fromToken: "SOL", toToken: BASE_USDC, toChain: "eip155:8453", recipient: RECIPIENT, fromTokenAmount: BigInt(c.params.amountIn), minAmountOut: 1n});
    expect(seen).toHaveLength(1);
    expect(seen[0]!.wire).toBe(c.response.transactionRequest!.data);
    expect(seen[0]!.expect).toEqual({maxValueOut: (BigInt(c.params.amountIn) + 20_000_000n).toString(), bridgeOut: {destChain: "eip155:8453", recipient: RECIPIENT, destToken: BASE_USDC, minAmountOut: "46516587", destDecimals: 6}});
  });
});
