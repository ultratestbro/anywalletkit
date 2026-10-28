// Scan 2026-10-27 (modules), F9: behind `remoteProvider` the Fynd router pin and checkFyndTransaction ran only on the
// server, and the client trusted the addresses the server sent. With `fyndPins` the app checks a remote quote against
// FYND_CHAINS and re-runs checkFyndTransaction against its own request. A fake backend, no network, no keys.
import {describe, expect, it} from "vitest";
import {encodeFunctionData} from "viem";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {FYND_CHAINS, TYCHO_ROUTER_ABI, fyndPins, fyndVerifyQuote} from "../src/router.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const USER = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const ROUTER = FYND_CHAINS[8453]!.router;
const NO_FEE = {clientFeeBps: 0, clientFeeReceiver: ZERO, maxClientContribution: 0n, deadline: 0n, clientSignature: "0x"} as const;
const GROSS = 250_000_000_000_000n, MIN = 248_750_000_000_000n;
const single = (receiver = USER) => encodeFunctionData({abi: TYCHO_ROUTER_ABI, functionName: "singleSwap", args: [1_000_000n, USDC, WETH, GROSS, MIN, receiver as `0x${string}`, NO_FEE as never, "0xdeadbeef"]});

const quoteFor = (params: QuoteParams, tx: {to: string; data: string}): Quote => ({
  provider: "fynd", intentId: "fynd:8453", depositAddress: "", depositMemo: null,
  txRequest: {to: tx.to, data: tx.data, value: "0", chainId: 8453, gasLimit: "300000", approvalAddress: tx.to},
  sourceAmount: params.amountIn, destAmount: (GROSS - 1000n).toString(), minDestAmount: MIN.toString(), feeUsd: 0, etaSeconds: 15, reliability: 0.96,
  validUntilMs: Date.now() + 30_000, providerData: {gross: GROSS.toString(), routerFee: "1000", minOut: MIN.toString(), sender: USER},
} as Quote);

/** A remote Fynd stub whose backend answers with `tx`, wired the way the README says: `...fyndPins`. */
function stub(tx: {to: string; data: string}, pins = true): CrossChainProvider {
  const fetchImpl = (async (url: string, init: {body: string}) => {
    const action = String(url).split("/").at(-1);
    const body = JSON.parse(init.body) as {params?: QuoteParams; quote?: Quote};
    const reply = (v: unknown) => new Response(JSON.stringify(v), {status: 200, headers: {"content-type": "application/json"}});
    if (action === "quote") return reply(quoteFor(body.params!, tx));
    if (action === "build") { const {nativeFee: _fee, ...t} = body.quote!.txRequest!; const tx: UnsignedTx = {...t, chain: "eip155:8453", to: t.to!, value: t.value ?? "0"}; return reply(tx); }
    return reply({});
  }) as unknown as typeof fetch;
  return remoteProvider({name: "fynd", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, supportsSameChain: true, ...(pins ? fyndPins : {})});
}
function engine(provider: CrossChainProvider) {
  const sent: unknown[] = [];
  const account = {getAddress: async () => USER, getChainId: async () => 8453, getAllowance: async () => 0n, waitForTransaction: async () => {}, sendTransaction: async (t: unknown) => { sent.push(t); return {hash: `0x${sent.length}`}; }};
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  return {sent, p: new P(account as never, {fromChain: "eip155:8453"} as never)};
}
const options = {fromToken: "USDC", toToken: WETH, toChain: 8453, recipient: USER, fromTokenAmount: 1_000_000n, minAmountOut: MIN};

describe("Fynd behind remoteProvider (scan 2026-10-27 modules, F9)", () => {
  it("a remote quote whose router is not the one in FYND_CHAINS is refused; nothing is approved", async () => {
    const {sent, p} = engine(stub({to: ATTACKER, data: single()}));
    await expect(p.swap2(options)).rejects.toThrow(/did not pin as a spender|not the Tycho router/);
    expect(sent).toHaveLength(0);
  });

  it("the pinned router with calldata paying someone else is refused by checkFyndTransaction on the client", async () => {
    const {sent, p} = engine(stub({to: ROUTER, data: single(ATTACKER)}));
    await expect(p.swap2(options)).rejects.toThrow(/fails this app's own check — calldata pays 0x9999/);
    expect(sent).toHaveLength(0);
  });

  it("an honest remote quote passes and executes: approve the pinned router for the input, then the swap", async () => {
    const {sent, p} = engine(stub({to: ROUTER, data: single()}));
    await p.swap2(options);
    expect((sent as Array<{to: string}>).map((t) => t.to.toLowerCase())).toEqual([USDC.toLowerCase(), ROUTER.toLowerCase()]);
  });

  it("without the pins, the remote stub gets no route at all (fail closed)", async () => {
    const {sent, p} = engine(stub({to: ROUTER, data: single()}, false));
    await expect(p.swap2(options)).rejects.toThrow(/did not pin/);
    expect(sent).toHaveLength(0);
  });

  it("fyndPins pin the router per chain and nothing elsewhere; fyndVerifyQuote names what is wrong", () => {
    expect(fyndPins.callTargets("eip155:8453")).toEqual([ROUTER]);
    expect(fyndPins.spenders("eip155:1")).toEqual([FYND_CHAINS[1]!.router]);
    expect(fyndPins.callTargets("eip155:10")).toEqual([]);
    expect(fyndPins.callTargets("solana:mainnet")).toEqual([]);
    const params = {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:8453", destToken: WETH, amountIn: "1000000", destAddress: USER, dry: false} as QuoteParams;
    expect(fyndVerifyQuote(params, quoteFor(params, {to: ROUTER, data: single()}))).toBeNull();
    expect(fyndVerifyQuote({...params, amountIn: "2000000"}, quoteFor(params, {to: ROUTER, data: single()}))).toMatch(/spends 1000000, not 2000000/);
  });
});
