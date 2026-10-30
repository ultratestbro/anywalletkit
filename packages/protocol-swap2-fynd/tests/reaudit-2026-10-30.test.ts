// Reaudit 2026-10-30, #3: fyndVerifyQuote picked the router from the source chain and never compared the
// destination chain, so a valid Base swap to native ETH passed for a Base → Unichain request. It now refuses a
// cross-chain request, as the local provider does.
import {describe, expect, it} from "vitest";
import {encodeFunctionData} from "viem";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {FYND_CHAINS, ROUTER_NATIVE, TYCHO_ROUTER_ABI, fyndVerifyQuote} from "../src/router.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USER = "0x1111111111111111111111111111111111111111";
const ROUTER = FYND_CHAINS[8453]!.router;
const NO_FEE = {clientFeeBps: 0, clientFeeReceiver: ZERO, maxClientContribution: 0n, deadline: 0n, clientSignature: "0x"} as const;
const GROSS = 250_000_000_000_000n, MIN = 248_750_000_000_000n;
const data = encodeFunctionData({abi: TYCHO_ROUTER_ABI, functionName: "singleSwap", args: [1_000_000n, USDC, ROUTER_NATIVE as `0x${string}`, GROSS, MIN, USER, NO_FEE as never, "0xdeadbeef"]});
const quote = {provider: "fynd", intentId: "fynd:8453", depositAddress: "", depositMemo: null,
  txRequest: {to: ROUTER, data, value: "0", chainId: 8453, gasLimit: "300000", approvalAddress: ROUTER},
  sourceAmount: "1000000", destAmount: GROSS.toString(), minDestAmount: MIN.toString(), feeUsd: 0, etaSeconds: 15, reliability: 0.9,
  validUntilMs: Date.now() + 30_000, providerData: {gross: GROSS.toString()}} as unknown as Quote;
const params = (destChain: string) => ({sourceChain: "eip155:8453", sourceToken: "USDC", destChain, destToken: ZERO, amountIn: "1000000", destAddress: USER, dry: false} as QuoteParams);

describe("reaudit 2026-10-30 #3: fyndVerifyQuote is same-chain only", () => {
  it("a Base swap to native ETH is refused for a Base → Unichain request", () => {
    expect(fyndVerifyQuote(params("eip155:130"), quote)).toBe("same-chain swaps only");
  });
  it("the same quote for a Base → Base request passes", () => {
    expect(fyndVerifyQuote(params("eip155:8453"), quote)).toBeNull();
  });
});
